# Hadir — production deployment runbook

This document walks an Omran IT operator from a fresh
**Ubuntu 22.04 LTS** server to a running Hadir stack served over
HTTPS. The pilot deployment lived on the corporate LAN; v1.0
ships TLS termination, a private docker network for the backend,
and a config-driven cert handling story (operator-provided
default + optional Let's Encrypt).

> Every step below uses the `${HADIR_*}` variable names the
> backend already understands. The same names are documented in
> `.env.example`; this runbook is a superset focused on the
> production-only knobs.

---

## 1. Prerequisites

* Ubuntu 22.04 LTS (or any recent Linux with Docker support).
* A public hostname with a DNS A/AAAA record pointing at the
  server (e.g. `hadir.example.com`). The hostname is referenced
  in the nginx `server_name` directive and in the
  `HADIR_OIDC_REDIRECT_BASE_URL`.
* TCP/80 + TCP/443 reachable from the public internet (or from
  the corporate network if Hadir lives on a VPN).
* Sudo access on the server.

### Install Docker

```sh
# Recent docker-ce + the compose plugin via the official repo.
sudo apt update
sudo apt install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Optional: let your user run docker without sudo.
sudo usermod -aG docker $USER
newgrp docker
```

### Clone the repo

```sh
sudo mkdir -p /opt/hadir
sudo chown $USER /opt/hadir
git clone https://github.com/<org>/Hadir.git /opt/hadir
cd /opt/hadir
git checkout v1.0   # or the latest release tag
```

---

## 2. Generate secrets

Hadir refuses to boot in production with the dev placeholder
secrets in place (`hadir.security.check_production_config`).
Every command below uses **stdlib only** so a fresh Ubuntu
22.04 host runs them without an extra `pip install`.

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(48))"                       # HADIR_SESSION_SECRET
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"   # HADIR_FERNET_KEY
python3 -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"   # HADIR_AUTH_FERNET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(48))"                       # HADIR_REPORT_SIGNED_URL_SECRET
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                       # HADIR_APP_DB_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                       # HADIR_ADMIN_DB_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(20))"                       # HADIR_GRAFANA_ADMIN_PASSWORD
```

The two Fernet lines produce 32-byte URL-safe-base64 keys —
the exact shape `cryptography.fernet.Fernet` expects. The
stdlib path means no `pip install cryptography` step on the
host before deploy.

Stash every value in a password manager **before** putting
them in `.env` — they're not recoverable, and rotating them
invalidates:

* `HADIR_SESSION_SECRET` — every active session.
* `HADIR_FERNET_KEY` — every encrypted RTSP credential, every
  encrypted photo, every encrypted attachment.
* `HADIR_AUTH_FERNET_KEY` — every encrypted OIDC client
  secret, every encrypted email-config password, every
  signed report download token.
* `HADIR_REPORT_SIGNED_URL_SECRET` — every outstanding
  signed-URL download.

---

## 3. Write `.env`

Copy the template and fill in:

```sh
cp .env.example .env
$EDITOR .env
```

Required production values (every `:?` interpolation in
`docker-compose.prod.yml` errors out at compose-up if missing —
that's intentional):

```bash
# ---- secrets (generated above) ----
HADIR_SESSION_SECRET=<paste>
HADIR_FERNET_KEY=<paste>
HADIR_AUTH_FERNET_KEY=<paste>
HADIR_REPORT_SIGNED_URL_SECRET=<paste>

# ---- DB role passwords (set on first boot via the migration) ----
HADIR_APP_DB_PASSWORD=<long random>
HADIR_ADMIN_DB_PASSWORD=<long random>
HADIR_DATABASE_URL=postgresql+psycopg://hadir_app:<HADIR_APP_DB_PASSWORD>@postgres:5432/hadir
HADIR_ADMIN_DATABASE_URL=postgresql+psycopg://hadir:<HADIR_ADMIN_DB_PASSWORD>@postgres:5432/hadir

# ---- Production hardening ----
HADIR_ENV=production
HADIR_BEHIND_PROXY=true
HADIR_SESSION_COOKIE_SECURE=true
HADIR_FORWARDED_ALLOW_IPS=*
HADIR_HSTS_MAX_AGE_SECONDS=31536000

# ---- Public-facing config ----
HADIR_PUBLIC_HOSTNAME=hadir.example.com
HADIR_ALLOWED_ORIGINS=https://hadir.example.com
HADIR_OIDC_REDIRECT_BASE_URL=https://hadir.example.com

# ---- TLS cert handling (see §4) ----
HADIR_TLS_CERT_DIR=./ops/certs
```

---

## 4. TLS cert handling — choose one

### 4a. Operator-provided certs (default)

Drop the cert + key into `ops/certs/`:

```sh
sudo mkdir -p /opt/hadir/ops/certs
sudo cp /path/to/operator-supplied/fullchain.pem /opt/hadir/ops/certs/fullchain.pem
sudo cp /path/to/operator-supplied/privkey.pem   /opt/hadir/ops/certs/privkey.pem
sudo chmod 0640 /opt/hadir/ops/certs/*.pem
```

The cert must be a full chain (server + intermediates). The key
must match. nginx validates the pair on startup
(`nginx -t`) — if either is wrong the container exits non-zero.

### 4b. Let's Encrypt (optional)

Layer in `docker-compose.le.yml` and add an ACME email:

```bash
# in .env
HADIR_LE_EMAIL=ops@example.com
```

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.le.yml \
  --profile letsencrypt \
  run --rm certbot
```

The certbot sidecar:

1. Reads the HTTP-01 challenge nginx serves at
   `/.well-known/acme-challenge/`.
2. Persists the issued cert to `ops/certs/{fullchain,privkey}.pem`
   (the same paths nginx already reads from).
3. Exits.

Bounce nginx to pick up the new cert, then add a cron entry for
renewal:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx

# Renew weekly (certbot is a no-op until 30 days before expiry).
sudo crontab -e
# 0 3 * * 0 cd /opt/hadir && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.le.yml --profile letsencrypt run --rm certbot && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx
```

> **Default**: operator-provided certs. Let's Encrypt is opt-in
> because Omran's IT controls the corporate cert PKI and rotates
> certs on its own schedule. Either path is supported.

---

## 5. Boot the stack

```sh
cd /opt/hadir
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  build

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d
```

Compose-up will:

* run the entrypoint's `python -m scripts.migrate` on the
  backend (advances the legacy + boundary migrations on `main`,
  then iterates every tenant schema in `public.tenants` —
  details in `backend/CLAUDE.md "Per-schema migration model"`);
* render `ops/nginx/hadir.conf.template` with the
  operator-supplied hostname + cert paths via `envsubst`;
* run `nginx -t` against the rendered config before exec — a
  syntax error or missing cert kills the container with a
  readable message.

Verify:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
# postgres + backend + nginx all "Up". The backend has NO
# host port mapping — only nginx reaches it via the private
# `hadir-internal` network.

curl -sk https://${HADIR_PUBLIC_HOSTNAME}/api/health
# {"status":"ok"}

# HSTS + the rest of the security headers should be present.
curl -skI https://${HADIR_PUBLIC_HOSTNAME}/api/health | grep -iE \
    'strict-transport|x-frame|x-content|referrer-policy|permissions-policy'

# Plain-HTTP is rejected with 421 by the backend's HTTPS gate
# (and 301'd to HTTPS by nginx before that).
curl -sIk -H "Host: ${HADIR_PUBLIC_HOSTNAME}" http://${HADIR_PUBLIC_HOSTNAME}/api/health \
  | head -5
```

---

## 6. Seed the first admin

> **Pick a path before running step 6:**
>
> * **Single-tenant deployment** (one customer, e.g. Omran's
>   pilot install): leave `HADIR_TENANT_MODE=single` (or
>   unset — `single` is the default). The seed script below
>   creates the first Admin user inside the legacy `main`
>   schema. This is the simplest shape and matches the pilot.
> * **Multi-tenant SaaS deployment** (multiple customers
>   served from one host): set `HADIR_TENANT_MODE=multi` in
>   `.env` *before* the first compose-up. Skip the seed
>   script and use `scripts/provision_tenant.py` per
>   tenant — see §6.5 below. The pilot Omran tenant is
>   itself created via the provision script in this mode.
>
> The two modes can't be mixed in one deployment. Pick once,
> per environment.

### 6a. Single-tenant — seed the first admin

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  exec -e HADIR_SEED_PASSWORD='<pick a strong password ≥ 12 chars>' backend \
  python -m scripts.seed_admin \
    --email admin@example.com \
    --full-name 'Operator Name'
```

The seed script enforces a 12-char minimum (P27 §1.1.2 floor).
The email **must** use a public TLD — `.local` and other
reserved TLDs are rejected by the email validator.

Open `https://${HADIR_PUBLIC_HOSTNAME}` in a browser; sign in;
verify the topbar shows the operator name + the locale switcher.

If your tenant uses Microsoft Entra ID, configure OIDC under
`Settings → Authentication` next — see
`docs/phases/P6.md` for the per-tenant config flow.

### 6b. Multi-tenant — provision a tenant

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  exec -e HADIR_PROVISION_PASSWORD='<pick a strong password ≥ 12 chars>' backend \
  python -m scripts.provision_tenant \
    --slug tenant_<slug> \
    --name '<Display Name>' \
    --admin-email admin@example.com \
    --admin-full-name 'Operator Name'
```

The CLI creates the schema, runs every migration on it, seeds
the four roles + three departments + a default Fixed shift
policy, and creates the first Admin user. The slug must match
`^[A-Za-z_][A-Za-z0-9_]{0,62}$` (Postgres CHECK constraint
mirrored in code) and is what the operator types into the
"Workspace" field on the login page.

Repeat per tenant. See `backend/CLAUDE.md "Tenant
provisioning CLI"` for the full red-line list (rollback on
failure, password handling, audit row).

> **Today's caveat:** P28 surfaced two multi-mode rough edges
> that v1.x will polish:
>
> 1. Creating non-Admin users (HR / Manager / Employee) for a
>    new tenant currently requires SQL — the API doesn't
>    expose a "create user" surface. Track on
>    `docs/v1.x-backlog.md` (B-1).
> 2. Background-job entry points use `TenantScope`'s default
>    `tenant_schema='main'`. Production deployments work, but
>    invoking jobs from the CLI on a non-`main` tenant
>    requires explicit `tenant_context(...)` wrappers. Track
>    on `docs/v1.x-backlog.md` (B-2).
>
> Neither blocks a single-tenant deployment.

---

## 7. Backups + secret rotation

### Postgres

The compose stack persists Postgres on a named volume
(`postgres_data`). At minimum, take a nightly logical dump:

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  exec -T postgres pg_dumpall -U hadir > /var/backups/hadir-$(date +%F).sql
```

### Encryption keys

Rotating `HADIR_FERNET_KEY` invalidates every encrypted blob on
disk (photos, RTSP credentials, attachments). Rotation is
straightforward only when the volume is empty — i.e. when
provisioning a brand-new tenant. Real-world rotation is an M3
hardening exercise (P28+) and intentionally out of scope here.

### Session secret

Rotating `HADIR_SESSION_SECRET` invalidates every active
session — operators have to sign in again. No other side effects.

---

## 8. Smoke checklist

After every deploy:

* [ ] `curl -sk https://${HADIR_PUBLIC_HOSTNAME}/api/health` → 200.
* [ ] HSTS, X-Frame-Options, X-Content-Type-Options,
      Referrer-Policy, Permissions-Policy present on the response.
* [ ] HTTP -> HTTPS redirect (`http://${HADIR_PUBLIC_HOSTNAME}`
      returns 301 to https).
* [ ] Backend port 8000 is **not** reachable from the public
      network (only nginx → backend over the private docker
      network):
      `nc -zv -w 2 ${HADIR_PUBLIC_HOSTNAME} 8000` should refuse.
* [ ] Sign in via the UI, verify the language switch works,
      verify a notification arrives in the bell.
* [ ] Sign out, sign in again — verify theme + density + language
      preferences persist.

---

## 9. Optional: HTTPS in dev with mkcert

The dev stack ships HTTP on `localhost:5173` (frontend) and
`localhost:8000` (backend). HTTPS in dev is **off by default** —
the prompt for that workflow is below for operators who want it
locally. The dev compose is **untouched** by P23.

```sh
brew install mkcert nss   # macOS; on Linux: apt install libnss3-tools then build mkcert from source
mkcert -install
mkcert -cert-file ops/certs/fullchain.pem -key-file ops/certs/privkey.pem hadir.local localhost 127.0.0.1
```

Bring up the production overlay locally (with its own project
name so it doesn't collide with the dev stack):

```sh
HADIR_PUBLIC_HOSTNAME=hadir.local \
HADIR_TLS_CERT_DIR=./ops/certs \
HADIR_ALLOWED_ORIGINS=https://hadir.local \
HADIR_OIDC_REDIRECT_BASE_URL=https://hadir.local \
HADIR_SESSION_SECRET=local-dev-rotate \
HADIR_FERNET_KEY=$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
HADIR_AUTH_FERNET_KEY=$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
HADIR_REPORT_SIGNED_URL_SECRET=local-dev-rotate \
docker compose -f docker-compose.yml -f docker-compose.prod.yml -p hadirhttps up -d
```

Add `127.0.0.1 hadir.local` to `/etc/hosts`, then visit
`https://hadir.local`. mkcert pre-installed the local CA so the
browser shows a green padlock.

To stop:

```sh
docker compose -p hadirhttps down -v
docker compose up -d   # back to the regular dev stack
```

---

## 10. Where things live

| Purpose                    | Path                                       |
| -------------------------- | ------------------------------------------ |
| nginx config template      | `ops/nginx/hadir.conf.template`            |
| nginx entrypoint           | `ops/nginx/entrypoint.sh`                  |
| nginx Dockerfile (multi)   | `ops/nginx/Dockerfile`                     |
| Cert directory             | `ops/certs/{fullchain,privkey}.pem`        |
| Production overlay         | `docker-compose.prod.yml`                  |
| Let's Encrypt overlay      | `docker-compose.le.yml`                    |
| Backend prod hardening     | `backend/hadir/security.py`                |
| Production startup check   | `check_production_config` in the same file |
| Per-phase build record     | `docs/phases/P23.md`                       |

For everything else — phased history, tenant migration model,
auth flow, etc. — start with `CLAUDE.md` and
`backend/CLAUDE.md` at the repo root.
