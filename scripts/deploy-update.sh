#!/usr/bin/env bash
#
# deploy-update.sh — apply a Maugood release zip to a live install.
#
# Targets the full HTTPS-local stack (postgres + backend + nginx +
# prometheus + alertmanager + grafana). Reads RELEASE-MANIFEST.json
# from the zip via scripts/_update_planner.py, prints what will
# change, and rebuilds + restarts only the services whose code (or
# config, or migrations) actually changed.
#
# For the lighter 3-service quick-start install, use quick-update.sh
# instead — same planner, smaller service universe.
#
# Usage:
#   ./scripts/deploy-update.sh --zip /path/to/maugood-vX.Y.Z.zip
#   ./scripts/deploy-update.sh --zip ./maugood-v1.2.0.zip --install-dir /opt/maugood
#   ./scripts/deploy-update.sh --zip ./bundle.zip --dry-run
#   ./scripts/deploy-update.sh --backup-only --install-dir /opt/maugood
#
# Flags:
#   --zip <path>             Required (unless --backup-only). The release zip
#                            produced by ``scripts/package-release.sh``.
#   --install-dir <path>     Where the live install lives. Defaults to the
#                            script's parent directory.
#   --no-rebuild             Skip the ``docker compose build`` step. Use only
#                            for code-only changes that don't need a new image
#                            layer (rare; default rebuilds because Docker is
#                            cheap and a missed rebuild is a debugging trap).
#   --skip-stop              Don't stop services before rsync. The new code
#                            lands on disk under the running containers; a
#                            mounted backend bind mount picks it up on the
#                            next module reload but Python processes need a
#                            container restart for real changes to take. Use
#                            sparingly.
#   --dry-run                Print every step that would run, write nothing.
#   --backup-only            Snapshot operator-state to a tarball, then exit.
#   --force-skip-versions    Bypass the planner's "you skipped a release"
#                            refusal. Data-migration scripts in skipped
#                            releases will NOT run.
#   --yes                    Don't prompt for confirmation. For automation.
#
# What it does, in order:
#
#   1. Pre-flight: validate paths, detect which compose file is in use
#      (docker-compose-https-local.yaml vs docker-compose.yml).
#   2. Read RELEASE-MANIFEST.json from the zip; build an upgrade plan.
#      Refuse if the install is downgrading or skipping versions
#      (unless --force-skip-versions).
#   3. Snapshot operator-state into ``backups/<timestamp>-pre-update/``
#      (env files, certs, in-tree branding assets, credentials.txt).
#   4. Stop only the services the plan flagged for rebuild/restart.
#   5. Extract the zip, rsync the new code over the install dir
#      excluding every operator-owned path (.env, ops/certs/, data/,
#      backend/logs/, backups/, etc).
#   6. Build only the services the plan flagged for rebuild.
#   7. Up only the services the plan flagged for restart.
#   8. Backend entrypoint runs Alembic migrations on boot — every
#      tenant schema upgrades automatically.
#   9. Poll /api/health, then stamp VERSION + .version-history.log.
#
# Recovery: every run leaves a tarball under
# ``backups/<timestamp>-pre-update.tar.gz`` with the prior operator-state.

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
FORCE_SKIP=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip)                  ZIP_PATH="$2"; shift 2 ;;
        --install-dir)          INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
        --no-rebuild)           DO_REBUILD=0; shift ;;
        --skip-stop)            DO_STOP=0; shift ;;
        --dry-run)              DRY_RUN=1; shift ;;
        --backup-only)          BACKUP_ONLY=1; shift ;;
        --force-skip-versions)  FORCE_SKIP=1; shift ;;
        --yes|-y)               ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '3,60p' "$0"
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
for cmd in docker python3 unzip rsync; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

PLANNER="${SCRIPT_DIR}/_update_planner.py"
if [[ ${BACKUP_ONLY} -eq 0 && ! -f "${PLANNER}" ]]; then
    echo "error: planner module missing at '${PLANNER}'" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Detect which compose file is actually running so down/up target the
# right stack. Customer installs run docker-compose-https-local.yaml
# (HTTPS via nginx + self-signed cert); without ``-f`` docker would
# default to docker-compose.yml (the dev stack) and the live HTTPS
# containers would never be rebuilt.
# ---------------------------------------------------------------------------

COMPOSE_FILE_REL="docker-compose.yml"
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
            COMPOSE_FILE_REL="docker-compose-https-local.yaml"
        fi
    fi
fi

# Per-compose service universe + the manifest-key → service-name mapping.
# In HTTPS-local the frontend bundle is built INTO the nginx image, so
# a manifest entry with frontend_changed=true still has to rebuild
# nginx. quick-update.sh handles this with a different service_set;
# here we keep the planner's view simple and merge frontend→nginx at
# the script layer.
HTTPS_LOCAL=0
if [[ "${COMPOSE_FILE_REL}" == "docker-compose-https-local.yaml" ]]; then
    HTTPS_LOCAL=1
    SERVICE_SET="postgres,backend,nginx,prometheus,alertmanager,grafana"
else
    SERVICE_SET="postgres,backend,frontend"
fi

# ---------------------------------------------------------------------------
# Snapshot helper (used by both --backup-only and the full update path)
# ---------------------------------------------------------------------------

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${INSTALL_DIR}/backups/${TIMESTAMP}-pre-update"

run() {
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] $*"
    else
        echo "+ $*"
        eval "$@"
    fi
}

snapshot_operator_state() {
    echo
    echo ">> Snapshotting operator-state to ${BACKUP_DIR}"
    run "mkdir -p '${BACKUP_DIR}'"
    local paths=(
        ".env"
        "backend/.env"
        "frontend/.env"
        "ops/certs"
        "frontend/src/assets"
        "credentials.txt"
    )
    for p in "${paths[@]}"; do
        local src="${INSTALL_DIR}/${p}"
        if [[ -e "${src}" ]]; then
            local dest_dir="${BACKUP_DIR}/$(dirname "${p}")"
            run "mkdir -p '${dest_dir}'"
            run "cp -a '${src}' '${dest_dir}/'"
        fi
    done
    run "tar -czf '${BACKUP_DIR}.tar.gz' -C '${INSTALL_DIR}/backups' '${TIMESTAMP}-pre-update'"
}

if [[ ${BACKUP_ONLY} -eq 1 ]]; then
    echo "================================================================"
    echo " Maugood update applier — BACKUP ONLY"
    echo "================================================================"
    echo " install dir       : ${INSTALL_DIR}"
    echo " compose file      : ${COMPOSE_FILE_REL}"
    echo " backup snapshot   : ${BACKUP_DIR}"
    echo "================================================================"
    snapshot_operator_state
    echo
    echo "================================================================"
    echo " ✓ Backup-only complete"
    echo "================================================================"
    echo "  Snapshot dir : ${BACKUP_DIR}"
    echo "  Tarball      : ${BACKUP_DIR}.tar.gz"
    exit 0
fi

# ---------------------------------------------------------------------------
# Build + display the upgrade plan
# ---------------------------------------------------------------------------

echo
echo ">> Inspecting ${ZIP_PATH}"
PLAN_TEXT="$(
    python3 "${PLANNER}" \
        --zip "${ZIP_PATH}" \
        --install-dir "${INSTALL_DIR}" \
        --service-set "${SERVICE_SET}" \
        $([[ ${FORCE_SKIP} -eq 1 ]] && echo --force-skip-versions) \
        2>&1 || true
)"
echo "${PLAN_TEXT}"

if grep -q '^WOULD REFUSE:' <<<"${PLAN_TEXT}"; then
    echo
    echo "Refusing to proceed — see the message above."
    exit 1
fi

# Pull the resolved plan back out so the script can act on it. The
# Python module is the single source of truth for what to do.
# Render the FORCE_SKIP int into a real Python literal — bash's
# ``${var:+True}${var:-False}`` form silently produces ``True0`` when
# the variable is set to ``0`` (both substitutions fire), so build
# the literal explicitly here.
if [[ ${FORCE_SKIP} -eq 1 ]]; then FORCE_SKIP_PY="True"; else FORCE_SKIP_PY="False"; fi

PLAN_JSON="$(python3 - <<PY
import json, sys
sys.path.insert(0, "${SCRIPT_DIR}")
from _update_planner import (
    load_manifest_from_zip, current_install_version, build_plan,
)
from pathlib import Path
m = load_manifest_from_zip(Path("${ZIP_PATH}"))
cur = current_install_version(Path("${INSTALL_DIR}"))
plan = build_plan(
    m, cur,
    service_set=tuple(s for s in "${SERVICE_SET}".split(",") if s),
    force_skip_versions=${FORCE_SKIP_PY},
)
# In HTTPS-local the frontend bundle is built INTO the nginx image,
# so a manifest "frontend_changed" -> "nginx rebuild" at the script
# layer (the planner stays compose-agnostic).
rebuild = list(plan.services_to_rebuild)
restart = list(plan.services_to_restart)
if ${HTTPS_LOCAL} == 1 and m.services_changed.get("frontend"):
    if "nginx" not in rebuild: rebuild.append("nginx")
    if "nginx" not in restart: restart.append("nginx")
print(json.dumps({
    "current": plan.current_version,
    "target": plan.target_version,
    "rebuild": rebuild,
    "restart": restart,
    "scripts": plan.upgrade_scripts,
}))
PY
)"

CUR_V="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['current'])" "${PLAN_JSON}")"
TGT_V="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['target'])" "${PLAN_JSON}")"
REBUILD_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['rebuild']))" "${PLAN_JSON}")"
RESTART_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['restart']))" "${PLAN_JSON}")"

# Honour --no-rebuild: drop rebuild_list (services already in
# restart_list will still bounce, just on the existing image).
if [[ ${DO_REBUILD} -eq 0 ]]; then
    REBUILD_LIST=""
fi

# ---------------------------------------------------------------------------
# Confirmation banner
# ---------------------------------------------------------------------------

echo
echo "================================================================"
echo " Maugood update applier"
echo "================================================================"
echo " install dir       : ${INSTALL_DIR}"
echo " compose file      : ${COMPOSE_FILE_REL}"
echo " from version      : v${CUR_V}"
echo " to version        : v${TGT_V}"
echo " stop services     : $([[ ${DO_STOP} -eq 1 ]] && echo yes || echo NO --skip-stop)"
echo " rebuild images    : $([[ ${DO_REBUILD} -eq 1 ]] && echo yes || echo NO --no-rebuild)"
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

# ---------------------------------------------------------------------------
# 1. Snapshot operator-state
# ---------------------------------------------------------------------------

snapshot_operator_state

# ---------------------------------------------------------------------------
# 2. Stop only the services the plan flagged
# ---------------------------------------------------------------------------

STOP_LIST="$(echo "${REBUILD_LIST} ${RESTART_LIST}" | tr ' ' '\n' | sort -u | xargs)"
if [[ ${DO_STOP} -eq 1 && -n "${STOP_LIST}" ]]; then
    echo
    echo ">> Stopping ${STOP_LIST}"
    # ``docker compose stop`` keeps unchanged services running and the
    # network attached. ``docker compose down`` would tear the network
    # too — slower, more invasive, no win when the plan tells us
    # exactly what to bounce.
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} stop ${STOP_LIST}"
        else
            docker compose -f "${COMPOSE_FILE_REL}" stop ${STOP_LIST} \
                2>&1 | tail -5 || true
        fi
    )
fi

# ---------------------------------------------------------------------------
# 3. Extract zip + rsync into install dir
# ---------------------------------------------------------------------------

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo
echo ">> Extracting ${ZIP_PATH} into a staging dir"
run "unzip -q '${ZIP_PATH}' -d '${TEMP_DIR}'"

EXTRACT_ROOT="$(find "${TEMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ ${DRY_RUN} -eq 0 ]]; then
    if [[ -z "${EXTRACT_ROOT}" || ! -f "${EXTRACT_ROOT}/docker-compose.yml" ]]; then
        echo "error: extracted tree doesn't look like Maugood" >&2
        exit 1
    fi
fi

echo
echo ">> Mirroring new code over the install dir (preserving operator-state)"

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
    echo "[dry-run] rsync -ah --delete ${RSYNC_EXCLUDES[*]} '${EXTRACT_ROOT}/' '${INSTALL_DIR}/'"
else
    rsync -ah --delete \
        "${RSYNC_EXCLUDES[@]}" \
        "${EXTRACT_ROOT}/" \
        "${INSTALL_DIR}/" \
        | tail -8
fi

# ---------------------------------------------------------------------------
# 4. Build + restart only what changed
# ---------------------------------------------------------------------------

if [[ -n "${REBUILD_LIST}" ]]; then
    echo
    echo ">> Building ${REBUILD_LIST}"
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} build --progress=plain ${REBUILD_LIST}"
        else
            # --progress=plain so the operator sees live build output
            # instead of the TTY-redraw mode silently buffering through
            # any pipe. Same pattern the setup wizard uses.
            docker compose -f "${COMPOSE_FILE_REL}" build --progress=plain ${REBUILD_LIST}
        fi
    )
fi

if [[ -n "${RESTART_LIST}" ]]; then
    echo
    echo ">> Starting ${RESTART_LIST}"
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} up -d ${RESTART_LIST}"
        else
            docker compose -f "${COMPOSE_FILE_REL}" up -d ${RESTART_LIST} \
                2>&1 | tail -8
        fi
    )
else
    echo
    echo ">> No services to restart — install code on disk reflects the"
    echo "   new release, but no container needed a bounce."
fi

# ---------------------------------------------------------------------------
# 5. Health probe + version stamp
# ---------------------------------------------------------------------------

if [[ ${DRY_RUN} -eq 0 ]]; then
    echo
    echo ">> Probing /api/health (up to 90s)"
    DEADLINE=$(( $(date +%s) + 90 ))
    while [[ $(date +%s) -lt ${DEADLINE} ]]; do
        if curl -sk -m 5 https://localhost/api/health 2>/dev/null \
            | grep -q '"status":"ok"' \
            || curl -s -m 5 http://localhost:8000/api/health 2>/dev/null \
            | grep -q '"status":"ok"'; then
            echo "  ✓ backend healthy"
            break
        fi
        sleep 2
    done

    echo "${TGT_V}" > "${INSTALL_DIR}/VERSION" 2>/dev/null || true
    echo "v${TGT_V} updated $(date -u +%Y-%m-%dT%H:%M:%SZ) from v${CUR_V}" \
        >> "${INSTALL_DIR}/.version-history.log"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "================================================================"
echo " ✓ Update applied"
echo "================================================================"
echo "  From version : v${CUR_V}"
echo "  To version   : v${TGT_V}"
echo "  Compose      : ${COMPOSE_FILE_REL}"
echo "  Rebuilt      : ${REBUILD_LIST:-none}"
echo "  Restarted    : ${RESTART_LIST:-none}"
echo "  Backup       : ${BACKUP_DIR}.tar.gz"
SCRIPTS_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['scripts']))" "${PLAN_JSON}")"
if [[ -n "${SCRIPTS_LIST}" ]]; then
    echo
    echo " Manual upgrade scripts shipped in this release:"
    for s in ${SCRIPTS_LIST}; do
        modname="$(basename "${s}" .py)"
        echo "   docker compose -f ${COMPOSE_FILE_REL} exec backend python -m scripts.${modname}"
    done
    echo
    echo " Run them in the order listed above. Each is idempotent."
fi
echo
echo "  If anything looks wrong:"
echo "    cd ${INSTALL_DIR}"
echo "    docker compose -f ${COMPOSE_FILE_REL} down"
echo "    tar -xzf ${BACKUP_DIR}.tar.gz -C ./backups"
echo "    cp -a backups/${TIMESTAMP}-pre-update/.env ./.env"
echo "    # then re-extract the previous release zip on top, and:"
echo "    docker compose -f ${COMPOSE_FILE_REL} up -d --build"
