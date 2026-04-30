#!/usr/bin/env bash
#
# clone-instance.sh — stand up a SECOND Maugood instance on the same
# machine, isolated from the first.
#
# Usage:
#   ./scripts/clone-instance.sh \
#       --source /opt/maugood \
#       --target /opt/maugood-acme \
#       --port-offset 100
#
#   ./scripts/clone-instance.sh \
#       --source ./maugood-v1.1.2 \
#       --target /opt/maugood-beta \
#       --port-offset 200 \
#       --project-name maugood-beta \
#       --no-start
#
# What it does:
#
# 1. Copies the source install to the target directory (operator
#    state included — they get a working baseline).
# 2. In the target's ``.env``, sets:
#      * MAUGOOD_POSTGRES_HOST_PORT  = 5432 + offset
#      * MAUGOOD_BACKEND_HOST_PORT   = 8000 + offset
#      * MAUGOOD_FRONTEND_HOST_PORT  = 5173 + offset
#      * MAUGOOD_NGINX_HTTP_HOST_PORT  = 80   + offset (only if prod)
#      * MAUGOOD_NGINX_HTTPS_HOST_PORT = 443  + offset (only if prod)
# 3. Writes a small ``maugood-instance.env`` next to .env that
#    captures the project name + offset for future runs (so
#    ``docker compose -p $(cat ./maugood-instance.env | grep PROJECT)``
#    is self-documenting).
# 4. Starts the new stack with ``docker compose -p <name> up -d``
#    unless --no-start is passed.
#
# Each instance is fully isolated:
#   * Compose project name is unique → containers / networks /
#     volumes are all prefixed with the project name and don't
#     collide.
#   * Host ports are different → no port-binding conflicts.
#   * Postgres data lives in the per-project named volume
#     ``<project>-postgres_data``, so each instance has its own DB
#     state.
#   * Face crops + attachments + reports live in the per-project
#     ``faces_data`` volume, isolated similarly.
#
# Limitations / things to know:
#   * Each instance still hits the same host CPU/RAM/disk. Plan
#     accordingly — two instances doing live capture will halve the
#     headroom each one has.
#   * If you're using the ``prod`` overlay (nginx + TLS), each
#     instance needs its own cert in ``ops/certs/`` — they can't
#     share a cert because the SNI hostname differs.
#   * Backups (``scripts/backup.sh``) and the update applier
#     (``scripts/deploy-update.sh``) are scoped to one install dir
#     each — run them per instance.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

SOURCE=""
TARGET=""
PORT_OFFSET=""
PROJECT_NAME=""
DO_START=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)         SOURCE="$2"; shift 2 ;;
        --target)         TARGET="$2"; shift 2 ;;
        --port-offset)    PORT_OFFSET="$2"; shift 2 ;;
        --project-name)   PROJECT_NAME="$2"; shift 2 ;;
        --no-start)       DO_START=0; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '3,55p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

if [[ -z "${SOURCE}" || -z "${TARGET}" || -z "${PORT_OFFSET}" ]]; then
    echo "error: --source, --target, and --port-offset are all required" >&2
    echo "       try ``$0 --help``" >&2
    exit 2
fi

if [[ ! "${PORT_OFFSET}" =~ ^[0-9]+$ ]]; then
    echo "error: --port-offset must be a positive integer" >&2
    exit 2
fi

if [[ ! -d "${SOURCE}" ]]; then
    echo "error: source dir not found at '${SOURCE}'" >&2
    exit 1
fi

if [[ ! -f "${SOURCE}/docker-compose.yml" ]]; then
    echo "error: '${SOURCE}' doesn't look like a Maugood install" >&2
    exit 1
fi

if [[ -e "${TARGET}" ]]; then
    echo "error: target already exists at '${TARGET}'" >&2
    echo "       refuse to overwrite — pick a fresh path or remove it first." >&2
    exit 1
fi

# Project name defaults to the basename of the target dir.
if [[ -z "${PROJECT_NAME}" ]]; then
    PROJECT_NAME="$(basename "${TARGET}")"
fi
# Sanitise — compose project names must be lowercase letters, digits,
# hyphens, underscores; and start with a letter or digit.
if ! [[ "${PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "error: project name '${PROJECT_NAME}' is not a valid compose name" >&2
    echo "       (must match ^[a-z0-9][a-z0-9_-]*\$)" >&2
    exit 2
fi

POSTGRES_PORT=$(( 5432 + PORT_OFFSET ))
BACKEND_PORT=$(( 8000 + PORT_OFFSET ))
FRONTEND_PORT=$(( 5173 + PORT_OFFSET ))
NGINX_HTTP_PORT=$(( 80 + PORT_OFFSET ))
NGINX_HTTPS_PORT=$(( 443 + PORT_OFFSET ))

echo "================================================================"
echo " Maugood instance cloner"
echo "================================================================"
echo " source dir       : ${SOURCE}"
echo " target dir       : ${TARGET}"
echo " project name     : ${PROJECT_NAME}"
echo " port offset      : +${PORT_OFFSET}"
echo "   postgres       : ${POSTGRES_PORT}"
echo "   backend        : ${BACKEND_PORT}"
echo "   frontend       : ${FRONTEND_PORT}"
echo "   nginx http     : ${NGINX_HTTP_PORT}"
echo "   nginx https    : ${NGINX_HTTPS_PORT}"
echo " start after copy : $([[ ${DO_START} -eq 1 ]] && echo yes || echo NO --no-start)"
echo " dry run          : $([[ ${DRY_RUN} -eq 1 ]] && echo yes || echo no)"
echo "================================================================"

run() {
    if [[ ${DRY_RUN} -eq 1 ]]; then
        echo "[dry-run] $*"
    else
        echo "+ $*"
        eval "$@"
    fi
}

# ---------------------------------------------------------------------------
# 1. Copy the source install to the target dir
# ---------------------------------------------------------------------------

echo
echo ">> Copying source → target"
# Excludes match the deploy-update.sh exclusion set + a few extras
# (the cloned instance gets its OWN postgres volume from scratch, OWN
# faces volume, OWN backups).
run "rsync -ah \
    --exclude='backend/logs/' \
    --exclude='backups/' \
    --exclude='dist/' \
    --exclude='data/' \
    --exclude='backend/data/' \
    --exclude='frontend/node_modules/' \
    --exclude='frontend/dist/' \
    --exclude='.git/' \
    --exclude='credentials.txt' \
    '${SOURCE}/' '${TARGET}/'"

# ---------------------------------------------------------------------------
# 2. Write the port overrides into the target's .env
# ---------------------------------------------------------------------------

ENV_FILE="${TARGET}/.env"

echo
echo ">> Configuring ${ENV_FILE}"

if [[ ! -f "${ENV_FILE}" ]]; then
    if [[ -f "${TARGET}/.env.example" ]]; then
        run "cp '${TARGET}/.env.example' '${ENV_FILE}'"
    elif [[ ${DRY_RUN} -eq 1 ]]; then
        # In dry-run we never actually copied source → target, so
        # neither file exists. Print what we'd do and skip the
        # existence check.
        echo "[dry-run] (would copy ${SOURCE}/.env.example to ${ENV_FILE})"
    else
        echo "error: no .env or .env.example in target — refusing to continue" >&2
        exit 1
    fi
fi

# Strip any existing port overrides (commented or active) and append
# the new ones. ``perl -i -ne`` keeps non-matching lines verbatim.
run "perl -i -ne 'print unless /^#?\s*MAUGOOD_(POSTGRES|BACKEND|FRONTEND|NGINX_(HTTP|HTTPS))_HOST_PORT=/' '${ENV_FILE}'"

run "cat >> '${ENV_FILE}' <<EOF

# --- Per-instance host ports (set by clone-instance.sh) ---
MAUGOOD_POSTGRES_HOST_PORT=${POSTGRES_PORT}
MAUGOOD_BACKEND_HOST_PORT=${BACKEND_PORT}
MAUGOOD_FRONTEND_HOST_PORT=${FRONTEND_PORT}
MAUGOOD_NGINX_HTTP_HOST_PORT=${NGINX_HTTP_PORT}
MAUGOOD_NGINX_HTTPS_HOST_PORT=${NGINX_HTTPS_PORT}
EOF"

# ---------------------------------------------------------------------------
# 3. Drop a self-documenting marker file so future ``docker compose``
#    invocations from this dir know which project name to use
# ---------------------------------------------------------------------------

run "cat > '${TARGET}/maugood-instance.env' <<EOF
# Set by clone-instance.sh so this directory remembers its identity.
# Source it before running docker compose:
#     set -a; source ./maugood-instance.env; set +a
#     docker compose -p \"\${COMPOSE_PROJECT_NAME}\" up -d
# OR pass -p explicitly:
#     docker compose -p ${PROJECT_NAME} up -d
COMPOSE_PROJECT_NAME=${PROJECT_NAME}
EOF"

# ---------------------------------------------------------------------------
# 4. Start the new stack
# ---------------------------------------------------------------------------

if [[ ${DO_START} -eq 1 ]]; then
    echo
    echo ">> Starting the new instance"
    (
        cd "${TARGET}"
        if [[ ${DRY_RUN} -eq 1 ]]; then
            echo "[dry-run] cd ${TARGET} && docker compose -p ${PROJECT_NAME} up -d --build"
        else
            docker compose -p "${PROJECT_NAME}" up -d --build 2>&1 | tail -10
        fi
    )
fi

echo
echo "================================================================"
echo " ✓ Instance cloned"
echo "================================================================"
echo "  Target dir       : ${TARGET}"
echo "  Project name     : ${PROJECT_NAME}"
echo "  Postgres port    : ${POSTGRES_PORT}"
echo "  Backend port     : ${BACKEND_PORT}"
echo "  Frontend port    : ${FRONTEND_PORT}"
echo "  Nginx http/https : ${NGINX_HTTP_PORT}/${NGINX_HTTPS_PORT}"
echo
echo "  Day-2 ops on this instance — always pass -p:"
echo "    cd ${TARGET}"
echo "    docker compose -p ${PROJECT_NAME} ps"
echo "    docker compose -p ${PROJECT_NAME} logs -f"
echo "    docker compose -p ${PROJECT_NAME} down"
echo
echo "  Or source the marker file once per shell:"
echo "    set -a; source ./maugood-instance.env; set +a"
echo "    docker compose ps     # picks up COMPOSE_PROJECT_NAME"
