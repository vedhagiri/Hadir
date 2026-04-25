# Hadir — Claude Code project notes

> **v1.0 in development.** Pilot frozen at tag `v0.1-pilot` on branch
> `release/pilot`.
>
> **For new sessions:** read this file first, then `PROJECT_CONTEXT.md`
> (history + decisions), then `v1.0-phase-plan.md` (the active phased
> plan). `pilot-plan.md` is **historical** — only consult it when
> triaging a pilot bug on the `release/pilot` branch. Per-phase build
> records live under `docs/phases/` going forward (one file per phase,
> committed alongside the phase's code). Never start coding without
> confirming which prompt is active.

## What this is
Hadir is a camera-based employee attendance platform built by Muscat Tech
Solutions for Omran (Oman). IP cameras detect employees by face, the system
computes attendance against shift policies, and reports are delivered out.
The pilot (v0.1) was delivered to Omran on the corporate LAN; v1.0 is the
multi-tenant SaaS-capable product, planned in `v1.0-phase-plan.md`.

## Branching
- `release/pilot` — maintenance branch tracking the `v0.1-pilot` tag.
  Only touched for hotfixes Omran reports against the pilot. **Do
  not rewrite history on this branch.**
- `main` — active v1.0 development. Every phase from
  `v1.0-phase-plan.md` commits here.
- Milestone tags arrive at the points noted in the v1.0 plan:
  `v1.0-m2` (multi-tenant + features), `v1.0-m3` (hardening), `v1.0`
  (final). Optional pre-hardening safety branches `release/v1.0-m2`
  and `release/v1.0-m3` per the plan's branching section.

To demo the pilot at any point: `git checkout v0.1-pilot`.
To return to v1.0 work: `git checkout main`.

## Status
**v1.0 phases currently complete: P0 + P1 + P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9 + P10 + P11 + P12.**

> **Tenant isolation is a P0 blocker.** The suites
> `backend/tests/test_multi_tenant_isolation.py` (the P1 canary) and
> `backend/tests/test_two_tenant_isolation.py` (the P5 end-to-end
> two-tenant smoke) MUST pass on every push to `main`. The CI
> workflow at `.github/workflows/isolation.yml` runs them plus
> `tests/test_migration_lint.py` against a Postgres service. **A
> failure stops the line — fix the leak before merging anything
> else, do not punt it to a known-issue list.**
- **P0** — pilot frozen at `v0.1-pilot` (commit `1a0782c`);
  `release/pilot` branch exists locally + at origin.
- **P1** — multi-tenant routing switch wired up. `MetaData()` is
  unqualified; a SQLAlchemy `checkout` event applies
  `SET search_path TO {schema}, public` per connection driven by a
  Python `ContextVar`. Login persists `tenant_id` / `tenant_schema`
  on `user_sessions.data`; `TenantScopeMiddleware` reads the claim
  for the request scope; background workers + lifespan startup wrap
  in `tenant_context(...)`. `tests/test_multi_tenant_isolation.py`
  is the canary — it must keep passing for the rest of v1.0.
  Single-mode (the pilot's `main` schema) is the backwards-compatible
  default.
- **P2** — Per-schema Alembic + tenant provisioning CLI. Migration
  `0008_tenants_to_public` moves the global `tenants` registry from
  `main` to `public` and rewires every FK across the DB.
  `alembic env.py` reads `-x schema=<name>` and stamps a
  `version_table_schema` per tenant; `scripts/migrate.py` orchestrates
  `main` first (legacy + 0008) then iterates `public.tenants` and
  upgrades every tenant schema. `scripts/provision_tenant.py` and
  `scripts/deprovision_tenant.py` are the CLIs; provisioning is
  fail-closed (rolls back the schema + registry row on any error),
  deprovisioning refuses in production without `--backup-taken`.
  `tests/test_migration_lint.py` enforces that 0009+ migrations are
  schema-agnostic (no hardcoded `main`/`public` literals).
- **P3** — Super-Admin role + console. Migration `0009_super_admin`
  adds three global tables in `public` (`mts_staff`,
  `super_admin_sessions`, `super_admin_audit`) plus a `status` column
  on `public.tenants`. New `hadir/super_admin/` package + `/api/super-admin/*`
  endpoints (login, tenants list/detail, in-process provisioning,
  Access-as start/end, suspend/unsuspend). `TenantScopeMiddleware`
  honours the `hadir_super_session` cookie and applies impersonation;
  `current_user` returns a synthetic Super-Admin during impersonation
  with all four roles; `auth.audit.write_audit` dual-logs to
  `public.super_admin_audit` whenever an impersonation context is
  active. Frontend ships a separate red-accent shell at
  `/super-admin/*` plus a persistent `ImpersonationBanner` over the
  tenant shell whenever `/api/auth/me` reports
  `is_super_admin_impersonation=true`.
- **P4** — Per-tenant branding. Migration `0010_tenant_branding`
  adds one per-tenant table (`tenant_branding`) with curated CHECK
  constraints on `primary_color_key` (8 OKLCH options) and
  `font_key` (Inter / Lato / Plus Jakarta Sans). New
  `hadir/branding/` package owns `/api/branding/*` (tenant Admin)
  and `/api/super-admin/tenants/{id}/branding/*` (operator).
  Logos are PNG/SVG ≤200KB validated by magic bytes, stored at
  `/data/branding/{tenant_id}/logo.{ext}`, served via auth-required
  endpoints. The frontend `BrandingProvider` mounts a `<style>` tag
  on the document at sign-in and rewrites its content with the
  tenant's accent + font overrides; no flicker, no reload required.
  Curated red lines from BRD FR-BRD-002: no free-form hex, no
  custom CSS upload, no custom font upload — enforced by both the
  CHECK constraints and the API validation.
- **P5** — Second-tenant non-prod smoke. Multi-tenant login wired:
  `POST /api/auth/login` accepts an optional `tenant_slug`,
  resolves the schema from `public.tenants`, and runs the user
  lookup + session creation under that tenant's schema. Login sets
  both `hadir_session` (opaque token) and `hadir_tenant` (slug)
  cookies; `TenantScopeMiddleware` reads the slug to pick which
  schema's `user_sessions` to look the token up in. The new
  end-to-end suite `tests/test_two_tenant_isolation.py` provisions
  two tenants via the CLI, logs in as each Admin separately,
  creates distinct employees, asserts cross-reads via every
  employee API + audit log return zero leakage, and confirms
  Super-Admin Access-as for both lands in `public.super_admin_audit`.
  CI workflow `.github/workflows/isolation.yml` runs the isolation
  suites + the migration lint on every push to main / PR touching
  `backend/`.
- **P6** — Entra ID OIDC. Migration `0011_oidc_config` adds a
  per-tenant `tenant_oidc_config` table (entra_tenant_id, client_id,
  Fernet-encrypted client_secret, enabled, updated_at). New env vars
  `HADIR_AUTH_FERNET_KEY` (separate from photo/RTSP key) and
  `HADIR_OIDC_REDIRECT_BASE_URL`. `hadir/auth/oidc.py` owns the
  whole flow: `/api/auth/oidc/login` redirects to Entra with a
  signed state+nonce cookie, `/api/auth/oidc/callback` validates the
  signed state, exchanges the code, validates the ID token against
  the cached JWKS via authlib, and matches on lower-cased email.
  No-match returns 403 with the prescribed message (no
  auto-provision); roles are never derived from Entra claims.
  `/api/auth/oidc/status` is the anonymous probe the LoginPage uses
  to show "Sign in with Microsoft" as the primary CTA. The Admin
  config CRUD pings the discovery URL before persisting and refuses
  to save a broken config. Plain secrets never appear in API
  responses, audit rows, or logs.
- **P7** — Multi-role user switcher. Sessions persist
  `data.active_role`; `current_user` narrows `CurrentUser.roles`
  to that single value so existing role guards re-evaluate per
  request without changes (the pilot's "highest role only"
  shortcut is retired). New `POST /api/auth/switch-role`
  validates the user holds the role, updates the session, and
  audits the transition (`auth.role.switched`). The frontend
  topbar renders a role chip + dropdown when a user has more
  than one role; selecting reloads the page so navigation
  re-renders cleanly against the new active role. Synthetic
  Super-Admin refuses switch (no real session row to update).
- **P8** — Manager assignments UI. Migration 0012 adds a per-tenant
  `manager_assignments` (id, tenant_id, manager_user_id, employee_id,
  is_primary, timestamps) with a unique trio + a **partial unique
  index** `(tenant_id, employee_id) WHERE is_primary` — Postgres
  rejects two primaries even on a buggy direct INSERT. Admin-only
  `/api/manager-assignments` endpoints (GET grouped, POST upsert
  with primary-clear-on-set, DELETE). Manager scope helper
  `get_manager_visible_employee_ids` unions department membership
  with direct assignments; the attendance router now passes that
  set so a Manager assigned to an out-of-dept employee sees them
  on `/api/attendance`. Frontend ships an Admin-only drag-and-drop
  page (native HTML5, no new deps): unassigned column on the left,
  manager card grid on the right, star icon toggles primary.
  Audit rows: `manager_assignment.{created,primary_set,deleted}`.
- **P9** — Policy engine: Flex type. Engine refactored to dispatch
  on `policy.type` while staying pure (no DB) — Fixed and Flex
  share the same `_Flags` shape internally. New per-tenant
  `policy_assignments` table with scope cascade `employee >
  department > tenant > legacy fallback`; the only DB-touching
  surface is `resolve_policies_for_employees` in
  `attendance/repository.py`. The scheduler now resolves per
  employee. CRUD endpoints `/api/policies` + `/api/policy-assignments`
  for Admin + HR with audit (`shift_policy.{created,updated,soft_deleted}`,
  `policy_assignment.{created,deleted}`). Frontend Policies page
  retires the placeholder; create/edit form switches fields per
  type; per-row assignment chips with tenant-default toggle +
  per-department / per-employee assignment.
- **P10** — Policy engine: Ramadan + Custom. Engine extended to
  dispatch Ramadan → Fixed flag math and Custom → Fixed-or-Flex
  inner-shape based on ``policy.custom_inner_type`` (still pure).
  ``ShiftPolicy`` carries ``range_start`` / ``range_end`` for the
  resolver's date check and ``custom_inner_type`` for Custom.
  Resolver gets two new top-priority tiers: **Custom** covering
  the date wins over Ramadan covering the date, both tenant-wide
  for the matched date. Documented order in `backend/CLAUDE.md
  §"Policy resolution priority"`. Pydantic validators reject
  Ramadan/Custom missing date ranges + inverted ranges. Frontend
  Policies page segments into Standard / Ramadan / Custom tables;
  the form gains a date-range picker (Ramadan + Custom) and an
  inner_type dropdown (Custom).
- **P11** — Leaves + holidays + tenant settings. Migration 0014
  adds `leave_types`, `holidays`, `approved_leaves`,
  `tenant_settings` (weekend_days JSONB + timezone) and
  `attendance_records.leave_type_id`. Engine takes
  `LeaveRecord` / `HolidayRecord` / `weekend_days` and stays pure;
  approved leave clears absent + surfaces type, holiday/weekend with
  events routes the entire total to overtime, holiday-on-weekend
  collapses to a single overtime treatment. **Per-tenant timezone**
  is the load-bearing red line — `load_tenant_settings(conn, scope)`
  + `local_tz_for(settings)` replaces the server-scoped
  `HADIR_LOCAL_TIMEZONE` on the hot path; legacy `local_tz()`
  remains only as a fallback. Admin/HR CRUD on `/api/leave-types`,
  `/api/holidays` (+ .xlsx import), `/api/approved-leaves`,
  `/api/tenant-settings`. Frontend Leave & Calendar page at
  `/leave-policy` (three tabs + tenant settings panel).
- **P12** — Custom fields editor. Migration 0015 adds two new
  per-tenant tables — `custom_fields` (id, tenant_id, name, code,
  type ['text','number','date','select'], options JSONB nullable,
  required, display_order) + `custom_field_values` (id, tenant_id,
  employee_id, field_id, value text). The values table is the
  single source of truth — never free-form JSON on the employee
  row, the load-bearing P12 red line. Admin-only CRUD on
  `/api/custom-fields` (+ POST `/reorder`); Admin/HR
  GET/PATCH on `/api/employees/{id}/custom-fields` with per-type
  coercion (text/number/date/select). Employee Excel **export**
  appends one column per defined field (using its `code` as the
  header); **import** accepts those same columns by code — unknown
  columns produce row warnings (not errors), the standard columns
  still import. Frontend Settings → Custom Fields page at
  `/settings/custom-fields` (drag-handle reorder via native HTML5,
  inline edit, delete-confirmation modal that warns about value
  cascade). Employee detail drawer renders custom fields below the
  standard fact grid with typed inline inputs.

Next: **P13** per `v1.0-phase-plan.md`. Wait for the user before
starting. Per-phase records: `docs/phases/P*.md`.

---

## Pilot build log (historical, for context)

The pilot's per-phase build summaries below were written when those
prompts were live. They're preserved for v1.0 sessions that need to
look up a pilot-era decision; the **current** plan is
`v1.0-phase-plan.md` and the active build records are
`docs/phases/P*.md`.

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

What P8 built:
- Alembic migration `0004_capture` creates `detection_events` (id,
  tenant_id, camera_id, captured_at, bbox JSONB, face_crop_path,
  embedding BYTEA nullable, employee_id nullable, confidence float
  nullable, track_id) and `camera_health_snapshots` (one row per
  minute per camera, with `frames_last_minute` + `reachable` + optional
  `note`). Indexes on `(tenant_id, captured_at)` plus camera + employee
  partitioned variants for P11/P12.
- `hadir/capture/` package: pure IoU tracker (threshold 0.3, idle
  timeout 3s, greedy association with no double-claim), InsightFace
  `buffalo_l` detection wrapper (recognition skipped; lazy-imported so
  tests don't trigger the 250 MB model download), event emitter that
  Fernet-encrypts + writes face crops under
  `/data/faces/captures/{tenant}/{camera}/{YYYY-MM-DD}/{uuid}.jpg`,
  per-camera reader with reconnect backoff + 4 fps throttle, and a
  `CaptureManager` singleton that supervises one worker per enabled
  camera.
- **One detection_events row per track entry**, not per frame — the
  reader only emits when the tracker returns `is_new=True`. A face
  standing in frame for 30 seconds at 4 fps generates 1 event, not 120.
- **Hot reload**: the P7 cameras router now calls
  `capture_manager.on_camera_{created,updated,deleted}` so credential
  rotations and enabled toggles take effect immediately — no polling.
- **Durability**: encrypted crop is written to disk *before* the DB
  insert, and both commit before the worker moves to the next
  detection. A crash mid-write leaks an unreferenced file; a committed
  row survives restart.
- **New deps**: `insightface==0.7.3`, `onnxruntime==1.19.2`. New named
  volume `insightface_models` mounted at `/root/.insightface` so the
  buffalo_l model downloads once and persists across restarts.
- **Test isolation**: `tests/conftest.py` neutralises the capture
  manager's start/stop for the test session (autouse fixture) so
  `TestClient(app)` entering the FastAPI lifespan never spawns real
  workers. P8's own tests inject a scripted `VideoCapture` and a
  stub analyzer — the suite never touches OpenCV network code or the
  InsightFace model.
- **Pytest coverage**: +13 new (47 total) — 8 tracker unit tests
  (IoU math, new/continued tracks, idle expiry, no double-claim) and
  5 integration tests covering: worker emits one event per new track,
  on-disk crops are Fernet-encrypted not JPEG, manager spawns + tears
  down on camera CRUD hot-reload, health snapshot written before
  worker exit, and a shape check against the pilot-plan's
  `SELECT COUNT(*) FROM detection_events WHERE captured_at > now() -
  interval '5 minutes'` verification query.
- **Live smoke**: `POST /api/cameras` with an intentionally-dead host
  → capture manager logs `capture worker started for camera id=…
  host=…` immediately; within 4 s a `camera_health_snapshots` row
  lands with `reachable=f` and note `could not open stream`; no
  plaintext RTSP URL and no injected credential string appears in the
  backend logs (`grep -cE "rtsp://[^\" ]*:[^@]*@" = 0`,
  `grep -cE "fake_user|fake_pw" = 0`).

What P9 built:
- Alembic migration `0005_photo_embeddings` adds
  `employee_photos.embedding BYTEA NULL` — Fernet-encrypted 512-float32
  InsightFace buffalo_l recognition vectors.
- `hadir/capture/analyzer.py` no longer restricts to detection-only;
  recognition is loaded and `Detection.embedding` is populated on
  every detected face.
- `hadir/identification/` package: `embeddings.py` (Fernet-encrypt
  vectors, with a shape-check guardrail), `enrollment.py`
  (`compute_embedding_for_file`, `enroll_photo`,
  `enroll_missing`, `clear_all_embeddings`, `reembed_all`),
  `matcher.py` (in-memory `MatcherCache` singleton with per-employee
  invalidation, cosine similarity, mean-of-top-k per employee, hard
  threshold), `router.py` (`POST /api/identification/reembed`,
  Admin-only, audit-logged as `identification.reembedded`).
- Capture path: `events.emit_detection_event` now accepts the
  detection's embedding, encrypts it, asks the matcher for a match,
  and persists `embedding` + `employee_id` + `confidence` on the same
  INSERT. Matcher DEBUG-logs the top-3 scored employees per call for
  pilot threshold tuning.
- Trigger hooks: the P6 photo routes call `enroll_photo` on upload
  and `matcher_cache.invalidate_employee` on delete; the FastAPI
  lifespan kicks off `enroll_missing` on a daemon thread so startup
  isn't blocked.
- New env var: `HADIR_MATCH_THRESHOLD` (default 0.45). The threshold
  is hard — below it, the matcher refuses to assign an employee.
- Pytest coverage: +9 new tests (65 total). Synthetic-vector matcher
  tests cover the Fernet embedding round-trip, happy-path match,
  below-threshold rejection, multi-angle mean-of-top-k, per-employee
  cache invalidation, and the threshold-hard guarantee.
- **Test speed guard**: `conftest.py` installs a session-wide
  `_NoopAnalyzer` so photo uploads and lifespan backfill never load
  InsightFace. A first pass without this stub pulled the 250 MB model
  during tests and took 7 minutes; with it the full suite runs in
  ~3 seconds.
- **Live smoke** (via `backend/scripts/p9_smoke.py`): seeded two
  employees with synthetic enrolled embeddings, called
  `emit_detection_event` with Alice's probe vector → the
  `detection_events` row came back with Alice's `employee_id` and
  `confidence=1.0000`, embedding ciphertext starts with `gAAAA…`; a
  stranger's orthogonal probe → `employee_id=None, confidence=None`
  (threshold held). `POST /api/identification/reembed` returns
  `{enrolled: 0, skipped: 0, errors: 0}` on an empty tenant and
  writes an `identification.reembedded` audit row.

**Reminder for the real-camera smoke**: the pilot plan asks for a
"you walk past the camera → your employee_id appears with
confidence > 0.5" validation. That requires re-adding the test
camera (it was wiped by pytest's `clean_cameras` fixture) and
uploading a reference photo of you. Once the photo uploads, the P6
route enrolls it synchronously, the matcher cache reloads that
employee, and the next detection event will carry the match.

What P10 built:
- Alembic migration `0006_attendance` adds `shift_policies` and
  `attendance_records`. The pilot's one Fixed policy (07:30–15:30,
  grace 15 min, required 8 h) is seeded for tenant 1 with
  `active_from = CURRENT_DATE`. Indexes on `(tenant_id, date)` plus
  the unique constraint `(tenant_id, employee_id, date)` so the
  scheduler upsert is single-row.
- `hadir/attendance/engine.py` — **pure** computation. ``compute()``
  takes employee_id, the_date, ShiftPolicy, events, leaves, holidays
  and returns an ``AttendanceRecord`` value object. No DB, no
  network — the v1.0 multi-policy engine plugs in additively.
- `hadir/attendance/repository.py` — tenant-scoped DB layer. Loads
  the active policy for a date, converts UTC `detection_events`
  timestamps to `HADIR_LOCAL_TIMEZONE` (default `Asia/Muscat`)
  before handing to the engine, and persists via
  Postgres `ON CONFLICT (tenant_id, employee_id, date)` upsert.
- `hadir/attendance/scheduler.py` — APScheduler interval job every
  `HADIR_ATTENDANCE_RECOMPUTE_MINUTES` (default 15). On `start()`
  fires an immediate seed so a fresh boot has rows ready before any
  HTTP request arrives. Pilot does not recompute historical days.
- `GET /api/attendance?date=&department_id=` — role-scoped list.
  Admin/HR see everything; Manager auto-scoped to their
  department(s) and forbidden from cross-department filtering;
  Employee sees only their own row (matched by lower-cased email
  until v1.0 adds an explicit user↔employee join table).
- Migration safety: my first draft inlined the JSON literal into a
  raw `INSERT`; SQLAlchemy's pyformat paramstyle then read `:15`
  inside `"grace_minutes":15` as a bind marker. Fixed by using
  `sa.text(...).bindparams(config=json.dumps(...))`.
- New env vars: `HADIR_LOCAL_TIMEZONE` (default `Asia/Muscat`),
  `HADIR_ATTENDANCE_RECOMPUTE_MINUTES` (default 15).
- Pytest coverage: +12 new tests (now 68 total). The engine suite
  exercises absent (with and without leave), single-event in-time,
  on-time-no-flags, late at and one minute past grace, early-out
  before and exactly at end-minus-grace, short-hours, overtime,
  out-of-order events, and a determinism check.
- `conftest.py` autouse fixture neutralises
  `attendance_scheduler.start/stop` so `TestClient(app)` lifespan
  entries don't spawn 15-minute APScheduler threads.
- **Live smoke** via `backend/scripts/p10_smoke.py`: seeded one
  employee + 3 detection events at 07:28 / 12:05 / 15:34 local;
  `recompute_today` upserted 1 row with `in=07:28:42 out=15:34:12
  total_minutes=486 late=False early_out=False short_hours=False
  overtime=6`. Then I shifted the last event to 15:10 and
  re-recomputed: same DB row id (upsert), `out_time=15:10:00`,
  `early_out=True`, `short_hours=True`. `GET /api/attendance` via
  curl returned the row with the joined employee + department +
  policy fields exactly as the frontend will consume them.

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
