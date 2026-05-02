#!/usr/bin/env bash
#
# quick-start.sh — single-tenant localhost install.
#
# What this is:
#   A lighter-weight alternative to local-setup-wizard.sh. Drops every
#   production-style piece (HTTPS, nginx reverse proxy, self-signed
#   cert, /etc/hosts edit, Prometheus, Alertmanager, Grafana, Super-
#   Admin console) and just brings up three containers:
#
#     postgres  -> port you pick (default 5432, loopback)
#     backend   -> port you pick (default 8000)
#     frontend  -> port you pick (default 5173, Vite dev server)
#
#   Single-tenant mode (MAUGOOD_TENANT_MODE=single): everything lands
#   in the seeded ``main`` tenant (tenant_id=1). One Admin user gets
#   seeded with the password you type. After it's up you visit
#   ``http://localhost:5173`` (or whatever frontend port you picked)
#   and log in — no domain, no certs, no Tenant slug field needed.
#
# How to use:
#   1. Extract the release zip to a directory.
#   2. cd into that directory (the one with docker-compose.yml).
#   3. ./scripts/quick-start.sh
#
# Re-run safety:
#   * ``--reuse``  — skip secret generation; reuse existing .env.
#                    Useful for "just start the stack again."
#   * ``--reset``  — wipe ./data/* and ./.env, then prompt fresh.
#                    Destructive — confirms with RESET to proceed.
#
# Non-interactive (CI / automation):
#   --non-interactive --tenant-name "Trial" --admin-email a@x \
#     --admin-name "A" --admin-password "Welcome@12345"

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

INTERACTIVE=1
RESET=0
REUSE=0
TENANT_NAME=""
ADMIN_EMAIL=""
ADMIN_NAME=""
ADMIN_PASSWORD=""
PORT_POSTGRES=""
PORT_BACKEND=""
PORT_FRONTEND=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --non-interactive)   INTERACTIVE=0; shift ;;
        --reset)             RESET=1; shift ;;
        --reuse)             REUSE=1; shift ;;
        --tenant-name)       TENANT_NAME="$2"; shift 2 ;;
        --admin-email)       ADMIN_EMAIL="$2"; shift 2 ;;
        --admin-name)        ADMIN_NAME="$2"; shift 2 ;;
        --admin-password)    ADMIN_PASSWORD="$2"; shift 2 ;;
        --port-postgres)     PORT_POSTGRES="$2"; shift 2 ;;
        --port-backend)      PORT_BACKEND="$2"; shift 2 ;;
        --port-frontend)     PORT_FRONTEND="$2"; shift 2 ;;
        -h|--help)
            sed -n '3,35p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Working dir + pre-flight
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ ! -f docker-compose.yml ]]; then
    echo "error: not in a Maugood install root" >&2
    echo "       (no docker-compose.yml here — extract the zip first)" >&2
    exit 1
fi

# Required tooling. Fail fast with a useful message instead of letting
# the operator hit a broken pipe halfway through.
for cmd in docker python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

prompt() {
    # prompt VARNAME "Question text" ["default"]
    local _var="$1" _q="$2" _default="${3:-}" _ans
    if [[ ${INTERACTIVE} -eq 0 ]]; then
        if [[ -z "${!_var:-}" && -n "${_default}" ]]; then
            printf -v "${_var}" '%s' "${_default}"
        fi
        return
    fi
    if [[ -n "${!_var:-}" ]]; then
        return  # already set via flag
    fi
    if [[ -n "${_default}" ]]; then
        read -r -p "  ${_q} [${_default}]: " _ans
        printf -v "${_var}" '%s' "${_ans:-${_default}}"
    else
        while [[ -z "${!_var:-}" ]]; do
            read -r -p "  ${_q}: " _ans
            printf -v "${_var}" '%s' "${_ans}"
        done
    fi
}

prompt_password() {
    local _var="$1" _q="$2" _ans1 _ans2
    if [[ ${INTERACTIVE} -eq 0 ]]; then
        if [[ -z "${!_var:-}" ]]; then
            echo "error: password required (pass --admin-password)" >&2
            exit 2
        fi
        return
    fi
    if [[ -n "${!_var:-}" ]]; then
        return
    fi
    while true; do
        read -r -s -p "  ${_q} (≥12 chars): " _ans1; echo
        if [[ ${#_ans1} -lt 12 ]]; then
            echo "  too short — try again."
            continue
        fi
        read -r -s -p "  Confirm: " _ans2; echo
        if [[ "${_ans1}" != "${_ans2}" ]]; then
            echo "  passwords don't match — try again."
            continue
        fi
        printf -v "${_var}" '%s' "${_ans1}"
        break
    done
}

genstr()    { python3 -c "import secrets; print(secrets.token_urlsafe($1))"; }
genfernet() { python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"; }

# Probe a port and return the first free one from the candidate list.
# Same shape as local-setup-wizard.sh's port_default helper.
suggest_port() {
    python3 - "$@" <<'PY'
import socket, sys
for port in (int(p) for p in sys.argv[1:]):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    try:
        s.bind(("0.0.0.0", port))
    except OSError:
        s.close()
        continue
    s.close()
    print(port)
    sys.exit(0)
print(sys.argv[1] if len(sys.argv) > 1 else "")
PY
}

port_default() {
    local _default="$1"
    local _picked
    _picked="$(suggest_port "$@")"
    if [[ "${_picked}" != "${_default}" ]]; then
        echo "  note: port ${_default} is in use — suggesting ${_picked}" >&2
    fi
    echo "${_picked}"
}

# ---------------------------------------------------------------------------
# 0. --reset wipes data + .env
# ---------------------------------------------------------------------------

if [[ ${RESET} -eq 1 ]]; then
    echo
    echo "RESET MODE — this wipes ./data/* and ./.env"
    if [[ ${INTERACTIVE} -eq 1 ]]; then
        read -r -p "  Type RESET to confirm: " confirm
        if [[ "${confirm}" != "RESET" ]]; then
            echo "  aborted."
            exit 1
        fi
    fi
    docker compose down -v 2>/dev/null || true
    rm -rf data/postgres data/faces data/insightface_models
    rm -f .env backend/.env frontend/.env
    echo "  reset complete."
fi

# ---------------------------------------------------------------------------
# 1. Prompts
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    echo
    echo "================================================================"
    echo " Maugood — quick-start (single-tenant, localhost only)"
    echo "================================================================"
    echo

    echo "Tenant + first Admin"
    prompt TENANT_NAME       "Corporate display name (shown in the sidebar)" "My Organisation"
    prompt ADMIN_EMAIL       "Admin email" "admin@local.test"
    prompt ADMIN_NAME        "Admin full name" "Admin"
    prompt_password ADMIN_PASSWORD "Admin password"

    echo
    echo "Host ports"
    echo "  Press Enter to accept the defaults; the script auto-suggests"
    echo "  free alternatives if a default is already taken."
    if [[ -z "${PORT_POSTGRES}" ]]; then
        PORT_POSTGRES="$(port_default 5432 5433 15432 15433 54320)"
    fi
    if [[ -z "${PORT_BACKEND}" ]]; then
        PORT_BACKEND="$(port_default 8000 8001 8080 18000 28000)"
    fi
    if [[ -z "${PORT_FRONTEND}" ]]; then
        PORT_FRONTEND="$(port_default 5173 5174 5175 15173 25173)"
    fi
    prompt PORT_POSTGRES "Postgres" "${PORT_POSTGRES}"
    prompt PORT_BACKEND  "Backend"  "${PORT_BACKEND}"
    prompt PORT_FRONTEND "Frontend" "${PORT_FRONTEND}"

    # Validate every port: 1-65535. Catch typos before docker compose
    # bombs with a confusing yaml error.
    for _name in PORT_POSTGRES PORT_BACKEND PORT_FRONTEND; do
        _val="${!_name}"
        if ! [[ "${_val}" =~ ^[0-9]+$ ]] || (( _val < 1 || _val > 65535 )); then
            echo "error: ${_name}='${_val}' is not a valid port (1-65535)" >&2
            exit 2
        fi
    done
fi

# ---------------------------------------------------------------------------
# 2. Generate secrets + write .env
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    echo
    echo ">> Generating secrets"
    SESSION_SECRET="$(genstr 48)"
    FERNET_KEY="$(genfernet)"
    AUTH_FERNET_KEY="$(genfernet)"
    REPORT_SIGNED_URL_SECRET="$(genstr 48)"
    APP_DB_PASSWORD="$(genstr 24)"
    ADMIN_DB_PASSWORD="$(genstr 24)"

    echo ">> Writing .env"
    cat > .env <<EOF
# Generated by quick-start.sh on $(date +%Y-%m-%d)
# DO NOT commit. Re-run with --reuse to keep these.

# DB role passwords + URLs (the password in the URL must match the
# DB password — quick-start keeps them in lockstep).
MAUGOOD_DATABASE_URL=postgresql+psycopg://maugood_app:${APP_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_ADMIN_DATABASE_URL=postgresql+psycopg://maugood:${ADMIN_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_APP_DB_PASSWORD=${APP_DB_PASSWORD}
MAUGOOD_ADMIN_DB_PASSWORD=${ADMIN_DB_PASSWORD}

# Secrets
MAUGOOD_SESSION_SECRET=${SESSION_SECRET}
MAUGOOD_FERNET_KEY=${FERNET_KEY}
MAUGOOD_AUTH_FERNET_KEY=${AUTH_FERNET_KEY}
MAUGOOD_REPORT_SIGNED_URL_SECRET=${REPORT_SIGNED_URL_SECRET}

# Single-tenant, dev mode. No HTTPS, no behind-proxy, no production
# guards. localhost-only. The sidebar brand row reads the tenant
# name we set below; the cookies are NOT marked Secure so they
# work over plain http://localhost.
MAUGOOD_ENV=dev
MAUGOOD_TENANT_MODE=single
MAUGOOD_SESSION_COOKIE_SECURE=false
MAUGOOD_ALLOWED_ORIGINS=http://localhost:${PORT_FRONTEND}

# Host ports
MAUGOOD_POSTGRES_HOST_PORT=${PORT_POSTGRES}
MAUGOOD_BACKEND_HOST_PORT=${PORT_BACKEND}
MAUGOOD_FRONTEND_HOST_PORT=${PORT_FRONTEND}
EOF

    # Mirror the relevant subset of the root .env into backend/.env so
    # pytest from the host (outside docker compose) sees the same
    # values.
    echo ">> Writing backend/.env"
    cat > backend/.env <<EOF
MAUGOOD_DATABASE_URL=postgresql+psycopg://maugood_app:${APP_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_ADMIN_DATABASE_URL=postgresql+psycopg://maugood:${ADMIN_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_APP_DB_PASSWORD=${APP_DB_PASSWORD}
MAUGOOD_ADMIN_DB_PASSWORD=${ADMIN_DB_PASSWORD}
MAUGOOD_SESSION_SECRET=${SESSION_SECRET}
MAUGOOD_FERNET_KEY=${FERNET_KEY}
MAUGOOD_AUTH_FERNET_KEY=${AUTH_FERNET_KEY}
MAUGOOD_ENV=dev
MAUGOOD_TENANT_MODE=single
EOF

    echo ">> Writing frontend/.env"
    cat > frontend/.env <<EOF
# Same-origin in dev — Vite proxies /api/* to the backend service.
VITE_API_BASE_URL=http://localhost:${PORT_BACKEND}/api
EOF
fi

# ---------------------------------------------------------------------------
# 3. Bring up postgres + backend + frontend
# ---------------------------------------------------------------------------

echo
echo ">> Building images (first run pulls bases + builds — typically 3–5 min)"
echo "   Streaming docker output below; cancel with Ctrl-C if it stalls."
echo
# ``--progress=plain`` prints every layer step live instead of the
# TTY-redraw mode that hides scrollback through pipes.
docker compose build --progress=plain postgres backend frontend
echo
echo ">> Starting containers (postgres + backend + frontend)"
docker compose up -d postgres backend frontend

# ---------------------------------------------------------------------------
# 4. Wait for backend health
# ---------------------------------------------------------------------------

echo
echo ">> Waiting for backend to be healthy"
DEADLINE=$(( $(date +%s) + 180 ))
while [[ $(date +%s) -lt ${DEADLINE} ]]; do
    if curl -s -m 5 "http://localhost:${PORT_BACKEND}/api/health" 2>/dev/null \
        | grep -q '"status":"ok"'; then
        echo "  ✓ backend healthy"
        break
    fi
    sleep 3
done

# ---------------------------------------------------------------------------
# 5. Seed Admin (single-tenant: lands in tenant_id=1, the ``main`` schema)
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    echo
    echo ">> Seeding Admin (${ADMIN_EMAIL}) and renaming the default tenant"
    docker compose exec -T \
        -e MAUGOOD_SEED_PASSWORD="${ADMIN_PASSWORD}" \
        backend \
        python -m scripts.seed_admin \
            --email "${ADMIN_EMAIL}" \
            --full-name "${ADMIN_NAME}" \
            --tenant-name "${TENANT_NAME}" 2>&1 | tail -3
fi

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------

VERSION="?"
if [[ -f frontend/package.json ]]; then
    VERSION="v$(python3 -c "
import json, pathlib
p = pathlib.Path('frontend/package.json')
print(json.loads(p.read_text()).get('version', '?'))
")"
fi

echo
echo "================================================================"
echo " ✓ Maugood ${VERSION} is running (single-tenant, localhost)"
echo "================================================================"
echo
echo " Open in your browser:"
echo "   http://localhost:${PORT_FRONTEND}/"
echo
echo " Log in:"
echo "   Email     : ${ADMIN_EMAIL}"
echo "   Password  : ${ADMIN_PASSWORD:-<from --admin-password>}"
echo "   (No tenant slug — single-tenant mode skips that field.)"
echo
echo " Direct (debug) access:"
echo "   Backend API : http://localhost:${PORT_BACKEND}/api/health"
echo "   Postgres    : localhost:${PORT_POSTGRES}  (see backend/.env for the URL)"
echo
echo " Stop the stack:"
echo "   docker compose down"
echo
echo " Re-run later with the same secrets:"
echo "   ./scripts/quick-start.sh --reuse"
echo
echo " Reset everything (wipes data + .env):"
echo "   ./scripts/quick-start.sh --reset"
echo
echo " Save the password — quick-start does NOT write a credentials file."
echo "================================================================"
