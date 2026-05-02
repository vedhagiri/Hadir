#!/usr/bin/env bash
#
# deploy-update.sh — apply a Maugood release zip to a live install.
#
# Usage:
#   ./scripts/deploy-update.sh --zip /path/to/maugood-vX.Y.Z.zip
#   ./scripts/deploy-update.sh --zip ./maugood-v1.2.0.zip --install-dir /opt/maugood
#   ./scripts/deploy-update.sh --zip ./bundle.zip --no-rebuild
#   ./scripts/deploy-update.sh --zip ./bundle.zip --dry-run
#   ./scripts/deploy-update.sh --backup-only --install-dir /opt/maugood
#
# Flags:
#   --zip <path>            Required (unless --backup-only). The release zip
#                           produced by ``scripts/package-release.sh``.
#   --install-dir <path>    Where the live install lives. Defaults to the
#                           script's parent directory (i.e. "this repo").
#   --no-rebuild            Skip ``docker compose up --build``. Use only for
#                           code-only changes that don't touch any image
#                           layer (rare; default rebuilds because Docker is
#                           cheap and a missed rebuild is a debugging trap).
#   --dry-run               Print every step that would run, write nothing.
#   --backup-only           Dump operator-state (env + certs + branding) to
#                           a timestamped tarball, then exit. No code change.
#   --skip-stop             Don't ``docker compose down`` first. The
#                           extraction step rsync-mirrors the new code while
#                           the stack is still running; backend hot-reload
#                           on the next request. Use only when the change
#                           is frontend-only (the backend image needs a
#                           restart to pick up Python changes).
#   --yes                   Don't prompt for confirmation. For automation.
#
# What it does, in order:
#
#   1. Validates the zip path + install dir.
#   2. Snapshots operator-state into ``backups/<timestamp>/`` BEFORE
#      doing anything destructive: ``.env``, ``ops/certs/``,
#      ``frontend/src/assets/`` (per-client logos), and ``data/`` symlink
#      pointer (the volume itself is preserved by Docker; we just record
#      where it pointed). This is the recovery seed if the update breaks.
#   3. Stops the running stack (unless --skip-stop).
#   4. Extracts the zip to a temp dir, then ``rsync -a --delete`` mirrors
#      the new code into the install dir — except for paths the operator
#      owns: ``.env``, ``backend/.env``, ``frontend/.env``, ``ops/certs/``,
#      ``backend/logs/``, ``backups/``, ``dist/``, every ``data/`` mount,
#      ``frontend/node_modules/``, ``frontend/dist/``. Source-side updates
#      land; operator-state stays.
#   5. Brings the stack back up with ``--build`` (unless --no-rebuild).
#      The backend's entrypoint runs Alembic migrations on boot — every
#      tenant schema upgrades to the new revision automatically.
#   6. Polls ``/api/health`` for up to 90s and prints the verdict.
#
# Recovery: every run leaves a tarball under
# ``backups/<timestamp>-pre-update.tar.gz`` with the prior operator-state.
# To roll back code: ``git checkout <prev-tag>`` (or extract the previous
# release zip on top), then untar the backup.
#
# Idempotent: running with the same zip twice is harmless. The rsync is
# content-aware; a second pass copies nothing new.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_INSTALL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ZIP_PATH=""
INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
DO_REBUILD=1
DO_STOP=1
DRY_RUN=0
BACKUP_ONLY=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip)            ZIP_PATH="$2"; shift 2 ;;
        --install-dir)    INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
        --no-rebuild)     DO_REBUILD=0; shift ;;
        --skip-stop)      DO_STOP=0; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --backup-only)    BACKUP_ONLY=1; shift ;;
        --yes|-y)         ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '3,55p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if [[ ${BACKUP_ONLY} -eq 0 && -z "${ZIP_PATH}" ]]; then
    echo "error: --zip is required (or pass --backup-only)" >&2
    exit 2
fi

if [[ -n "${ZIP_PATH}" && ! -f "${ZIP_PATH}" ]]; then
    echo "error: zip not found at '${ZIP_PATH}'" >&2
    exit 1
fi

if [[ ! -d "${INSTALL_DIR}" ]]; then
    echo "error: install dir not found at '${INSTALL_DIR}'" >&2
    exit 1
fi

if [[ ! -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    echo "error: '${INSTALL_DIR}' doesn't look like a Maugood install" >&2
    echo "       (no docker-compose.yml found)" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Detect which compose file is actually running so down/up target the
# right stack. Customer installs run docker-compose-https-local.yaml
# (HTTPS via nginx + self-signed cert) — without ``-f`` docker would
# silently default to docker-compose.yml (the dev stack) and the live
# HTTPS containers would never be rebuilt. The script then prints a
# successful "update applied" while the running images stay stale.
# ---------------------------------------------------------------------------

COMPOSE_FILE_REL="docker-compose.yml"
# Prefer whichever compose file currently has containers running. If
# both are dormant fall back to the file that exists; if both exist
# default to the HTTPS-local one (production-like deploy is the more
# common case for this script).
if command -v docker >/dev/null 2>&1; then
    if [[ -f "${INSTALL_DIR}/docker-compose-https-local.yaml" ]]; then
        running_https="$(
            docker compose -f "${INSTALL_DIR}/docker-compose-https-local.yaml" \
                ps -q 2>/dev/null | wc -l | tr -d ' '
        )"
        running_default="$(
            docker compose -f "${INSTALL_DIR}/docker-compose.yml" \
                ps -q 2>/dev/null | wc -l | tr -d ' '
        )"
        if [[ "${running_https:-0}" -gt 0 ]]; then
            COMPOSE_FILE_REL="docker-compose-https-local.yaml"
        elif [[ "${running_default:-0}" -gt 0 ]]; then
            COMPOSE_FILE_REL="docker-compose.yml"
        else
            # Nothing running — pick the prod-style file by default
            # since this script's day-job is updating customer installs.
            COMPOSE_FILE_REL="docker-compose-https-local.yaml"
        fi
    fi
fi
COMPOSE_FILE_PATH="${INSTALL_DIR}/${COMPOSE_FILE_REL}"

# ---------------------------------------------------------------------------
# Resolve the new release version from the zip's top-level dir name
# ---------------------------------------------------------------------------

NEW_VERSION=""
if [[ -n "${ZIP_PATH}" ]]; then
    # The packaging script names the zip's prefix ``maugood-v<X.Y.Z>/``
    # and that's also what unzip -l reports first. Extract it via the
    # filename to avoid spawning unzip just for the version.
    NEW_VERSION="$(basename "${ZIP_PATH}" .zip | sed -n 's|^maugood-\(v[0-9.]*\)$|\1|p')"
    if [[ -z "${NEW_VERSION}" ]]; then
        # Fall back to peeking at the zip's prefix dir.
        NEW_VERSION="$(unzip -l "${ZIP_PATH}" 2>/dev/null \
            | awk 'NR>3 && $4 ~ /^maugood-v/ { print $4; exit }' \
            | sed 's|^maugood-||;s|/.*||')"
    fi
fi

if [[ -f "${INSTALL_DIR}/frontend/package.json" ]]; then
    CURRENT_VERSION="v$(python3 -c "
import json, pathlib
p = pathlib.Path('${INSTALL_DIR}/frontend/package.json')
print(json.loads(p.read_text()).get('version', '?'))
")"
else
    CURRENT_VERSION="?"
fi

# ---------------------------------------------------------------------------
# Confirmation banner
# ---------------------------------------------------------------------------

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${INSTALL_DIR}/backups/${TIMESTAMP}-pre-update"

echo "================================================================"
echo " Maugood update applier"
echo "================================================================"
echo " install dir       : ${INSTALL_DIR}"
echo " compose file      : ${COMPOSE_FILE_REL}"
echo " current version   : ${CURRENT_VERSION}"
if [[ ${BACKUP_ONLY} -eq 1 ]]; then
    echo " mode              : BACKUP ONLY (no code change)"
else
    echo " new release zip   : ${ZIP_PATH}"
    echo " new version       : ${NEW_VERSION:-?}"
    echo " stop stack first  : $([[ ${DO_STOP} -eq 1 ]] && echo yes || echo NO --skip-stop)"
    echo " rebuild images    : $([[ ${DO_REBUILD} -eq 1 ]] && echo yes || echo NO --no-rebuild)"
fi
echo " backup snapshot   : ${BACKUP_DIR}"
echo " dry run           : $([[ ${DRY_RUN} -eq 1 ]] && echo yes || echo no)"
echo "================================================================"

if [[ ${ASSUME_YES} -eq 0 && ${DRY_RUN} -eq 0 ]]; then
    read -r -p "Proceed? [y/N] " confirm
    if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
        echo "aborted by operator."
        exit 1
    fi
fi

run() {
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] $*"
    else
        echo "+ $*"
        eval "$@"
    fi
}

# ---------------------------------------------------------------------------
# 1. Snapshot operator-state. The backend "data" volume is Docker-managed;
#    we don't touch it. We DO snapshot every operator-edited file in the
#    install tree so a botched update is recoverable.
# ---------------------------------------------------------------------------

echo
echo ">> Snapshotting operator-state to ${BACKUP_DIR}"
run "mkdir -p '${BACKUP_DIR}'"

# Files that may not exist (.env on a brand-new install). Use an explicit
# loop so a missing file doesn't abort the whole snapshot.
SNAPSHOT_PATHS=(
    ".env"
    "backend/.env"
    "frontend/.env"
    "ops/certs"
    "frontend/src/assets"
    "credentials.txt"
)
for p in "${SNAPSHOT_PATHS[@]}"; do
    src="${INSTALL_DIR}/${p}"
    if [[ -e "${src}" ]]; then
        # Preserve relative path inside the backup dir for clean restore.
        dest_dir="${BACKUP_DIR}/$(dirname "${p}")"
        run "mkdir -p '${dest_dir}'"
        run "cp -a '${src}' '${dest_dir}/'"
    fi
done

# Compress to a single tarball alongside the dir so the operator can
# stash one file off-machine.
run "tar -czf '${BACKUP_DIR}.tar.gz' -C '${INSTALL_DIR}/backups' '${TIMESTAMP}-pre-update'"

if [[ ${BACKUP_ONLY} -eq 1 ]]; then
    echo
    echo "================================================================"
    echo " ✓ Backup-only complete"
    echo "================================================================"
    echo "  Snapshot dir : ${BACKUP_DIR}"
    echo "  Tarball      : ${BACKUP_DIR}.tar.gz"
    exit 0
fi

# ---------------------------------------------------------------------------
# 2. Stop the running stack (unless skipped)
# ---------------------------------------------------------------------------

if [[ ${DO_STOP} -eq 1 ]]; then
    echo
    echo ">> Stopping the running stack (${COMPOSE_FILE_REL})"
    # Subshell so the cd doesn't leak. ``docker compose down`` with no
    # ``-v`` keeps every named volume — Postgres data, branding logos,
    # face crops, and the model cache all survive.
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} down"
        else
            docker compose -f "${COMPOSE_FILE_REL}" down 2>&1 | tail -5 || true
        fi
    )
fi

# ---------------------------------------------------------------------------
# 3. Extract zip to a temp dir + rsync into install dir
# ---------------------------------------------------------------------------

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo
echo ">> Extracting ${ZIP_PATH} into a staging dir"
run "unzip -q '${ZIP_PATH}' -d '${TEMP_DIR}'"

# The release zip uses ``maugood-vX.Y.Z/`` as its prefix dir.
EXTRACT_ROOT="$(find "${TEMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ ${DRY_RUN} -eq 0 ]]; then
    if [[ -z "${EXTRACT_ROOT}" ]]; then
        echo "error: zip didn't extract a top-level directory" >&2
        exit 1
    fi
    if [[ ! -f "${EXTRACT_ROOT}/docker-compose.yml" ]]; then
        echo "error: staged tree at '${EXTRACT_ROOT}' doesn't look like Maugood" >&2
        exit 1
    fi
else
    # In dry-run we never ran unzip, so synthesise the path for the
    # rsync echo below.
    EXTRACT_ROOT="${TEMP_DIR}/maugood-${NEW_VERSION:-vX.Y.Z}"
fi

echo
echo ">> Mirroring new code over the install dir (preserving operator-state)"

# Operator-state paths excluded from the mirror. ``rsync --delete``
# combined with ``--exclude=path`` leaves the destination's matching
# paths alone — which is exactly what we want for env/certs/logs/data.
RSYNC_EXCLUDES=(
    --exclude=".env"
    --exclude="backend/.env"
    --exclude="frontend/.env"
    --exclude="ops/certs/"
    --exclude="backend/logs/"
    --exclude="backups/"
    --exclude="dist/"
    --exclude="data/"
    --exclude="backend/data/"
    --exclude="frontend/node_modules/"
    --exclude="frontend/dist/"
    --exclude="credentials.txt"
    --exclude=".git/"
    # Per-client branding assets (the customer's logo). Customers
    # who customised these in-tree see their changes survive an
    # update; the dev-time placeholders in the release zip do NOT
    # overwrite. To re-pick the dev placeholders, delete the file
    # before running this script.
    --exclude="frontend/src/assets/"
)

if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "[dry-run] rsync -avh --delete ${RSYNC_EXCLUDES[*]} '${EXTRACT_ROOT}/' '${INSTALL_DIR}/'"
else
    rsync -ah --delete \
        "${RSYNC_EXCLUDES[@]}" \
        "${EXTRACT_ROOT}/" \
        "${INSTALL_DIR}/" \
        | tail -8
fi

# ---------------------------------------------------------------------------
# 4. Bring the stack back up
# ---------------------------------------------------------------------------

echo
echo ">> Bringing the stack back up (${COMPOSE_FILE_REL})"
(
    cd "${INSTALL_DIR}"
    if [[ ${DO_REBUILD} -eq 1 ]]; then
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} up -d --build"
        else
            # Stream build output live (--progress=plain) — the same
            # pattern the setup wizard uses. The pre-fix ``| tail -8``
            # buffered the build until done so operators thought the
            # script had hung on a long upgrade.
            docker compose -f "${COMPOSE_FILE_REL}" build --progress=plain
            docker compose -f "${COMPOSE_FILE_REL}" up -d 2>&1 | tail -8
        fi
    else
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} up -d"
        else
            docker compose -f "${COMPOSE_FILE_REL}" up -d 2>&1 | tail -5
        fi
    fi
)

# ---------------------------------------------------------------------------
# 5. Health probe
# ---------------------------------------------------------------------------

if [[ ${DRY_RUN} -eq 0 ]]; then
    # Update the VERSION file at the install root (the zip ships
    # one at maugood-vX.Y.Z/VERSION and rsync mirrored it across; we
    # also append to .version-history.log so the operator can see
    # every upgrade this install has been through).
    if [[ -f "${INSTALL_DIR}/VERSION" ]]; then
        echo
        echo ">> Stamping VERSION + .version-history.log"
        STAMPED_VERSION="$(cat "${INSTALL_DIR}/VERSION")"
        echo "${STAMPED_VERSION:-${NEW_VERSION:-?}} updated $(date -u +%Y-%m-%dT%H:%M:%SZ) from ${CURRENT_VERSION}" \
            >> "${INSTALL_DIR}/.version-history.log"
    fi

    echo
    echo ">> Probing /api/health (up to 90s)"
    DEADLINE=$(( $(date +%s) + 90 ))
    while [[ $(date +%s) -lt ${DEADLINE} ]]; do
        if curl -sk -m 5 https://localhost/api/health 2>/dev/null \
            | grep -q '"status":"ok"' \
            || curl -s -m 5 http://localhost:8000/api/health 2>/dev/null \
            | grep -q '"status":"ok"'; then
            echo "✓ backend healthy"
            break
        fi
        sleep 2
    done
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "================================================================"
echo " ✓ Update applied"
echo "================================================================"
echo "  From version : ${CURRENT_VERSION}"
echo "  To version   : ${NEW_VERSION:-?}"
echo "  Backup       : ${BACKUP_DIR}.tar.gz"
echo
echo "  If anything looks wrong:"
echo "    cd ${INSTALL_DIR}"
echo "    docker compose -f ${COMPOSE_FILE_REL} down"
echo "    tar -xzf ${BACKUP_DIR}.tar.gz -C ./backups"
echo "    cp -a backups/${TIMESTAMP}-pre-update/.env ./.env  # restore env"
echo "    # then re-extract the previous release zip on top, and:"
echo "    docker compose -f ${COMPOSE_FILE_REL} up -d --build"
