# Hadir backend — Claude Code notes

## Status
P1 complete. **P2 complete**: Alembic + initial schema + multi-tenant plumbing
+ DB role split + seed admin script. P3 next — wait for the user.

## Stack
- Python 3.11
- FastAPI + Uvicorn (`hadir.main:app`)
- SQLAlchemy 2.x **Core** (not ORM) — table defs live in `hadir/db.py`
- Alembic 1.13 migrations — single initial revision `0001_initial`
- Pydantic v2 + pydantic-settings (`hadir/config.py`, env prefix `HADIR_`)
- Argon2-cffi for password hashing (used by `scripts/seed_admin.py`; full
  auth in P3)
- psycopg 3 (binary) for Postgres
- Dev tooling: ruff, black, mypy (strict), pytest + httpx + pytest-asyncio

## Layout
```
backend/
  pyproject.toml
  Dockerfile
  entrypoint.sh                # alembic upgrade head; exec uvicorn
  alembic.ini
  alembic/
    env.py                     # reads HADIR_ADMIN_DATABASE_URL, version in main schema
    script.py.mako
    versions/
      0001_initial.py          # schema, citext, DB roles, grants, seed
  hadir/
    __init__.py
    main.py                    # FastAPI app factory + /api/health
    config.py                  # Settings (HADIR_* env vars, dual DB URLs)
    db.py                      # metadata (schema=main) + all 8 tables + engine factories
    tenants/
      __init__.py
      scope.py                 # TenantScope + get_tenant_scope FastAPI dep
  scripts/
    __init__.py
    seed_admin.py              # python -m scripts.seed_admin
  tests/                       # P3+
```

## Schema map (P2)
All tables live in schema **`main`**. Alembic version table is
`main.alembic_version`.

| Table              | PK                                  | tenant_id | Notes                                                |
| ------------------ | ----------------------------------- | --------- | ---------------------------------------------------- |
| `tenants`          | `id`                                | — (self)  | Seeded: `(1, 'Omran')`. Pilot uses this row only.    |
| `users`            | `id`                                | ✓         | `email` is CITEXT; unique per `(tenant_id, email)`.  |
| `roles`            | `id`                                | ✓         | Seeded per tenant: Admin, HR, Manager, Employee.     |
| `user_roles`       | `(user_id, role_id, tenant_id)`     | ✓         | Composite PK; CASCADEs from users/roles.             |
| `departments`      | `id`                                | ✓         | Unique per `(tenant_id, code)`.                      |
| `user_departments` | `(user_id, department_id, tenant_id)` | ✓       | Composite PK.                                        |
| `user_sessions`    | `id` (TEXT, opaque token)           | ✓         | `data` JSONB; `expires_at` TIMESTAMPTZ. Written in P3. |
| `audit_log`        | `id`                                | ✓         | Append-only (see grants below). JSONB before/after.  |

**Every tenant-scoped column is `NOT NULL` with a FK to `tenants.id`.**
Every SQL statement against these tables must filter by `tenant_id` — the
`TenantScope` dependency threads the value through repositories (see
"Tenant plumbing pattern" below).

## Database roles and grants
Two Postgres cluster roles, both `LOGIN`:

| Role          | Purpose                                 | Grants                                                           |
| ------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `hadir_admin` | Migrations, seed/backup scripts.        | Owner of `main` schema and all tables. Full CRUD everywhere.     |
| `hadir_app`   | **FastAPI request path only.**          | `SELECT/INSERT/UPDATE/DELETE` on every table **except** `audit_log`, where it is **`INSERT` + `SELECT` only**. |

Role passwords are set by the initial migration from
`HADIR_APP_DB_PASSWORD` / `HADIR_ADMIN_DB_PASSWORD`. Re-running the
migration ALTERs the passwords in place (idempotent).

The append-only property of `audit_log` is **enforced at the DB grant
level, not in application code**. UPDATE / DELETE / TRUNCATE from
`hadir_app` are rejected by Postgres with `permission denied for table
audit_log`. Do not route anything other than INSERT + SELECT through the
app path — if you need to mutate audit history for a test, connect as
`hadir_admin`.

Connection URLs:
- `HADIR_DATABASE_URL` → runtime (`hadir_app`)
- `HADIR_ADMIN_DATABASE_URL` → Alembic + scripts (`hadir` owner / `hadir_admin`)

## Tenant plumbing pattern
Pilot is single-tenant (`tenant_id=1`), but the plumbing is real so the v1.0
multi-tenant migration is additive. The pattern every future session must
follow:

1. **Read scope from the request.** FastAPI route handlers depend on
   `get_tenant_scope` (from `hadir.tenants.scope`), which returns a
   `TenantScope` populated from the active session (P3 wires this) or
   falls back to `HADIR_DEFAULT_TENANT_ID` (pilot: `1`).
2. **Pass scope to repositories.** Every repository function that touches
   tenant-scoped tables accepts `scope: TenantScope` as an explicit
   argument. No module-level or global access.
3. **Filter every query on `scope.tenant_id`.** `WHERE tenant_id = :tid`
   on reads; `tenant_id=...` in every `INSERT`/`UPDATE` payload.
4. **Never "admin override" from the app path.** Super-Admin cross-tenant
   access is a v1.0 concern with its own explicit scope type. For pilot,
   every request sees exactly one tenant.

If a handler reads data without going through `TenantScope`, that's a bug,
not a shortcut.

## Run
- **First boot (dev):**
  ```
  docker compose up --build
  # backend entrypoint runs `alembic upgrade head`, then uvicorn.
  # Migration creates schema `main`, DB roles, and seeds tenant + roles.
  ```
- **Seed admin:**
  ```
  docker compose exec -e HADIR_SEED_PASSWORD='...' backend \
    python -m scripts.seed_admin --email admin@pilot.hadir --full-name "Pilot Admin"
  ```
  Re-running is safe — upserts the user and idempotently asserts the
  `Admin` role. The script never logs the password.
- **Run migrations manually:** `docker compose exec backend alembic upgrade head`
- **Health:** `curl http://localhost:8000/api/health`

## Conventions (reinforced in P2)
- Every module starts with a docstring stating its purpose.
- Logging via stdlib `logging` to stdout. **Never** log passwords, RTSP
  URLs/credentials, session tokens, or face embeddings.
- Settings loaded via `get_settings()`; do not read `os.environ` directly
  outside of migrations and scripts that have to bootstrap before Settings
  would be valid.
- Auth/repository layers (P3+) pass `TenantScope` explicitly. No reaching
  into `request.state` from deep code paths.

## Pilot prompt currently active
P2 — done. Next: **P3 — Local auth, server-side sessions, role guards.**
Wait for the user before starting P3.
