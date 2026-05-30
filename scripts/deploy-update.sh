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
# For the lighter 3-service quick-start install, pass --quick-start —
# same planner, but targets only postgres + backend + frontend via
# docker-compose.yml (no nginx, no HTTPS, no monitoring stack).
#
# Usage:
#   ./scripts/deploy-update.sh --zip /path/to/maugood-vX.Y.Z.zip
#   ./scripts/deploy-update.sh --zip ./maugood-v1.2.0.zip --install-dir /opt/maugood
#   ./scripts/deploy-update.sh --zip ./bundle.zip --dry-run
#   ./scripts/deploy-update.sh --backup-only --install-dir /opt/maugood
#   ./scripts/deploy-update.sh --zip ./bundle.zip --quick-start   # HTTP quick-start stack
#
# Flags:
#   --zip <path>             Required (unless --backup-only). The release zip
#                            produced by ``scripts/package-release.sh``.
#   --install-dir <path>     Where the live install lives. Defaults to the
#                            script's parent directory.
#   --quick-start            Target the 3-service HTTP stack started by
#                            quick-start.sh (postgres + backend + frontend,
#                            docker-compose.yml). Skips HTTPS compose-file
#                            auto-detection entirely.
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
#   --auto-rollback          If the post-update health probe fails, restore
#                            the database from the dump taken in step 3
#                            automatically (the reversible part of a
#                            rollback). Without this flag a health failure
#                            stops with printed manual recovery steps.
#   --skip-db-backup         Escape hatch — skip the mandatory pg_dump.
#                            STRONGLY discouraged; only for a DB that lives
#                            outside this stack. Disables --auto-rollback.
#   --yes                    Don't prompt for confirmation. For automation.
#
# What it does, in order:
#
#   1. Pre-flight: validate paths, detect which compose file is in use
#      (docker-compose-https-local.yaml vs docker-compose.yml).
#      --quick-start bypasses detection and always picks docker-compose.yml.
#   2. Read RELEASE-MANIFEST.json from the zip; build an upgrade plan.
#      Refuse if the install is downgrading or skipping versions
#      (unless --force-skip-versions).
#   3. MANDATORY BACKUP (fail-closed — a failure here aborts before any
#      file is touched):
#        a. Full PostgreSQL dump of every schema (all tenants + public +
#           main) via ``pg_dump`` inside the running postgres container,
#           gzipped to ``backups/db-<timestamp>.sql.gz``.
#        b. Operator-state snapshot (env files, certs, in-tree branding
#           assets, credentials.txt) to ``backups/<timestamp>-pre-update/``
#           + a ``.tar.gz`` of the same.
#   4. Stop only the services the plan flagged for rebuild/restart.
#   5. Extract the zip, rsync the new code over the install dir
#      excluding every operator-owned path (.env, ops/certs/, data/,
#      backend/logs/, backups/, etc). The DB data dir (./data/) is
#      excluded, so existing data is NEVER touched by the code update.
#   6. Build only the services the plan flagged for rebuild.
#   7. Up only the services the plan flagged for restart. On the
#      dev/quick-start stack, if the frontend was restarted, re-run
#      ``npm install`` inside its container so a release that added an
#      npm dependency lands in the named node_modules volume (otherwise
#      Vite throws "Failed to resolve import"). No-op on HTTPS-local.
#   8. Backend entrypoint runs Alembic migrations on boot — every
#      tenant schema upgrades automatically. Migrations are additive;
#      data is never cleared.
#   9. Poll /api/health and ACT on the result: on success stamp VERSION +
#      .version-history.log; on failure either auto-rollback the DB
#      (--auto-rollback) or stop and print manual recovery steps.
#
# Recovery: every run leaves both a DB dump
# (``backups/db-<timestamp>.sql.gz``) and an operator-state tarball
# (``backups/<timestamp>-pre-update.tar.gz``). The DB dump restores with:
#   gunzip -c backups/db-<ts>.sql.gz | \
#     docker compose -f <compose> exec -T postgres psql -U maugood -d maugood

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
QUICK_START=0          # NEW: --quick-start flag
AUTO_ROLLBACK=0        # NEW: restore the DB dump automatically if health fails
SKIP_DB_BACKUP=0       # ESCAPE HATCH: skip the mandatory pg_dump (NOT recommended)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip)                  ZIP_PATH="$2"; shift 2 ;;
        --install-dir)          INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
        --quick-start)          QUICK_START=1; shift ;;
        --no-rebuild)           DO_REBUILD=0; shift ;;
        --skip-stop)            DO_STOP=0; shift ;;
        --dry-run)              DRY_RUN=1; shift ;;
        --backup-only)          BACKUP_ONLY=1; shift ;;
        --force-skip-versions)  FORCE_SKIP=1; shift ;;
        --auto-rollback)        AUTO_ROLLBACK=1; shift ;;
        --skip-db-backup)       SKIP_DB_BACKUP=1; shift ;;
        --yes|-y)               ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '3,90p' "$0"
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
# right stack.
#
# --quick-start bypasses this entirely: it always uses docker-compose.yml
# (the 3-service HTTP stack from quick-start.sh). This is necessary
# because the auto-detection falls back to docker-compose-https-local.yaml
# when no containers are running — which breaks dry-run and any run where
# services were stopped before the script was called.
# ---------------------------------------------------------------------------

HTTPS_LOCAL=0

if [[ ${QUICK_START} -eq 1 ]]; then
    # Explicit override: always use the plain HTTP compose file.
    COMPOSE_FILE_REL="docker-compose.yml"
    SERVICE_SET="postgres,backend,frontend"
    echo "note: --quick-start set; using docker-compose.yml (HTTP, 3-service stack)"
else
    # Original auto-detection logic — unchanged for full HTTPS-local installs.
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
                # -------------------------------------------------------
                # FIXED: previously hard-coded https-local here, which
                # forced HTTPS even on quick-start installs when no
                # containers were running (e.g. during --dry-run or after
                # a manual ``docker compose down``). Now we sniff the
                # .env to decide: if MAUGOOD_TENANT_MODE=single (written
                # by quick-start.sh) we stay on docker-compose.yml.
                # -------------------------------------------------------
                TENANT_MODE=""
                if [[ -f "${INSTALL_DIR}/.env" ]]; then
                    TENANT_MODE="$(grep -E '^MAUGOOD_TENANT_MODE=' "${INSTALL_DIR}/.env" \
                        | cut -d= -f2 | tr -d '[:space:]' || true)"
                fi
                if [[ "${TENANT_MODE}" == "single" ]]; then
                    COMPOSE_FILE_REL="docker-compose.yml"
                    echo "note: no containers running but MAUGOOD_TENANT_MODE=single detected;" \
                         "using docker-compose.yml"
                else
                    COMPOSE_FILE_REL="docker-compose-https-local.yaml"
                fi
            fi
        fi
    fi

    # Per-compose service universe + the manifest-key → service-name mapping.
    # In HTTPS-local the frontend bundle is built INTO the nginx image, so
    # a manifest entry with frontend_changed=true still has to rebuild nginx.
    if [[ "${COMPOSE_FILE_REL}" == "docker-compose-https-local.yaml" ]]; then
        HTTPS_LOCAL=1
        SERVICE_SET="postgres,backend,nginx,prometheus,alertmanager,grafana"
    else
        SERVICE_SET="postgres,backend,frontend"
    fi
fi

# ---------------------------------------------------------------------------
# Snapshot helper (used by both --backup-only and the full update path)
# ---------------------------------------------------------------------------

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${INSTALL_DIR}/backups/${TIMESTAMP}-pre-update"
DB_DUMP_FILE="${INSTALL_DIR}/backups/db-${TIMESTAMP}.sql.gz"

# Postgres connection params (match docker-compose.yml defaults; the
# bootstrap superuser 'maugood' owns the DB and every tenant schema).
PG_USER="${MAUGOOD_PG_USER:-maugood}"
PG_DB="${MAUGOOD_PG_DB:-maugood}"

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

# ---------------------------------------------------------------------------
# Database backup — MANDATORY and fail-closed.
#
# Dumps EVERY schema (public registry + main + every tenant_<slug>) in one
# pg_dump, gzipped to backups/db-<timestamp>.sql.gz. pg_dump runs inside the
# postgres container so the host needs no client binaries. The postgres
# service is brought up first if it isn't already running — the dump must
# never run against a stopped database.
#
# A failure here is FATAL: the function exits the whole script non-zero so
# no code is touched without a recoverable snapshot on disk.
# ---------------------------------------------------------------------------

ensure_postgres_up() {
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} up -d postgres"
        return 0
    fi
    (
        cd "${INSTALL_DIR}"
        docker compose -f "${COMPOSE_FILE_REL}" up -d postgres 2>&1 | tail -3 || true
    )
    # Wait for pg_isready (max ~30s) so the dump doesn't race the boot.
    local deadline=$(( $(date +%s) + 30 ))
    while [[ $(date +%s) -lt ${deadline} ]]; do
        if (cd "${INSTALL_DIR}" && docker compose -f "${COMPOSE_FILE_REL}" \
                exec -T postgres pg_isready -U "${PG_USER}" -d "${PG_DB}" \
                >/dev/null 2>&1); then
            return 0
        fi
        sleep 2
    done
    echo "error: postgres did not become ready within 30s — cannot take DB backup" >&2
    return 1
}

backup_database() {
    if [[ ${SKIP_DB_BACKUP} -eq 1 ]]; then
        echo
        echo ">> SKIPPING database backup (--skip-db-backup). No DB safety net!"
        return 0
    fi
    echo
    echo ">> Taking full PostgreSQL backup → ${DB_DUMP_FILE}"
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} exec -T postgres \\"
        echo "[dry-run]   pg_dump -U ${PG_USER} -d ${PG_DB} | gzip > ${DB_DUMP_FILE}"
        return 0
    fi

    ensure_postgres_up || exit 1

    run "mkdir -p '${INSTALL_DIR}/backups'"

    # --clean --if-exists so the dump is self-contained and replayable onto a
    # populated DB during rollback. set -o pipefail (already on) makes a
    # pg_dump failure propagate through the gzip pipe.
    if ! (
        cd "${INSTALL_DIR}"
        docker compose -f "${COMPOSE_FILE_REL}" exec -T postgres \
            pg_dump -U "${PG_USER}" -d "${PG_DB}" --clean --if-exists \
        | gzip > "${DB_DUMP_FILE}"
    ); then
        echo "error: pg_dump failed — aborting before any change is made" >&2
        rm -f "${DB_DUMP_FILE}"
        exit 1
    fi

    # Sanity: a real Maugood dump is never a few bytes. Guard against a
    # silent empty/partial dump masquerading as success.
    local size
    size="$(stat -c%s "${DB_DUMP_FILE}" 2>/dev/null || echo 0)"
    if [[ "${size}" -lt 1000 ]]; then
        echo "error: DB dump is suspiciously small (${size} bytes) — aborting" >&2
        rm -f "${DB_DUMP_FILE}"
        exit 1
    fi
    echo "   ✓ DB dump written (${size} bytes gzipped)"
}

restore_database() {
    # Replay the dump taken in step 3 back into the live database. Used by
    # --auto-rollback and printed in the manual-recovery footer.
    if [[ ! -f "${DB_DUMP_FILE}" ]]; then
        echo "error: no DB dump at ${DB_DUMP_FILE} — cannot restore" >&2
        return 1
    fi
    echo ">> Restoring database from ${DB_DUMP_FILE}"
    ensure_postgres_up || return 1
    (
        cd "${INSTALL_DIR}"
        gunzip -c "${DB_DUMP_FILE}" \
        | docker compose -f "${COMPOSE_FILE_REL}" exec -T postgres \
            psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 \
            >/dev/null
    )
}

if [[ ${BACKUP_ONLY} -eq 1 ]]; then
    echo "================================================================"
    echo " Maugood update applier — BACKUP ONLY"
    echo "================================================================"
    echo " install dir       : ${INSTALL_DIR}"
    echo " compose file      : ${COMPOSE_FILE_REL}"
    echo " backup snapshot   : ${BACKUP_DIR}"
    echo " db dump           : ${DB_DUMP_FILE}"
    echo "================================================================"
    backup_database
    snapshot_operator_state
    echo
    echo "================================================================"
    echo " ✓ Backup-only complete"
    echo "================================================================"
    echo "  DB dump      : ${DB_DUMP_FILE}"
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
echo " stack mode        : $([[ ${QUICK_START} -eq 1 ]] && echo "quick-start (HTTP)" || echo "auto-detected")"
echo " from version      : v${CUR_V}"
echo " to version        : v${TGT_V}"
echo " stop services     : $([[ ${DO_STOP} -eq 1 ]] && echo yes || echo NO --skip-stop)"
echo " rebuild images    : $([[ ${DO_REBUILD} -eq 1 ]] && echo yes || echo NO --no-rebuild)"
echo " backup snapshot   : ${BACKUP_DIR}"
echo " db dump           : $([[ ${SKIP_DB_BACKUP} -eq 1 ]] && echo "SKIPPED (--skip-db-backup)" || echo "${DB_DUMP_FILE}")"
echo " auto-rollback     : $([[ ${AUTO_ROLLBACK} -eq 1 ]] && echo yes || echo no)"
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
# 1. Mandatory backup — DB dump FIRST (fail-closed), then operator-state.
# ---------------------------------------------------------------------------

backup_database
snapshot_operator_state

# ---------------------------------------------------------------------------
# 2. Stop only the services the plan flagged
# ---------------------------------------------------------------------------

STOP_LIST="$(echo "${REBUILD_LIST} ${RESTART_LIST}" | tr ' ' '\n' | sort -u | xargs)"
if [[ ${DO_STOP} -eq 1 && -n "${STOP_LIST}" ]]; then
    echo
    echo ">> Stopping ${STOP_LIST}"
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
# 4b. Refresh frontend node_modules on the dev / quick-start stack.
#
# The docker-compose.yml frontend service mounts node_modules as a NAMED
# volume (frontend_node_modules:/app/node_modules) so it survives rebuilds.
# That volume is sticky: a release that adds a new npm dependency (e.g.
# react-icons) rebuilds the image, but the running container keeps shadowing
# /app/node_modules with the OLD volume — so Vite throws
# "Failed to resolve import ...". Re-run npm install inside the container so
# the new package.json deps land in the volume, then bounce the dev server.
#
# Not needed on the HTTPS-local stack: there the frontend is built into the
# nginx image at build time, with no runtime node_modules volume.
# ---------------------------------------------------------------------------

if [[ ${HTTPS_LOCAL} -eq 0 && " ${RESTART_LIST} " == *" frontend "* ]]; then
    echo
    echo ">> Refreshing frontend node_modules (named-volume deps may be stale)"
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} exec -T frontend npm install"
        echo "[dry-run] docker compose -f ${COMPOSE_FILE_REL} restart frontend"
    else
        (
            cd "${INSTALL_DIR}"
            # Wait for the freshly-started frontend container to accept exec.
            for _ in 1 2 3 4 5; do
                if docker compose -f "${COMPOSE_FILE_REL}" exec -T frontend true \
                    >/dev/null 2>&1; then
                    break
                fi
                sleep 2
            done
            if docker compose -f "${COMPOSE_FILE_REL}" exec -T frontend \
                npm install 2>&1 | tail -6; then
                docker compose -f "${COMPOSE_FILE_REL}" restart frontend \
                    2>&1 | tail -3 || true
                echo "   ✓ frontend deps refreshed + dev server restarted"
            else
                echo "   ! npm install in the frontend container failed — if the UI"
                echo "     shows a 'Failed to resolve import' overlay, run manually:"
                echo "       docker compose -f ${COMPOSE_FILE_REL} exec frontend npm install"
                echo "       docker compose -f ${COMPOSE_FILE_REL} restart frontend"
            fi
        )
    fi
fi

# ---------------------------------------------------------------------------
# 5. Health probe + version stamp
#    Quick-start uses HTTP on the backend port; full stack uses HTTPS on 443.
# ---------------------------------------------------------------------------

HEALTHY=0
if [[ ${DRY_RUN} -eq 0 ]]; then
    echo
    echo ">> Probing /api/health (up to 90s)"
    DEADLINE=$(( $(date +%s) + 90 ))

    # Determine the backend port for quick-start health probing.
    BACKEND_PORT="8000"
    if [[ -f "${INSTALL_DIR}/.env" ]]; then
        _port="$(grep -E '^MAUGOOD_BACKEND_HOST_PORT=' "${INSTALL_DIR}/.env" \
            | cut -d= -f2 | tr -d '[:space:]' || true)"
        [[ -n "${_port}" ]] && BACKEND_PORT="${_port}"
    fi

    while [[ $(date +%s) -lt ${DEADLINE} ]]; do
        if [[ ${QUICK_START} -eq 1 ]]; then
            # Quick-start is plain HTTP only — skip the HTTPS probe to
            # avoid curl SSL errors being mistaken for a real failure.
            if curl -s -m 5 "http://localhost:${BACKEND_PORT}/api/health" 2>/dev/null \
                | grep -q '"status":"ok"'; then
                HEALTHY=1; echo "  ✓ backend healthy"; break
            fi
        else
            if curl -sk -m 5 https://localhost/api/health 2>/dev/null \
                | grep -q '"status":"ok"' \
                || curl -s -m 5 "http://localhost:${BACKEND_PORT}/api/health" 2>/dev/null \
                | grep -q '"status":"ok"'; then
                HEALTHY=1; echo "  ✓ backend healthy"; break
            fi
        fi
        sleep 2
    done

    if [[ ${HEALTHY} -eq 1 ]]; then
        echo "${TGT_V}" > "${INSTALL_DIR}/VERSION" 2>/dev/null || true
        echo "v${TGT_V} updated $(date -u +%Y-%m-%dT%H:%M:%SZ) from v${CUR_V}" \
            >> "${INSTALL_DIR}/.version-history.log"
    else
        # ---------------------------------------------------------------
        # Health check FAILED. A failed Alembic migration on backend boot
        # is the most common cause — the container never reports healthy.
        # Do NOT stamp VERSION. Either auto-rollback the DB or stop with
        # printed manual recovery steps.
        # ---------------------------------------------------------------
        echo
        echo "================================================================"
        echo " ✗ HEALTH CHECK FAILED after update (v${CUR_V} → v${TGT_V})"
        echo "================================================================"
        echo " The backend did not report healthy within 90s. Recent logs:"
        (cd "${INSTALL_DIR}" && docker compose -f "${COMPOSE_FILE_REL}" \
            logs --tail=30 backend 2>&1 | sed 's/^/   /') || true
        echo

        if [[ ${AUTO_ROLLBACK} -eq 1 && ${SKIP_DB_BACKUP} -eq 0 ]]; then
            echo ">> --auto-rollback set: restoring the database to its"
            echo "   pre-update state. NOTE: this reverts DATA only. The new"
            echo "   application CODE is still on disk — re-extract the"
            echo "   previous release zip to fully revert code."
            if restore_database; then
                echo "   ✓ database restored from ${DB_DUMP_FILE}"
            else
                echo "   ✗ automatic DB restore failed — restore manually (see below)"
            fi
        fi

        echo
        echo " Manual recovery:"
        echo "   cd ${INSTALL_DIR}"
        echo "   # 1. Restore the database (reverts all data/migrations):"
        echo "   gunzip -c ${DB_DUMP_FILE} | \\"
        echo "     docker compose -f ${COMPOSE_FILE_REL} exec -T postgres \\"
        echo "       psql -U ${PG_USER} -d ${PG_DB}"
        echo "   # 2. Restore previous code by re-extracting the prior release"
        echo "   #    zip over ${INSTALL_DIR}, then:"
        echo "   docker compose -f ${COMPOSE_FILE_REL} up -d --build"
        echo "   # 3. Restore config if needed:"
        echo "   tar -xzf ${BACKUP_DIR}.tar.gz -C ${INSTALL_DIR}/backups"
        echo "================================================================"
        exit 1
    fi
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
echo "  DB dump      : $([[ ${SKIP_DB_BACKUP} -eq 1 ]] && echo "SKIPPED" || echo "${DB_DUMP_FILE}")"
echo "  Config bkp   : ${BACKUP_DIR}.tar.gz"
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
echo "    # restore the database to its pre-update state:"
echo "    gunzip -c ${DB_DUMP_FILE} | \\"
echo "      docker compose -f ${COMPOSE_FILE_REL} exec -T postgres psql -U ${PG_USER} -d ${PG_DB}"
echo "    # restore config + previous code:"
echo "    tar -xzf ${BACKUP_DIR}.tar.gz -C ./backups"
echo "    cp -a backups/${TIMESTAMP}-pre-update/.env ./.env"
echo "    # then re-extract the previous release zip on top, and:"
echo "    docker compose -f ${COMPOSE_FILE_REL} up -d --build"