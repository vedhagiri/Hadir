#!/usr/bin/env bash
#
# local-setup-wizard.sh — interactive setup for a local HTTPS Maugood
# install on a developer or pilot machine.
#
# What it does:
#
#   1. Prompts for the local domain name (e.g. ``maugood.local``).
#   2. Prompts for the first tenant's slug, display name, Admin
#      email, Admin name, Admin password.
#   3. Generates seven secrets (session, two Fernet keys, signed-URL,
#      grafana, two DB role passwords) using stdlib python — no pip
#      install needed.
#   4. Writes ``.env``, ``backend/.env``, ``frontend/.env`` with all
#      the values wired up consistently (the password in
#      MAUGOOD_ADMIN_DB_PASSWORD matches the password embedded in
#      MAUGOOD_ADMIN_DATABASE_URL — the lockstep contract).
#   5. Generates a self-signed cert for the chosen domain and writes
#      it to ``ops/certs/fullchain.pem`` + ``ops/certs/privkey.pem``.
#   6. Adds an entry to /etc/hosts (with sudo) so the host machine
#      resolves the domain to 127.0.0.1.
#   7. Stamps ``./VERSION`` from frontend/package.json so an
#      operator can ``cat VERSION`` to know what's installed.
#   8. Brings up the stack: ``docker compose -f
#      docker-compose-https-local.yaml up -d --build``.
#   9. Seeds the Super-Admin and provisions the first tenant.
#  10. Prints a summary card with every URL, login, and password.
#
# Usage:
#   ./scripts/local-setup-wizard.sh
#   ./scripts/local-setup-wizard.sh --non-interactive \
#       --domain maugood.local \
#       --tenant-slug acme \
#       --tenant-name "Acme Corp" \
#       --admin-email admin@acme.example.com \
#       --admin-name "Jane Operator" \
#       --admin-password "SuperStrongPwd#1"
#
# Re-run safety: writing .env / certs is non-destructive when the
# stack is already up — pass ``--reuse`` to skip secret generation
# + cert regeneration and just bring up the stack with the existing
# .env. Use ``--reset`` to nuke the data dir and start over fresh.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

INTERACTIVE=1
RESET=0
REUSE=0
DOMAIN=""
TENANT_SLUG=""
TENANT_NAME=""
ADMIN_EMAIL=""
ADMIN_NAME=""
ADMIN_PASSWORD=""
SUPERADMIN_EMAIL="superadmin@mts-staff.example.com"
SUPERADMIN_NAME="MTS Super Admin"
# Host port mappings — empty defaults so the prompt section can offer
# the canonical values (or whatever was passed via flags). The
# compose file already reads these via ``${VAR:-fallback}`` so the
# fallback inside the YAML is the safety net if .env doesn't carry
# them. Same env-var names as the compose, set in .env below.
PORT_HTTPS=""
PORT_HTTP=""
PORT_POSTGRES=""
PORT_GRAFANA=""
PORT_PROMETHEUS=""
PORT_ALERTMANAGER=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --non-interactive)   INTERACTIVE=0; shift ;;
        --reset)             RESET=1; shift ;;
        --reuse)             REUSE=1; shift ;;
        --domain)            DOMAIN="$2"; shift 2 ;;
        --tenant-slug)       TENANT_SLUG="$2"; shift 2 ;;
        --tenant-name)       TENANT_NAME="$2"; shift 2 ;;
        --admin-email)       ADMIN_EMAIL="$2"; shift 2 ;;
        --admin-name)        ADMIN_NAME="$2"; shift 2 ;;
        --admin-password)    ADMIN_PASSWORD="$2"; shift 2 ;;
        --superadmin-email)  SUPERADMIN_EMAIL="$2"; shift 2 ;;
        --superadmin-name)   SUPERADMIN_NAME="$2"; shift 2 ;;
        --port-https)        PORT_HTTPS="$2"; shift 2 ;;
        --port-http)         PORT_HTTP="$2"; shift 2 ;;
        --port-postgres)     PORT_POSTGRES="$2"; shift 2 ;;
        --port-grafana)      PORT_GRAFANA="$2"; shift 2 ;;
        --port-prometheus)   PORT_PROMETHEUS="$2"; shift 2 ;;
        --port-alertmanager) PORT_ALERTMANAGER="$2"; shift 2 ;;
        -h|--help)
            sed -n '3,40p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Working dir
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ ! -f docker-compose-https-local.yaml ]]; then
    echo "error: not in the maugood install root" >&2
    echo "       (no docker-compose-https-local.yaml here)" >&2
    exit 1
fi

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
            echo "error: password required (passed via --admin-password)" >&2
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

genstr() {
    # genstr <bytes> — base64-url-safe random string
    python3 -c "import secrets; print(secrets.token_urlsafe($1))"
}

genfernet() {
    python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
}

genpwd() {
    python3 -c "
import secrets, string
chars = string.ascii_letters + string.digits + '!#%&'
print(''.join(secrets.choice(chars) for _ in range($1)))
"
}

# ---------------------------------------------------------------------------
# 0. --reset wipes data + .env (with confirmation)
# ---------------------------------------------------------------------------

if [[ ${RESET} -eq 1 ]]; then
    echo
    echo "RESET MODE — this wipes ./data/*, ops/certs/*.pem, .env, backend/.env, frontend/.env"
    if [[ ${INTERACTIVE} -eq 1 ]]; then
        read -r -p "  Type RESET to confirm: " confirm
        if [[ "${confirm}" != "RESET" ]]; then
            echo "  aborted."
            exit 1
        fi
    fi
    docker compose -f docker-compose-https-local.yaml down -v 2>/dev/null || true
    rm -rf data/postgres data/faces data/insightface_models \
           data/prometheus data/alertmanager data/grafana data/logs
    rm -f .env backend/.env frontend/.env
    rm -f ops/certs/fullchain.pem ops/certs/privkey.pem
    echo "  reset complete."
fi

# ---------------------------------------------------------------------------
# 1. Prompts
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    echo
    echo "================================================================"
    echo " Maugood — local HTTPS setup wizard"
    echo "================================================================"
    echo

    echo "Domain"
    prompt DOMAIN "Local domain name (added to /etc/hosts)" "maugood.local"

    echo
    echo "First tenant"
    prompt TENANT_SLUG       "Tenant slug (lowercase, e.g. 'acme')" "acme"
    prompt TENANT_NAME       "Tenant display name (e.g. 'Acme Corp')" "Acme Corp"
    prompt ADMIN_EMAIL       "First Admin email" "admin@${TENANT_SLUG}.example.com"
    prompt ADMIN_NAME        "First Admin full name" "Tenant Admin"
    prompt_password ADMIN_PASSWORD "First Admin password"

    # Slug shape check.
    if ! [[ "${TENANT_SLUG}" =~ ^[a-z][a-z0-9_-]{1,39}$ ]]; then
        echo "error: tenant slug must match ^[a-z][a-z0-9_-]{1,39}\$" >&2
        exit 2
    fi

    echo
    echo "Host ports"
    echo "  Press Enter to accept the defaults; pick custom values if"
    echo "  you're running another stack on the same host. Postgres /"
    echo "  Prometheus / Alertmanager bind to 127.0.0.1 only — they're"
    echo "  not reachable from the LAN."
    prompt PORT_HTTPS        "HTTPS (browser → nginx)"        "443"
    prompt PORT_HTTP         "HTTP (redirect → HTTPS)"        "80"
    prompt PORT_POSTGRES     "Postgres (loopback)"            "5432"
    prompt PORT_GRAFANA      "Grafana"                        "3000"
    prompt PORT_PROMETHEUS   "Prometheus (loopback)"          "9090"
    prompt PORT_ALERTMANAGER "Alertmanager (loopback)"        "9093"

    # Validate every port: 1-65535. Catch typos before docker compose
    # bombs with a confusing yaml error.
    for _name in PORT_HTTPS PORT_HTTP PORT_POSTGRES PORT_GRAFANA \
                 PORT_PROMETHEUS PORT_ALERTMANAGER; do
        _val="${!_name}"
        if ! [[ "${_val}" =~ ^[0-9]+$ ]] || (( _val < 1 || _val > 65535 )); then
            echo "error: ${_name}='${_val}' is not a valid port (1-65535)" >&2
            exit 2
        fi
    done

    if (( PORT_HTTPS < 1024 || PORT_HTTP < 1024 )) \
       && [[ "$(id -u)" != "0" ]]; then
        echo
        echo "  note: ports below 1024 (HTTP / HTTPS) need root or"
        echo "        CAP_NET_BIND_SERVICE on the docker daemon. Docker"
        echo "        Desktop handles this transparently; on a bare"
        echo "        Linux host you may need to pick higher ports or"
        echo "        run docker as root."
    fi
fi

# ---------------------------------------------------------------------------
# 2. Generate secrets + write env files
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
    GRAFANA_ADMIN_PASSWORD="$(genpwd 20)"

    echo ">> Writing .env (root)"
    cat > .env <<EOF
# Generated by local-setup-wizard.sh on $(date +%Y-%m-%d)
# DO NOT commit. Re-run the wizard with --reuse to keep these.

# DB role passwords + URLs (the password in the URL must match the
# DB password — the wizard keeps them in lockstep).
MAUGOOD_DATABASE_URL=postgresql+psycopg://maugood_app:${APP_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_ADMIN_DATABASE_URL=postgresql+psycopg://maugood:${ADMIN_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_APP_DB_PASSWORD=${APP_DB_PASSWORD}
MAUGOOD_ADMIN_DB_PASSWORD=${ADMIN_DB_PASSWORD}

# Secrets
MAUGOOD_SESSION_SECRET=${SESSION_SECRET}
MAUGOOD_FERNET_KEY=${FERNET_KEY}
MAUGOOD_AUTH_FERNET_KEY=${AUTH_FERNET_KEY}
MAUGOOD_REPORT_SIGNED_URL_SECRET=${REPORT_SIGNED_URL_SECRET}

# Production-grade hardening (this is a local install but it
# behaves identically to the customer-facing prod stack).
MAUGOOD_ENV=production
MAUGOOD_TENANT_MODE=multi
MAUGOOD_BEHIND_PROXY=true
MAUGOOD_SESSION_COOKIE_SECURE=true
MAUGOOD_FORWARDED_ALLOW_IPS=*
MAUGOOD_HSTS_MAX_AGE_SECONDS=31536000

# Public-facing config
MAUGOOD_PUBLIC_HOSTNAME=${DOMAIN}
MAUGOOD_ALLOWED_ORIGINS=https://${DOMAIN}
MAUGOOD_OIDC_REDIRECT_BASE_URL=https://${DOMAIN}

# Host ports — picked by the wizard, read by docker-compose.
# Override later by editing .env and running ``docker compose up -d``.
MAUGOOD_NGINX_HTTPS_HOST_PORT=${PORT_HTTPS}
MAUGOOD_NGINX_HTTP_HOST_PORT=${PORT_HTTP}
MAUGOOD_POSTGRES_HOST_PORT=${PORT_POSTGRES}
MAUGOOD_GRAFANA_HOST_PORT=${PORT_GRAFANA}
MAUGOOD_PROMETHEUS_HOST_PORT=${PORT_PROMETHEUS}
MAUGOOD_ALERTMANAGER_HOST_PORT=${PORT_ALERTMANAGER}

# Grafana
MAUGOOD_GRAFANA_ADMIN_USER=admin
MAUGOOD_GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
MAUGOOD_GRAFANA_ROOT_URL=http://localhost:${PORT_GRAFANA}
EOF

    echo ">> Writing backend/.env"
    cat > backend/.env <<EOF
# Mirrors the relevant subset of the root .env so the backend's
# pydantic-settings loader can find the values when run outside
# docker compose (pytest from the host, etc.).
MAUGOOD_DATABASE_URL=postgresql+psycopg://maugood_app:${APP_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_ADMIN_DATABASE_URL=postgresql+psycopg://maugood:${ADMIN_DB_PASSWORD}@postgres:5432/maugood
MAUGOOD_APP_DB_PASSWORD=${APP_DB_PASSWORD}
MAUGOOD_ADMIN_DB_PASSWORD=${ADMIN_DB_PASSWORD}
MAUGOOD_SESSION_SECRET=${SESSION_SECRET}
MAUGOOD_FERNET_KEY=${FERNET_KEY}
MAUGOOD_AUTH_FERNET_KEY=${AUTH_FERNET_KEY}
MAUGOOD_ENV=production
MAUGOOD_TENANT_MODE=multi
EOF

    echo ">> Writing frontend/.env"
    cat > frontend/.env <<EOF
# The frontend production bundle is built by the nginx Dockerfile
# (vite build). The dev server reads VITE_API_BASE_URL; for the
# https-local stack the URL is the same origin so no override is
# strictly needed. Kept for parity + dev-server fallback.
VITE_API_BASE_URL=https://${DOMAIN}/api
EOF
fi

# ---------------------------------------------------------------------------
# 3. Self-signed cert for the chosen domain
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    echo
    echo ">> Generating self-signed TLS cert for ${DOMAIN}"
    mkdir -p ops/certs
    if [[ -f ops/certs/fullchain.pem && -f ops/certs/privkey.pem && ${RESET} -eq 0 ]]; then
        echo "  (cert already present, leaving as-is — pass --reset to regenerate)"
    else
        openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
            -keyout ops/certs/privkey.pem \
            -out ops/certs/fullchain.pem \
            -subj "/CN=${DOMAIN}/O=Maugood Local" \
            -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1" \
            2>/dev/null
        chmod 0640 ops/certs/*.pem
        echo "  cert valid 730 days"
    fi
fi

# ---------------------------------------------------------------------------
# 4. /etc/hosts entry
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 && -n "${DOMAIN}" ]]; then
    echo
    if grep -qE "^[^#]*\s${DOMAIN}\b" /etc/hosts 2>/dev/null; then
        echo ">> /etc/hosts already has an entry for ${DOMAIN} — leaving it alone"
    else
        echo ">> Adding 127.0.0.1 ${DOMAIN} to /etc/hosts (needs sudo)"
        echo "127.0.0.1 ${DOMAIN}" | sudo tee -a /etc/hosts >/dev/null
        echo "  done"
    fi
fi

# ---------------------------------------------------------------------------
# 5. VERSION stamp
# ---------------------------------------------------------------------------

VERSION="?"
if [[ -f frontend/package.json ]]; then
    VERSION="v$(python3 -c "
import json, pathlib
p = pathlib.Path('frontend/package.json')
print(json.loads(p.read_text()).get('version', '?'))
")"
fi
echo "${VERSION}" > VERSION
echo "${VERSION} installed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > .version-history.log

# ---------------------------------------------------------------------------
# 6. Bring up the stack
# ---------------------------------------------------------------------------

echo
echo ">> Building images (first run pulls bases + builds — typically 3–5 min)"
echo "   Streaming docker output below; cancel with Ctrl-C if it stalls."
echo
# Build first, with plain progress output so every layer + step is
# visible. ``--progress=plain`` overrides the default TTY redraw —
# the redraw mode hides scrollback and (worse) silently buffers
# output through pipes / log captures, which is what made the
# previous ``| tail -8`` look like nothing was happening.
docker compose -f docker-compose-https-local.yaml build --progress=plain
echo
echo ">> Starting containers"
docker compose -f docker-compose-https-local.yaml up -d

echo
echo ">> Waiting for backend to be healthy"
# The probe URL must include the operator-picked HTTPS port — without
# it, a custom port (e.g. 8443) would 404 because the host browser
# would never reach the nginx container.
_probe_suffix=""
if [[ "${PORT_HTTPS}" != "443" ]]; then _probe_suffix=":${PORT_HTTPS}"; fi
DEADLINE=$(( $(date +%s) + 180 ))
while [[ $(date +%s) -lt ${DEADLINE} ]]; do
    if curl -sk -m 5 "https://${DOMAIN}${_probe_suffix}/api/health" 2>/dev/null \
        | grep -q '"status":"ok"'; then
        echo "  ✓ backend healthy"
        break
    fi
    sleep 3
done

# ---------------------------------------------------------------------------
# 7. Seed Super-Admin
# ---------------------------------------------------------------------------

if [[ ${REUSE} -eq 0 ]]; then
    SUPER_PASSWORD="$(genpwd 20)"
    echo
    echo ">> Seeding Super-Admin (${SUPERADMIN_EMAIL})"
    docker compose -f docker-compose-https-local.yaml exec -T \
        -e MAUGOOD_SUPER_ADMIN_PASSWORD="${SUPER_PASSWORD}" \
        backend \
        python -m scripts.seed_super_admin \
            --email "${SUPERADMIN_EMAIL}" \
            --full-name "${SUPERADMIN_NAME}" 2>&1 | tail -2

    echo
    echo ">> Provisioning first tenant (${TENANT_SLUG})"
    docker compose -f docker-compose-https-local.yaml exec -T \
        -e MAUGOOD_PROVISION_PASSWORD="${ADMIN_PASSWORD}" \
        backend \
        python -m scripts.provision_tenant \
            --slug "${TENANT_SLUG}" \
            --name "${TENANT_NAME}" \
            --admin-email "${ADMIN_EMAIL}" \
            --admin-full-name "${ADMIN_NAME}" 2>&1 | tail -3
fi

# ---------------------------------------------------------------------------
# 8. Summary card
# ---------------------------------------------------------------------------

echo
echo "================================================================"
echo " ✓ Maugood ${VERSION} is running"
echo "================================================================"
echo
# Build the URLs from the actual ports — only show ``:port`` when the
# operator picked a non-default value, so the common case stays clean.
_https_port_suffix=""
if [[ "${PORT_HTTPS}" != "443" ]]; then _https_port_suffix=":${PORT_HTTPS}"; fi
TENANT_URL="https://${DOMAIN}${_https_port_suffix}"

echo " Tenant login"
echo "   URL          : ${TENANT_URL}/login"
echo "   Tenant slug  : ${TENANT_SLUG}"
echo "   Email        : ${ADMIN_EMAIL}"
echo "   Password     : ${ADMIN_PASSWORD:-<from --admin-password>}"
echo
echo " Super-Admin console"
echo "   URL          : ${TENANT_URL}/super-admin/login"
echo "   Email        : ${SUPERADMIN_EMAIL}"
if [[ ${REUSE} -eq 0 ]]; then
    echo "   Password     : ${SUPER_PASSWORD}"
fi
echo
echo " Observability"
echo "   Grafana      : http://localhost:${PORT_GRAFANA}  (admin / see .env GRAFANA_ADMIN_PASSWORD)"
echo "   Prometheus   : http://localhost:${PORT_PROMETHEUS}  (loopback only)"
echo "   Alertmanager : http://localhost:${PORT_ALERTMANAGER}  (loopback only)"
echo
echo " Database"
echo "   Postgres     : localhost:${PORT_POSTGRES}  (loopback only — see backend/.env for the URL)"
echo
echo " Stop the stack:"
echo "   docker compose -f docker-compose-https-local.yaml down"
echo
echo " Apply an update zip later (preserves data + env + certs):"
echo "   ./scripts/deploy-update.sh --zip /path/to/maugood-vX.Y.Z.zip"
echo
echo " Self-signed cert: your browser will warn on first visit. Click"
echo " through (Advanced → Proceed) or import ops/certs/fullchain.pem"
echo " into the OS keychain to silence the warning."
echo
echo " Save the passwords above — they are NOT recoverable."
echo "================================================================"
