#!/usr/bin/env bash
#
# quick-update.sh — apply a release zip to a quick-start install.
#
# Targets the 3-service dev stack (postgres + backend + frontend) set
# up by ``scripts/quick-start.sh``. Reads RELEASE-MANIFEST.json from
# the zip (via the shared planner at scripts/_update_planner.py),
# prints what will change, and rebuilds only the services the
# manifest says have new code.
#
# Operator-state preserved across updates:
#   * .env, backend/.env, frontend/.env       (rsync excluded)
#   * data/ (postgres, faces, model cache)    (rsync excluded; the
#                                              named bind mounts keep
#                                              the on-disk state too)
#   * backend/logs/, backups/, dist/          (rsync excluded)
#   * frontend/src/assets/                    (in-tree branding;
#                                              excluded so per-customer
#                                              tweaks survive)
#
# Usage:
#   ./scripts/quick-update.sh --zip /path/to/maugood-vNEXT.zip
#   ./scripts/quick-update.sh --zip ./bundle.zip --dry-run
#   ./scripts/quick-update.sh --zip ./bundle.zip --force-skip-versions
#   ./scripts/quick-update.sh --backup-only
#
# Flags:
#   --zip <path>             Required (unless --backup-only).
#   --install-dir <path>     Defaults to the script's parent dir.
#   --dry-run                Print the plan + every step that would
#                            run, write nothing.
#   --backup-only            Snapshot operator-state to a tarball
#                            then exit. Same shape as deploy-update's.
#   --force-skip-versions    Bypass the "you're skipping releases"
#                            refusal. Use only after applying every
#                            intermediate zip is impossible (lost the
#                            zips, etc.) — data-migration scripts in
#                            skipped releases will NOT run.
#   --yes                    Skip the y/N confirmation. For automation.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_INSTALL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ZIP_PATH=""
INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
DRY_RUN=0
BACKUP_ONLY=0
FORCE_SKIP=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip)                  ZIP_PATH="$2"; shift 2 ;;
        --install-dir)          INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
        --dry-run)              DRY_RUN=1; shift ;;
        --backup-only)          BACKUP_ONLY=1; shift ;;
        --force-skip-versions)  FORCE_SKIP=1; shift ;;
        --yes|-y)               ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '3,40p' "$0"
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
    exit 1
fi
for cmd in docker python3 unzip rsync; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

PLANNER="${SCRIPT_DIR}/_update_planner.py"
if [[ ! -f "${PLANNER}" ]]; then
    echo "error: planner module missing at '${PLANNER}'" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Snapshot
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
        --service-set "postgres,backend,frontend" \
        $([[ ${FORCE_SKIP} -eq 1 ]] && echo --force-skip-versions) \
        2>&1 || true
)"
echo "${PLAN_TEXT}"

# Did the planner refuse? It exits non-zero with "WOULD REFUSE: …" on
# stderr. The text we captured above carries both stderr and stdout.
if grep -q '^WOULD REFUSE:' <<<"${PLAN_TEXT}"; then
    echo
    echo "Refusing to proceed — see the message above."
    exit 1
fi

# Pull the resolved target_version + service rebuild list back out of
# the planner so the rest of the script can act on them. The planner
# is the single source of truth.
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
    service_set=("postgres", "backend", "frontend"),
    force_skip_versions=${FORCE_SKIP:+True}${FORCE_SKIP:-False},
)
print(json.dumps({
    "current": plan.current_version,
    "target": plan.target_version,
    "rebuild": plan.services_to_rebuild,
    "restart": plan.services_to_restart,
    "scripts": plan.upgrade_scripts,
}))
PY
)"

CUR_V="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['current'])" "${PLAN_JSON}")"
TGT_V="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['target'])" "${PLAN_JSON}")"
REBUILD_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['rebuild']))" "${PLAN_JSON}")"
RESTART_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['restart']))" "${PLAN_JSON}")"

if [[ ${ASSUME_YES} -eq 0 && ${DRY_RUN} -eq 0 ]]; then
    read -r -p "Proceed with v${CUR_V} → v${TGT_V}? [y/N] " confirm
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
# 2. Stop only the services we plan to rebuild + restart
# ---------------------------------------------------------------------------

if [[ -n "${REBUILD_LIST}${RESTART_LIST}" ]]; then
    echo
    # ``docker compose stop`` on individual services keeps unchanged
    # services running. ``docker compose down`` would tear the
    # network too.
    STOP_LIST="$(echo "${REBUILD_LIST} ${RESTART_LIST}" | tr ' ' '\n' | sort -u | xargs)"
    echo ">> Stopping ${STOP_LIST}"
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose stop ${STOP_LIST}"
        else
            docker compose stop ${STOP_LIST} 2>&1 | tail -5 || true
        fi
    )
fi

# ---------------------------------------------------------------------------
# 3. Extract + rsync new code
# ---------------------------------------------------------------------------

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo
echo ">> Extracting ${ZIP_PATH}"
run "unzip -q '${ZIP_PATH}' -d '${TEMP_DIR}'"

EXTRACT_ROOT="$(find "${TEMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ ${DRY_RUN} -eq 0 ]]; then
    if [[ -z "${EXTRACT_ROOT}" || ! -f "${EXTRACT_ROOT}/docker-compose.yml" ]]; then
        echo "error: extracted tree doesn't look like a Maugood release" >&2
        exit 1
    fi
fi

echo
echo ">> Mirroring new code over the install dir (preserving operator-state)"

# Same exclude list as deploy-update.sh — operator-edited paths
# stay put; everything else mirrors. ops/certs/ stays excluded
# even though quick-start doesn't use it, in case the operator
# upgraded a quick-start install to HTTPS later.
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
# 4. Rebuild + restart only the services the manifest flagged
# ---------------------------------------------------------------------------

if [[ -n "${REBUILD_LIST}" ]]; then
    echo
    echo ">> Building ${REBUILD_LIST}"
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose build --progress=plain ${REBUILD_LIST}"
        else
            docker compose build --progress=plain ${REBUILD_LIST}
        fi
    )
fi

if [[ -n "${RESTART_LIST}" ]]; then
    echo
    echo ">> Starting ${RESTART_LIST}"
    (
        cd "${INSTALL_DIR}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] docker compose up -d ${RESTART_LIST}"
        else
            docker compose up -d ${RESTART_LIST} 2>&1 | tail -8
        fi
    )
else
    echo
    echo ">> No services to restart — the install code on disk now"
    echo "   reflects the new release, but no container needed a bounce."
fi

# ---------------------------------------------------------------------------
# 5. Health probe (frontend + backend only)
# ---------------------------------------------------------------------------

if [[ ${DRY_RUN} -eq 0 ]]; then
    # Pull the chosen backend port from .env so the probe targets
    # the right loopback address.
    BACKEND_PORT="$(
        grep -E '^MAUGOOD_BACKEND_HOST_PORT=' "${INSTALL_DIR}/.env" 2>/dev/null \
            | tail -1 | cut -d'=' -f2- | tr -d '"' || echo 8000
    )"
    [[ -z "${BACKEND_PORT}" ]] && BACKEND_PORT=8000

    echo
    echo ">> Probing http://localhost:${BACKEND_PORT}/api/health (up to 90s)"
    DEADLINE=$(( $(date +%s) + 90 ))
    while [[ $(date +%s) -lt ${DEADLINE} ]]; do
        if curl -s -m 5 "http://localhost:${BACKEND_PORT}/api/health" 2>/dev/null \
            | grep -q '"status":"ok"'; then
            echo "  ✓ backend healthy"
            break
        fi
        sleep 2
    done

    # Stamp version trail
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
echo "  Rebuilt      : ${REBUILD_LIST:-none}"
echo "  Restarted    : ${RESTART_LIST:-none}"
echo "  Backup       : ${BACKUP_DIR}.tar.gz"
SCRIPTS_LIST="$(python3 -c "import json,sys; print(' '.join(json.loads(sys.argv[1])['scripts']))" "${PLAN_JSON}")"
if [[ -n "${SCRIPTS_LIST}" ]]; then
    echo
    echo " Manual upgrade scripts shipped in this release:"
    for s in ${SCRIPTS_LIST}; do
        # backend/scripts/upgrade-1.2.0.py -> upgrade-1.2.0
        modname="$(basename "${s}" .py)"
        echo "   docker compose exec backend python -m scripts.${modname}"
    done
    echo
    echo " Run them in the order listed above. Each is idempotent."
fi
echo
echo "  If anything looks wrong:"
echo "    cd ${INSTALL_DIR}"
echo "    docker compose down"
echo "    tar -xzf ${BACKUP_DIR}.tar.gz -C ./backups"
echo "    cp -a backups/${TIMESTAMP}-pre-update/.env ./.env"
echo "    # then re-extract the previous release zip on top, and:"
echo "    docker compose up -d --build"
