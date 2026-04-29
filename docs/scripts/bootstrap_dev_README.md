# Bootstrap a fresh Maugood machine

The `backend/scripts/bootstrap_dev.py` script gets a clean machine to "I can log in" state in under 30 seconds.

## When to use it

Use this when:
- You've just cloned the repo on a new laptop
- A teammate is setting up Maugood for the first time
- You wiped Postgres and need to start over but don't want the full demo dataset
- You're setting up a new corporate tenant for a customer (edit the `TENANTS` list first)

Do NOT use this when:
- You want the full mts_demo synthetic dataset (25 employees, shift policies, holidays, etc.) — use `pre_omran_reset.py` instead, which is the destructive full-seed script
- You want to reset existing user passwords — bootstrap is idempotent and skips existing users (drop the rows manually first if you want fresh passwords)

The two scripts have different jobs and should stay separate.

## Prerequisites

Before running:

1. Postgres is running (`docker compose up postgres`)
2. Backend is running so migrations have run (`docker compose up backend`)
3. Or, if running migrations manually: `docker compose exec backend alembic upgrade head`

## Run it

From the repo root:

```bash
docker compose exec backend python -m scripts.bootstrap_dev
```

For verbose mode (shows each SQL operation, useful when debugging):

```bash
docker compose exec backend python -m scripts.bootstrap_dev --verbose
```

The script prints all credentials to stdout AND writes them to `/data/credentials.txt` inside the container (which maps to your local `data/` folder if you've mounted it). Falls back to `credentials.txt` in the repo root if `/data` isn't writable.

## What it creates

| Section | Email | Notes |
|---|---|---|
| Super-Admin | `superadmin@mts.test` | MTS staff console at `/super-admin/login` |
| mts_demo Admin | `admin@mts-demo.example.com` | Full tenant admin |
| mts_demo HR | `hr@mts-demo.example.com` | HR-only access |
| mts_demo Manager (Eng) | `manager.eng@mts-demo.example.com` | Engineering scope |
| mts_demo Manager (Ops) | `manager.ops@mts-demo.example.com` | Operations scope |
| mts_demo Dual-role | `dual.role@mts-demo.example.com` | HR + Manager (Operations) — exercises role switcher |
| mts_demo Employee | `employee@mts-demo.example.com` | Plain employee |
| inaisys Admin | `admin@inaisys.local` | Real corporate test tenant |
| inaisys HR | `hr@inaisys.local` | Real corporate HR |
| inaisys Employee | `employee@inaisys.local` | The face you'll enroll for end-to-end testing |

10 logins total. All passwords randomly generated per run.

## Credentials file format

Looks like this:

```
==============================================================================
Maugood bootstrap credentials
Generated: 2026-04-27T08:30:00+00:00
==============================================================================

This file is gitignored. Do not commit it.
Passwords are random per bootstrap run. To regenerate, drop the
affected user/tenant rows and re-run bootstrap_dev.py.

==============================================================================

## Super-Admin (MTS staff console)

  Email:    superadmin@mts.test
  Password: aB3xK9-mN2pQ8wL!
  Note:     Login at /super-admin/login (separate from tenant login).

------------------------------------------------------------------------------

## Tenant: mts_demo  (MTS Demo) — Synthetic demo tenant — fake cameras, exercise every feature.

  Email:    admin@mts-demo.example.com
  Tenant:   mts_demo
  Password: pK4nV-jX7tQ9rB!
  Note:     Full tenant admin — can do everything.

  ... etc
```

The file has mode 0600 — only the user running the script can read it.

## Idempotency

Run it twice:

```bash
docker compose exec backend python -m scripts.bootstrap_dev
docker compose exec backend python -m scripts.bootstrap_dev
```

Second run prints `(unchanged — already existed)` for everything. No errors, no corruption.

To regenerate a single user's password, delete the row from the tenant's `users` table first:

```sql
DELETE FROM tenant_mts_demo.users WHERE email = 'admin@mts-demo.example.com';
```

Then re-run bootstrap. Only that user gets a new password; others remain.

## Editing tenants and users

Open `bootstrap_dev.py` and edit the `TENANTS` list at the top. Each `TenantSpec` and `UserSpec` is self-explanatory. You can add tenants for new customers, or trim the list down for a minimal setup.

If you change the `slug` of an existing tenant, the next run treats it as a new tenant — the old one stays. Be careful.

## Troubleshooting

**"Role 'Admin' not found in tenant_mts_demo"** — migrations didn't run, or didn't seed the `roles` table. Run `alembic upgrade head` and try again.

**"could not connect to server"** — Postgres isn't up. `docker compose up postgres` first.

**"MAUGOOD_DATABASE_URL is not set"** — env var missing. Check `docker-compose.yml` and your `.env` file.

**"could not write /data/credentials.txt"** — the `/data` volume isn't mounted, or has wrong perms. Script falls back to `credentials.txt` in the repo root. Both locations are gitignored.

**Login fails after bootstrap** — verify the password from credentials.txt matches what's hashed in the DB:
```bash
docker compose exec backend python -c "
from argon2 import PasswordHasher
from sqlalchemy import create_engine, text
import os
engine = create_engine(os.environ['MAUGOOD_DATABASE_URL'])
with engine.connect() as conn:
    row = conn.execute(text(
        \"SELECT password_hash FROM tenant_mts_demo.users WHERE email='admin@mts-demo.example.com'\"
    )).fetchone()
    PasswordHasher().verify(row[0], 'PASTE-PASSWORD-HERE')
    print('verifies')
"
```
If that prints `verifies`, the bootstrap worked and the issue is elsewhere (frontend, tenant slug routing, etc.). If it raises, the bootstrap didn't write the hash you think it did — drop the user row and re-bootstrap.
