# Hadir — Claude Code project notes

> **For new sessions:** read this file first, then `PROJECT_CONTEXT.md`
> (history + decisions), then `pilot-plan.md` (the active phased plan).
> Never start coding without confirming which prompt is active.

## What this is
Hadir is a camera-based employee attendance platform built by Muscat Tech
Solutions for Omran (Oman). IP cameras detect employees by face, the system
computes attendance against shift policies, and reports are delivered out.
The pilot is a 5-day single-tenant demo on a corporate LAN; v1.0 is the
multi-tenant SaaS-capable product 8–10 weeks after pilot signoff.

## Status
**Pilot prompts currently complete: P1 + P2 + P3 + P4 + P5 + P6 + P7.**
Next: P8 — Background capture pipeline + IoU tracker + detection
events. Wait for the user before starting it.

What P1 built:
- Monorepo layout per PROJECT_CONTEXT §7
- Backend: FastAPI app with `GET /api/health`, stdout logging, Pydantic v2
  settings, SQLAlchemy 2.x engine factory, Argon2-cffi installed,
  ruff/black/mypy/pytest dev deps
- Frontend: Vite + React 18 + TS strict, React Router / TanStack Query /
  Zustand / RHF / Zod installed, single page rendering "Hadir" using the
  design system CSS, all four design CSS files imported in order
- Design archive: `styles*.css` (4 files) verbatim into `frontend/src/styles/`,
  `icons/shell/ui/pages/dashboards/employee/data.jsx` verbatim into
  `frontend/src/design/` as read-only reference
- Docker Compose: backend, frontend (Vite dev), Postgres 15 with named
  volumes for `postgres_data` and `frontend_node_modules`
- `.env.example` at repo root and per service; `.gitignore` covers Python,
  Node, env files, runtime data dirs

What P2 built:
- Alembic wired with a single initial migration (`0001_initial`) creating
  schema `main` + the `citext` extension
- Eight tables in `main`: `tenants`, `users`, `roles`, `user_roles`,
  `departments`, `user_departments`, `user_sessions`, `audit_log`. Every
  tenant-scoped table carries `tenant_id NOT NULL` with a FK to `tenants.id`
- Two Postgres cluster roles — `hadir_admin` (owner, full CRUD) and
  `hadir_app` (app runtime; INSERT+SELECT only on `audit_log`, full CRUD
  elsewhere). Append-only enforcement is at the DB grant level, verified
  by attempting UPDATE/DELETE/TRUNCATE and receiving "permission denied"
- Seed data: tenant `(1, 'Omran')`; four roles (Admin/HR/Manager/Employee)
  for tenant 1
- `hadir/tenants/scope.py` — `TenantScope` dataclass + `get_tenant_scope`
  FastAPI dependency. Resolution: session → `HADIR_DEFAULT_TENANT_ID` (1)
- `backend/scripts/seed_admin.py` — CLI/env-driven admin seeder using
  Argon2; idempotent; never logs the password
- Backend container entrypoint runs `alembic upgrade head` before
  launching Uvicorn
- New env vars: `HADIR_ADMIN_DATABASE_URL`, `HADIR_APP_DB_PASSWORD`,
  `HADIR_ADMIN_DB_PASSWORD`

What P3 built:
- `hadir/auth/` package — argon2id passwords, server-side sessions in
  `main.user_sessions`, append-only audit writer, in-memory rate limiter
  (APScheduler reset every 10 min), FastAPI deps and router
- Endpoints `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`
- Session cookie `hadir_session`: HttpOnly, SameSite=Lax, Secure=False in
  dev, Path=/, Max-Age from `HADIR_SESSION_IDLE_MINUTES` (default 60)
- Sliding expiry — every authenticated request refreshes `expires_at`
  and cookie Max-Age
- Dependencies: `current_user`, `require_role`, `require_any_role`,
  `require_department`; `current_user` also sets `request.state.tenant_id`
  so the P2 tenant scope dependency picks it up
- Audit actions: `auth.login.success`, `auth.login.failure`,
  `auth.login.rate_limited`, `auth.logout`, `auth.session.expired` —
  all INSERT-only via hadir_app
- pytest suite (13 tests): happy path, wrong password, unknown email,
  case-insensitive email, expired session, logout, role guard allow/deny
  for Admin/Employee on role + any_role + department deps
- New env vars: `HADIR_SESSION_IDLE_MINUTES`, `HADIR_SESSION_COOKIE_NAME`,
  `HADIR_SESSION_COOKIE_SECURE`, `HADIR_LOGIN_MAX_ATTEMPTS`,
  `HADIR_LOGIN_RATE_LIMIT_RESET_MINUTES`

What P4 built:
- `src/api/client.ts` — fetch wrapper with `ApiError`; same-origin
  credentials so `hadir_session` flows through the Vite proxy
- `src/auth/` — `AuthProvider` (TanStack Query `useMe`/`useLogin`/
  `useLogout`), `ProtectedRoute` (redirect to /login on 401),
  `LoginPage` (RHF + Zod, email+password only, surfaces 401/429 distinctly)
- `src/shell/` — typed `Icon` component (verbatim port of
  `design/icons.jsx`), `nav.ts` (literal port of `NAV` + `CRUMBS`),
  `Sidebar` (role-aware nav + brand + static identity footer),
  `Topbar` (breadcrumbs + role badge + logout), `Layout` (composes all)
- `src/pages/Placeholder.tsx` — generic scaffold page, mapped per NAV id
  to "Coming in P<N>" or "Deferred to v1.0"
- 23 routes (one per unique NAV id across all roles) plus `/login`,
  `/` → `/dashboard`, and a catch-all
- `src/main.tsx` — now wraps the tree in `QueryClientProvider` +
  `BrowserRouter`; CSS import order unchanged
- Vite proxy changed from `/api` (prefix) to `^/api/` (regex) so routes
  like `/api-docs` stay client-side SPA routes rather than 404ing against
  the backend
- No Tailwind, no CSS-in-JS, no component library added. Only the
  already-installed P1 deps are used.

What P5 built:
- Alembic migration `0002_employees`: `employees` + `employee_photos`
  (photos schema-only in P5; file ingestion + Fernet encryption land in
  P6). Three seed departments (ENG/OPS/ADM). Ownership + grants parity
  with P2 tables.
- `hadir/employees/` package: tenant-scoped repository, openpyxl-backed
  parse_import/build_export, Pydantic schemas, Admin-only router
- Endpoints: `GET/POST /api/employees`, `GET/PATCH/DELETE /api/employees/{id}`,
  `POST /api/employees/import`, `GET /api/employees/export`
- Audit actions: `employee.created`, `employee.updated` (with before/after),
  `employee.soft_deleted`, `employee.imported` (summary row with counts
  per import), `employee.exported`
- New deps: `openpyxl`, `python-multipart`
- Pytest coverage extended (18 tests total; 5 new for P5): 5-row import
  with the pilot-plan test matrix (3 valid / 1 bad dept / 1 duplicate),
  re-import → update, export round-trip column + inactive inclusion,
  search hits across code/name/email/department, soft-delete hide +
  include_inactive, 403 for Employee role

What P6 built:
- Backend photo endpoints (all Admin-only, all audited): drawer-style
  upload `POST /api/employees/{id}/photos`, folder-dump bulk ingest
  `POST /api/employees/photos/bulk` (filename → employee_code + angle),
  decrypt stream `GET /api/employees/{id}/photos/{photo_id}/image`,
  list `GET /api/employees/{id}/photos`, hard delete per photo.
- Encrypted-at-rest: bytes Fernet-encrypted using `HADIR_FERNET_KEY`
  before writing to `/data/faces/{tenant}/{code}/{angle}/{uuid}.jpg`.
  Inspected on disk: files start with `674141` (Fernet base64url
  'gAA…'), **not** the JPEG magic `ffd8ff`.
- Never auto-creates employees — unknown `employee_code` in a bulk
  upload is rejected + audit-logged as `photo.rejected`.
- Audit actions: `photo.ingested`, `photo.rejected`, `photo.viewed`,
  `photo.deleted`.
- New dep: `cryptography` (Fernet). New named volume `faces_data`
  mounted at `/data` on the backend service.
- Frontend `/employees` page now renders real data: search,
  department filter, include-inactive toggle, photo-count pills,
  Export link, Import modal (drag-and-drop `.xlsx` + per-row error
  results), detail drawer with profile + photo gallery (live images
  via the decrypt endpoint) + multi-file drop zone with an angle
  selector.
- Pytest coverage: +6 new tests (24 total) covering filename
  convention, auto-create refusal, Fernet-on-disk, decrypt
  round-trip, drawer photo-count update, 403 for Employee.

What P7 built:
- Alembic migration `0003_cameras` creates the `cameras` table
  (id, tenant_id, name, location, rtsp_url_encrypted, enabled,
  created_at, last_seen_at, images_captured_24h) owned by hadir_admin
  with full CRUD granted to hadir_app. Unique on `(tenant_id, name)`.
- `hadir/cameras/` package: Fernet encrypt/decrypt of the RTSP URL
  (same `HADIR_FERNET_KEY` as photos), host-only parser that strips
  userinfo, thread-guarded single-frame grab via OpenCV
  (`opencv-python-headless`) with a 5-second hard wall-clock timeout.
- Endpoints (all Admin-only, audit-logged):
  - `GET /api/cameras` — host-only response
  - `POST /api/cameras` — encrypts URL before insert
  - `PATCH /api/cameras/{id}` — omitted `rtsp_url` leaves cipher
    untouched; when rotated on same host, audit flags
    `rtsp_url_rotated: true`
  - `DELETE /api/cameras/{id}`
  - `GET /api/cameras/{id}/preview` — opens → one frame → closes;
    504 on timeout/unreachable, with host-safe detail string
- Audit actions: `camera.created`, `camera.updated`, `camera.deleted`,
  `camera.previewed`. Every audit `before`/`after` payload carries
  `rtsp_host` only — never the plaintext URL.
- Frontend: `/cameras` route now renders a real page with per-row
  Preview / Edit / Delete, an Add/Edit drawer whose RTSP field shows
  `***` on edit and only sends a new URL when the user actually types
  one, and a preview modal that fetches via blob URL and offers a
  Refresh button (revokes URL on unmount).
- New deps: `opencv-python-headless`, `numpy`. Backend image grew
  accordingly.
- Pytest coverage: +10 new tests (34 total) covering host parser,
  encrypt/decrypt round-trip, CRUD surface (ciphertext in DB, host
  only in responses), PATCH-without-url preserves cipher,
  PATCH-with-url rotates cipher, audit never carries plain URL,
  preview stub returns canned JPEG, preview 504 on timeout, 403 for
  Employee.
- Red-line check on the live stack: after full CRUD + rotation, a
  `docker compose logs backend | grep -E "rtsp://[^\" ]*:[^@]*@"`
  returns **0 lines**; neither the plain password nor the username
  appears anywhere in logs, responses, or audit payloads.

## Tech stack (summary)
- **Backend:** Python 3.11, FastAPI, Uvicorn, SQLAlchemy 2.x Core, Pydantic
  v2, Argon2-cffi, python-dotenv. Postgres 15.
- **Frontend:** Vite, React 18, TypeScript strict mode, React Router v6,
  TanStack Query, Zustand, React Hook Form, Zod. Plain CSS (no Tailwind, no
  CSS-in-JS).
- **Infra:** Docker Compose for dev. Single-host Ubuntu deployment for
  pilot. See PROJECT_CONTEXT §5 for the full stack with rationale.

## Directory map
```
hadir/
  backend/                  # Python service — see backend/CLAUDE.md
    pyproject.toml
    Dockerfile
    entrypoint.sh           # alembic upgrade head; exec uvicorn
    alembic.ini
    alembic/
      env.py
      versions/
        0001_initial.py     # schema, citext, DB roles, grants, seed
    .env.example
    hadir/
      __init__.py
      main.py               # FastAPI app + create_app()
      config.py             # Pydantic Settings (HADIR_* env vars)
      db.py                 # metadata (schema=main) + all 8 tables + engines
      tenants/              # TenantScope + get_tenant_scope
    scripts/
      seed_admin.py         # python -m scripts.seed_admin
    tests/                  # pytest suite (P3+)
  frontend/                 # Vite + React app — see frontend/CLAUDE.md
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    Dockerfile
    .env.example
    src/
      main.tsx              # entry; imports CSS + mounts <App/>
      App.tsx               # P1 placeholder ("Hadir")
      styles/               # design CSS, copied verbatim
      design/               # design JSX reference, read-only
  design-reference/         # unpacked design archive (input source)
  docker-compose.yml
  .env.example              # repo-root env template
  .gitignore
  CLAUDE.md                 # this file
  PROJECT_CONTEXT.md        # decisions log
  pilot-plan.md             # the 5-day pilot plan
  Hadir_v1.0_BRD.docx       # business requirements
```

## How to run
1. **First run:** copy env templates.
   ```sh
   cp .env.example .env
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   # Generate a Fernet key for HADIR_FERNET_KEY:
   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
2. **Bring up the stack:**
   ```sh
   docker compose up --build
   # Backend entrypoint runs `alembic upgrade head` before Uvicorn, so
   # schema `main`, DB roles, and seed data (tenant + roles) exist after
   # the first healthy boot.
   ```
3. **Seed the pilot admin:**
   ```sh
   docker compose exec -e HADIR_SEED_PASSWORD='pick-something-real' backend \
     python -m scripts.seed_admin --email admin@pilot.hadir --full-name "Pilot Admin"
   ```
4. **Verify:**
   - Backend health: `curl http://localhost:8000/api/health` → `{"status":"ok"}`
   - Frontend: open `http://localhost:5173` → renders "Hadir" on the
     warm-neutral background using the display serif
   - Postgres (admin): reachable on `localhost:5432` as `hadir/hadir/hadir`
   - Postgres (app): `hadir_app/hadir_app` — has INSERT+SELECT only on
     `main.audit_log`; UPDATE/DELETE/TRUNCATE are rejected
5. **Stop:** `docker compose down`. Add `-v` to also drop the postgres
   volume (do this only when you want a clean DB).

## Red lines (PROJECT_CONTEXT §12 + pilot-plan §"Red lines")
- Design files are **copied verbatim** — never reformat, "fix", or convert
  `frontend/src/styles/*.css` or `frontend/src/design/*.jsx`.
- **No Tailwind, no CSS-in-JS, no component library.** Style with plain CSS
  via the design system.
- **No extra dependencies** beyond what each pilot prompt names.
- Tenant plumbing from day 1 (added in P2): every tenant-scoped table has
  `tenant_id`; every query filters by it.
- RTSP credentials encrypted with Fernet; passwords never logged; audit log
  is append-only at the DB grant level (P2).
- No scope creep from v1.0 features into the pilot — see PROJECT_CONTEXT §8
  for the deferred list.
