# Maugood — First-Time Setup

A focused, step-by-step playbook for the first time you stand up
Maugood on a customer machine. Three things to do, in order:

1. **Deploy the stack** — get Docker running with the secrets + cert
   in place.
2. **Create a Super-Admin** — the MTS-side staff account that
   provisions tenants and operates the platform.
3. **Provision the first tenant** — the customer's own Maugood
   instance, with their first Admin user.

> For the deeper "fresh Ubuntu → running stack" runbook
> (firewall + Docker install + secret generation + TLS handling),
> see [`client-install-guide.md`](client-install-guide.md). This
> doc is the **abridged setup playbook** that assumes you've
> already followed §1–§7 of that guide and you're at the "stack is
> ready to start" step.

---

## 0. Pre-flight checklist

Before running anything, confirm:

- [ ] You're in the install root (e.g. `/opt/maugood`).
- [ ] `.env` is populated with real secrets (the seven values from
      §5 of `client-install-guide.md`). No placeholders.
- [ ] TLS cert + key sit at `ops/certs/fullchain.pem` and
      `ops/certs/privkey.pem` (CA-signed for production,
      self-signed is fine for an internal pilot).
- [ ] Customer's logo + display name are ready. (Optional — can
      be applied via Settings → Branding once they log in.)
- [ ] You know the customer's:
      * **Tenant slug** — short lowercase identifier (e.g. `acme`).
        Used in URLs and login. Must match `^[a-z][a-z0-9_-]{1,39}$`.
      * **Display name** — what shows on PDF letterheads and
        emails (e.g. "Acme Corp").
      * **First Admin's email + full name** — the customer's
        Admin user, who will manage employees + cameras + reports.

---

## 1. Start the stack

```sh
cd /opt/maugood
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    up -d --build
```

First build pulls Postgres 15, builds the backend (FastAPI + Python
deps + WeasyPrint), and builds the frontend (Vite + nginx). On a
typical 8C/16G machine this takes 5-10 minutes the first time.

Watch the boot:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    logs -f backend
```

You should see, in order:

1. `running migrations…` (Alembic upgrades the public schema +
   every tenant schema).
2. `capture manager started with 0 worker(s)` (zero is correct —
   no cameras yet).
3. `Maugood backend started (env=production, tenant_mode=multi)`.
4. `Application startup complete.` from Uvicorn.

`Ctrl+C` to detach. Verify:

```sh
curl -k https://localhost/api/health
# {"status":"ok"}
```

---

## 2. Create the Super-Admin account

The Super-Admin is the **MTS-side operator** who provisions tenants,
suspends tenants, and (with audit) impersonates a tenant Admin to
investigate issues. It's distinct from any tenant's Admin user.

Generate a strong password and seed the account:

```sh
PASSWORD=$(python3 -c "
import secrets, string
chars = string.ascii_letters + string.digits + '!#%&'
print(''.join(secrets.choice(chars) for _ in range(20)))
")
echo "Super-Admin password: ${PASSWORD}"

docker compose exec -T \
    -e MAUGOOD_SUPER_ADMIN_PASSWORD="${PASSWORD}" \
    backend \
    python -m scripts.seed_super_admin \
        --email superadmin@mts-staff.example.com \
        --full-name "MTS Super Admin"
```

> **Save the password into a password manager immediately.** It's
> hashed with Argon2id; the plaintext is never recoverable from
> the database.

To rotate the password later, re-run the same command with a new
`MAUGOOD_SUPER_ADMIN_PASSWORD` value — the seed script idempotently
upserts the hash.

> **Email format constraint**: the login endpoint validates the
> email TLD via the standard `email-validator` library, which
> rejects `.local`, `.internal`, and other reserved TLDs. Use a
> domain that resolves (or at least one with a valid TLD like
> `.example.com`) — the address itself doesn't have to receive
> mail.

### 2a. Verify the Super-Admin login works

Open `https://<your-hostname>/super-admin/login` in a browser
(red-accent shell — distinct from the tenant login at
`/login`). Sign in with:

- **Email:** `superadmin@mts-staff.example.com`
- **Password:** the value you saved above

You should land on the Super-Admin console showing an empty
"Tenants" list. Every action you take from here is double-logged
to the global `super_admin_audit` table on top of the affected
tenant's own audit trail.

---

## 3. Provision the first tenant

Two paths — pick one. Both produce the same result.

### Path A — Super-Admin console (recommended for ops)

1. From the Super-Admin console (`/super-admin/tenants`),
   click **+ Provision tenant**.
2. Fill in:
   * **Slug** — `acme` (lowercase, used in URLs)
   * **Name** — "Acme Corp" (shown on PDF letterheads + emails)
   * **Admin email** — `admin@acme.example.com`
   * **Admin full name** — e.g. "Jane Operator"
   * **Admin password** — pick a strong one (≥ 12 chars, mix of
     case/digits/special). The console enforces the minimum
     server-side.
3. Click **Provision**. The console runs the same code path as
   the CLI below.

### Path B — CLI (recommended for scripted setup)

```sh
docker compose exec -T \
    -e MAUGOOD_PROVISION_PASSWORD='ChooseAStrongPwd#1' \
    backend \
    python -m scripts.provision_tenant \
        --slug acme \
        --name 'Acme Corp' \
        --admin-email admin@acme.example.com \
        --admin-full-name 'Jane Operator'
```

Replace every value above. The script will:

1. Create a Postgres schema `tenant_acme` with every per-tenant
   table.
2. Seed 4 roles (Admin / HR / Manager / Employee), 3 default
   departments (ENG / OPS / ADM), and one Fixed shift policy
   (07:30 – 15:30).
3. Create the first Admin user with the provided password
   (Argon2id-hashed; the plaintext never appears in audit rows
   or logs).
4. Run `alembic stamp head` so future migrations are
   schema-agnostic for this tenant.
5. Write a `tenant.provisioned` audit row to the new schema's
   audit log AND the global super_admin_audit log.

If the script exits 0 you have a live tenant. Hand the Admin
password to the customer over a separate secure channel — Maugood
never displays it again, and rotating it requires either an Admin
self-service flow (still on the v1.x roadmap) or the
operator-side reset:

```sh
# Reset a tenant Admin's password from the host:
docker compose exec backend python -c "
from maugood.auth.passwords import hash_password
from maugood.db import get_engine, tenant_context, users
from sqlalchemy import update

NEW_PWD = 'NewPasswordHere'
TENANT_SCHEMA = 'tenant_acme'
EMAIL = 'admin@acme.example.com'

with tenant_context(TENANT_SCHEMA):
    with get_engine().begin() as conn:
        conn.execute(
            update(users).where(users.c.email == EMAIL).values(
                password_hash=hash_password(NEW_PWD)
            )
        )
print('reset')
"
```

---

## 4. The customer's first login

Hand off these credentials to the customer:

- **URL:** `https://<your-hostname>/login`
- **Tenant slug:** `acme`
- **Email:** `admin@acme.example.com`
- **Password:** (the one you set in step 3)

Their first login gets them to the empty Admin dashboard. From
there, they can:

- **Settings → Branding** — apply their logo + accent colour +
  font.
- **Settings → Divisions / Departments / Sections** — set up the
  org hierarchy.
- **Cameras → + Add camera** — register their RTSP cameras.
- **Employees → + Add employee** (or the Excel **Import** path
  for bulk) — enrol the workforce.

The day-1 walkthrough lives in §11 of
[`client-install-guide.md`](client-install-guide.md).

---

## 5. Provisioning additional tenants

Same procedure for every customer added later — either via the
Super-Admin console or `scripts.provision_tenant.py`. Each tenant
gets:

* An isolated Postgres schema (`tenant_<slug>`) with its own
  copies of every per-tenant table.
* An isolated `/data/{faces,attachments,reports,erp,branding}/<tenant_id>/`
  directory tree on disk.
* An independent set of users, roles, departments, employees, and
  audit log.

Cross-tenant data leakage is impossible by construction — the
SQLAlchemy `checkout` event sets `SET search_path` per connection
based on the active session's claim, so a Super-Admin
impersonating tenant A and a Super-Admin viewing the dashboard for
tenant B in another browser session see disjoint data even though
they're hitting the same Postgres instance. The two-tenant
isolation suite (`tests/test_two_tenant_isolation.py`) is the CI
canary that proves this on every commit.

---

## 6. Updates & ongoing operations

To apply a new release zip from MTS to an existing install:

```sh
./scripts/deploy-update.sh --zip /tmp/maugood-v1.2.0.zip
```

The script:

1. Snapshots operator-state (`.env`, `ops/certs/`, custom logos)
   to `backups/<timestamp>-pre-update.tar.gz`.
2. Stops the stack.
3. Mirrors the new code into the install dir while preserving
   every operator-edited file.
4. Brings the stack back up with `--build`. Alembic migrations
   apply on backend boot.
5. Polls `/api/health` and reports the verdict.

A failed update is recoverable via the timestamped backup tarball.
Run with `--dry-run` first if you want to see exactly what would
happen.

For the broader ops surface (logs, backups, restores, retention,
DR rehearsals), see:

- [`client-install-guide.md`](client-install-guide.md) §12 —
  day-2 operations
- [`disaster-recovery.md`](disaster-recovery.md) — RTO/RPO
  targets + restore playbook
- [`data-retention.md`](data-retention.md) — what gets cleaned up
  automatically and what survives forever
