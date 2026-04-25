# Hadir backend — Claude Code notes

## Status
Pilot P1–P13 complete + P14 prep delivered. **v1.0 P0 + P1 + P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9 + P10 + P11 + P12 + P13 + P14 + P15 + P16 + P17 + P18 + P19 + P20 + P21 + P22 complete (M2 core)**:
pilot frozen at tag `v0.1-pilot` on branch `release/pilot`; multi-tenant
routing wired up via a per-connection `SET search_path` driven by a
ContextVar + SQLAlchemy `checkout` event; the global `tenants` registry
lives in `public`, every per-tenant table lives in its own schema, and
the migration history splits into "legacy main" (0001-0007), the
boundary migration (0008), and "schema-agnostic going forward" (0009+).
Provisioning + deprovisioning CLIs in `scripts/`. **P3** added
`mts_staff`, `super_admin_sessions`, `super_admin_audit` (all in
`public`), the `/api/super-admin/*` console, impersonation routing in
`TenantScopeMiddleware`, a synthetic `current_user` during
impersonation, and dual-audit on every tenant-scope write so each
operator touch lands in BOTH the tenant's own `audit_log` and the
global operator log. Migration-authoring lint at
`tests/test_migration_lint.py`. Isolation canary in
`tests/test_multi_tenant_isolation.py`. **P4** added per-tenant
branding (`tenant_branding` table; curated 8-colour palette + 3
fonts; PNG/SVG logo upload validated by magic bytes; `/api/branding`
+ `/api/super-admin/tenants/{id}/branding` endpoints; frontend
`BrandingProvider` writes a `<style>` tag with `--accent` overrides +
body font-family at sign-in). **P5** wired multi-tenant login
(`POST /api/auth/login` accepts `tenant_slug`; sets `hadir_tenant`
cookie alongside `hadir_session`; middleware reads the slug to pick
which schema's `user_sessions` to look up); shipped the
end-to-end isolation suite `tests/test_two_tenant_isolation.py`;
added `.github/workflows/isolation.yml` as a P0-blocker CI gate.
**P6** added per-tenant Entra ID OIDC: `tenant_oidc_config` table
(Fernet-encrypted client_secret with separate `HADIR_AUTH_FERNET_KEY`),
`/api/auth/oidc/{status,login,callback,config}` flow via authlib +
httpx, signed state+nonce cookie between login and callback, ID
token validation against cached JWKS, email-match on existing tenant
users (red line: no auto-provision, no role derivation from claims),
LoginPage promotes "Sign in with Microsoft" to primary when enabled.
**P7** added the multi-role switcher: `user_sessions.data.active_role`
is set at login (highest role) and updated by
`POST /api/auth/switch-role` with `auth.role.switched` audit;
`current_user.roles` is narrowed to `(active_role,)` so existing
`require_role` guards re-evaluate per request; topbar renders a
role chip + dropdown when the user holds more than one role.
**P8** added per-tenant `manager_assignments` (with a DB-level
partial unique index for the primary-manager rule),
`/api/manager-assignments` Admin-only CRUD, and the Manager scope
helper `get_manager_visible_employee_ids` that unions department
membership with direct assignments (used by the attendance router).
**P9** added the Flex policy type (engine refactored to dispatch
internally; still pure) + per-tenant `policy_assignments` with
the cascade `employee > department > tenant > legacy fallback`
in `resolve_policies_for_employees`; the scheduler now resolves
per employee. `/api/policies` + `/api/policy-assignments` Admin/HR
CRUD, audit on every change. **P10** added Ramadan + Custom: engine
dispatches Custom→inner-shape (Fixed or Flex) and Ramadan→Fixed
math, both still pure; resolver prepends Custom > Ramadan > … as
the new highest tiers. Priority documented in
`backend/CLAUDE.md §"Policy resolution priority"`. **P11** added
the leaves + holidays + tenant-settings module (per-tenant
timezone — the load-bearing red line); engine takes
`LeaveRecord` / `HolidayRecord` / `weekend_days` and treats
holidays + weekends as full-overtime days (single treatment, no
double-count for holiday-on-weekend). `/api/leave-types` +
`/api/holidays` (incl. .xlsx import) + `/api/approved-leaves`
+ `/api/tenant-settings` Admin/HR CRUD. Single-mode
backwards-compatible (pilot's `main` schema is the default).
**P12** added the custom-fields editor: per-tenant
`custom_fields` (id, tenant_id, name, code, type, options JSONB,
required, display_order) + `custom_field_values` (per-employee,
per-field, stored as text). Field-def CRUD on `/api/custom-fields`
is Admin-only; per-employee value GET/PATCH on
`/api/employees/{id}/custom-fields` is Admin/HR with per-type
coercion (text/number/date/select). The employee Excel **export**
appends one column per field (using its `code` as the header), and
the **import** accepts those same columns by code — unknown
columns produce row warnings, not row errors (the standard columns
still import). Frontend Settings → Custom Fields page +
drag-handle reorder + delete-confirmation modal that warns about
the value cascade. The values table is the single source of truth
— never free-form JSON on the employee row (the load-bearing P12
red line). **P13** added the request state machine (backend):
per-tenant `requests` + `request_attachments` (upload UI in P14);
pure `hadir.requests.state_machine` enforces the 8-state model with
manager rejection terminal (the load-bearing red line) and HR final
except for Admin override (mandatory non-empty comment per BRD
FR-REQ-006). `/api/requests` (Employee submit, Employee cancel,
Manager-decide assigned-only, HR-decide gated on
`manager_approved`, Admin-override universal). On approval:
idempotent `approved_leaves` row + per-employee/per-date attendance
recompute via the new `attendance.scheduler.recompute_for(...)`
(single-employee, handles past dates). Audit hook on every
transition. Role-scoped GET. **P14** added the request submission UI:
migration 0017 + per-tenant `request_reason_categories` with the BRD
§FR-REQ-008 default list seeded. Read endpoint open to every
authenticated role; admin-only writes on `/api/request-reason-categories`
(+ POST/PATCH/DELETE). Attachment pipeline in
`hadir/requests/attachments.py` validates via explicit magic-byte
sniff (load-bearing P14 red line — extension never trusted; bare
ZIP refused even though `.docx` is allowed). Server-enforced size
cap via `HADIR_REQUEST_ATTACHMENT_MAX_MB` (default 5). Attachments
Fernet-encrypted at `/data/attachments/{tenant_id}/requests/{uuid}.{ext}`,
audit hooks on upload/download/delete. Owner-modify (Employee for
own + still-submitted; Admin always). The static
`/api/requests/attachment-config` route is registered before
`/{request_id}` so FastAPI matches it first. **P15** added the
approvals inbox: manager scope widened to union of
`manager_assignments` + `user_departments`
(`get_manager_visible_employee_ids` from P8) on both `_can_view`
and `manager_decide`. New pure `hadir/requests/sla.py` computes
business-hours-open against the tenant's weekend list (P11);
thresholds via `HADIR_REQUEST_SLA_BUSINESS_HOURS` (default 48) +
`HADIR_REQUEST_SLA_BUSINESS_DAY_HOURS` (default 8). Three new
endpoints — `GET /api/requests/inbox/{pending,decided,summary}` —
declared before the dynamic `/{request_id}` route so static
matching wins. Every request response carries `attachment_count`,
`business_hours_open`, `sla_breached`, and
`is_primary_for_viewer` for the frontend table.
**P16** added the Admin override surface: migration 0018 adds
per-tenant `notifications_queue` (id, tenant_id,
recipient_user_id, kind, request_id, payload JSONB, created_at,
sent_at). `AdminOverrideBody.comment` tightens to `min_length=10`
with a strip-then-recheck `model_validator` (load-bearing red
line — server is the source of truth). The audit row records
`previous_stage`, `previous_decider_user_id`, and the comment
**verbatim**. On override the router queues one row each for the
original Manager + HR decider (when present) and the submitting
Employee, resolved by lower-cased email; the payload carries
`recipient_email` as a fallback for delivery so P20 can email
deactivated accounts. **P17** added the PDF attendance report:
WeasyPrint 62.3 + Jinja templating + a `pydyf==0.10.0` pin
(WeasyPrint 62 is incompatible with pydyf 0.11+). Dockerfile gains
`libpango / libcairo / libgdk-pixbuf / libffi / shared-mime-info
/ fonts-liberation` so the WeasyPrint cffi import doesn't crash on
a fresh image. `hadir/reporting/pdf.py` reads
`tenant_branding`, maps `primary_color_key` to a stable hex pair
via `HEX_PALETTE`, and inlines the tenant logo as a `data:` URL
so the renderer never opens a network socket. `POST
/api/reports/attendance.pdf` shares the Excel endpoint's request
body + role gates + manager scoping + date guards; filename
`hadir-attendance-{tenant_slug}-{from}-to-{to}.pdf` per spec.
Multi-employee reports get `page-break-before: always` between
sections; the `@page` rule paints generation timestamp + "Page x
of y" via CSS counters. **P18** added scheduled reports + email:
migration 0019 ships per-tenant `email_config` (Fernet-encrypted
SMTP / Graph secrets via `HADIR_AUTH_FERNET_KEY`),
`report_schedules`, and `report_runs`. `hadir/emailing/` exposes
`SmtpSender` + `GraphSender` (two-call REST, no `msal`) plus a
pluggable factory for tests and a file-recorder mode
(`HADIR_EMAIL_RECORDER_PATH`) for the live smoke.
`hadir/scheduled_reports/runner.py` is the engine — inserts a
running row, builds the report, picks attach-vs-link by
`HADIR_EMAIL_ATTACHMENT_MAX_MB` (default 10), dispatches via the
configured provider, updates the run row + advances `next_run_at`
via `croniter`. APScheduler 60-second scan iterates active
schedules where `next_run_at <= now()`. Anonymous signed-URL
download endpoint at `/api/reports/runs/{id}/download?token=…` is
HMAC-gated, per-IP rate-limited, and audit-logged. **P19** added
the ERP file-drop export: per-tenant `erp_export_config` (format
'csv'|'json', operator-supplied output_path, cron, window_days).
`hadir/erp_export/` ships a path resolver that pins every output
under `/data/erp/{tenant_id}/` (the load-bearing P19 red line —
`..` and outside-root absolute paths raise `UnsafeOutputPath`),
CSV + JSON builders matching `docs/erp-file-drop-schema.md`
(`metadata.schema_version=1` + `tenant_slug` in every record),
and a runner that shares the existing P18 60-second tick. New
endpoints `GET/PATCH /api/erp-export-config` and `POST
/api/erp-export-config/run-now` (writes the file under the tenant
root **and** streams the same bytes back; audit-logs every run).
**P20** added the notifications subsystem: migration 0021 drops
the P16 stub `notifications_queue` and adds `notifications` (per-
tenant queue + history with email delivery columns) +
`notification_preferences` (composite PK, defaults to both true
when no row). New `hadir/notifications/` ships producer
wrappers, repository, the `notification.html` Jinja template
(tenant-branded, with the "Settings → Notifications" plain-text
unsubscribe pointer per BRD), the 30-second worker tick that
re-resolves preferences per row before sending (load-bearing red
line — `email=False` skips dispatch, the row stays in the bell),
and a camera-unreachable watcher mounted in the existing P18
tick. Producers wired into request submit/decide/cancel, admin
override (replaces the P16 stub), attendance recompute (overtime
0 → >0 first-time-today gate), on-demand reports, and camera
health. **P21** added Arabic + RTL: migration 0022
(`users.preferred_language` nullable, CHECK locked to en/ar/null),
new `hadir/i18n/` (`t()` + Accept-Language q-weighted parser +
`resolve_language` chain), PyYAML 6.0.2-backed en.yaml + ar.yaml
bundles (Claude-generated Arabic, **pending Omran HR native-
speaker review before v1.0 launch**). Notification producers
refactored — every recipient sees the subject + body in their
own preferred language (load-bearing red line: two recipients of
the same event get two different translations). `MeResponse`
+ `CurrentUser` carry `preferred_language`; new `PATCH
/api/auth/preferred-language` audits as
`auth.preferred_language.updated` and refuses synthetic Super-
Admin (no real users row to update). Frontend wires i18next +
react-i18next + LanguageDetector with detection order
`localStorage > navigator > htmlTag` + the server-resolved
preference applied on every `/api/auth/me` resolve;
`<html dir="rtl">` flips on language change; topbar
EN/العربية switcher; CSS logical-properties sweep across the
four design CSS files; `[dir="rtl"]` flips directional icons
(chevrons + arrows) via `transform: scaleX(-1)`. **P22** added
dark mode + density + reference pages: migration 0023 adds
nullable `users.preferred_theme` (CHECK system/light/dark) and
`users.preferred_density` (CHECK compact/comfortable) — both
schema-agnostic. `CurrentUser` + `MeResponse` thread the
fields; new `PATCH /api/auth/preferred-theme` and
`/api/auth/preferred-density` endpoints audit
(`auth.preferred_theme.updated` /
`auth.preferred_density.updated`) and refuse synthetic Super-
Admin. The frontend `theme/` module flips `data-theme` +
`data-density` on `<html>` (the design's CSS already declared
the two attribute selectors — no rewrite needed); a unified
`DisplaySwitcher` lives in the topbar with `aria-haspopup` +
`aria-pressed` semantics + Esc-to-close. `:focus-visible`
outlines + accessible names round out the a11y sweep. New
`/pipeline` (all roles) static explainer + Admin-only
`/api-docs` Swagger embed render the long-deferred reference
surfaces. **v1.0 M3 hardening next.**

## Tenant routing (v1.0 P1)
**Approach chosen: SQLAlchemy `checkout` event + Python ContextVar**,
not a per-route DI dependency. Documented here per the v1.0 P1
prompt's "Document the choice" rule.

Why events over DI:
1. Existing pilot routes use `with engine.begin() as conn:` directly.
   Switching to a DI dependency would touch every handler. Event
   listener leaves them untouched.
2. Background workers (capture, attendance, lifespan enrolment)
   already had to wrap themselves in a tenant scope. They wrap in
   `tenant_context(schema)` once at thread entry; every pool
   checkout inside the scope auto-applies `SET search_path`.
3. New endpoints automatically inherit tenant routing — no risk of a
   future PR forgetting a `Depends(get_tenant_connection)`.
4. Defense-in-depth: in `multi` mode the `_resolve_active_schema`
   helper raises before any SQL is issued if no contextvar is set
   (the **fail-closed red line**). DI would happily skip the dep
   for endpoints that don't declare it.

Mechanics (`hadir/db.py`):
- `metadata = MetaData()` — **no `schema=`**. All `Table` objects are
  unqualified; FK target strings are `"tenants.id"` etc.
- `_tenant_schema_var: ContextVar[str | None]` — None by default.
- `set_tenant_schema(schema)` validates against
  `^[A-Za-z_][A-Za-z0-9_]{0,62}$` before setting; the same regex is
  enforced server-side in migration 0007 as a `CHECK` constraint on
  `tenants.schema_name`. Defence in depth.
- `_attach_search_path_listener(engine)` registers a `checkout` event:
  every borrowed connection issues `SET search_path TO "<schema>", public`.
  In `single` mode with no contextvar, the listener defaults to
  `main`. In `multi` mode it raises `RuntimeError("no tenant schema
  in scope — refusing to issue queries")`.
- `tenant_context(schema)` is a context manager for non-request entry
  points (workers + lifespan); the request path goes through
  `TenantScopeMiddleware`.

Login persists the claim:
- `auth.sessions.create_session(..., tenant_schema=...)` writes
  `data = {"tenant_id": ..., "tenant_schema": ...}` on the new row.
- `auth.router.login` resolves `user.tenant_id → tenants.schema_name`
  once at login and passes it to `create_session`.
- The request middleware reads the row's `data` claim. A super-admin
  impersonation hook (`data.impersonated_tenant_id`) overrides the
  home tenant — UI for that lands in v1.0 P3, the override path is
  already wired here.

Isolation canary (`tests/test_multi_tenant_isolation.py`):
- Provisions two real schemas (`tenant_a`, `tenant_b`) with one tiny
  `widgets` table each, disjoint rows.
- Verifies queries under one schema never see the other's rows;
  inserts route to the active schema only.
- Asserts the multi-mode + no-context path raises with the exact
  fail-closed error message.
- This test is the **canary** — if it ever fails in a future phase,
  tenant isolation is broken. Don't `pytest.mark.skip` past it.

## Stack
- Python 3.11
- FastAPI + Uvicorn (`hadir.main:app`)
- SQLAlchemy 2.x **Core** (not ORM) — table defs live in `hadir/db.py`
- Alembic 1.13 migrations — single initial revision `0001_initial`
- Pydantic v2 + pydantic-settings (`hadir/config.py`, env prefix `HADIR_`)
- Argon2-cffi for password hashing (P3 auth, seed admin script)
- APScheduler for in-process background jobs (P3 rate-limit reset; P8/P10
  will schedule capture supervision + attendance recompute)
- email-validator for Pydantic `EmailStr`
- openpyxl for XLSX import/export (P5)
- python-multipart for FastAPI `UploadFile` handling (P5)
- cryptography.Fernet for encrypted-at-rest face photos (P6) and RTSP
  credentials (P7)
- opencv-python-headless + numpy for the RTSP single-frame grab (P7)
  and the capture pipeline (P8)
- insightface (+ onnxruntime CPU) for buffalo_l face detection in P8
  (recognition module skipped until P9). Model files auto-download to
  `/root/.insightface` (mounted as a named volume so they survive
  container restarts).
- psycopg 3 (binary) for Postgres
- Dev tooling: ruff, black, mypy (strict), pytest + httpx + pytest-asyncio

## Layout
```
backend/
  pyproject.toml
  Dockerfile
  entrypoint.sh                # python -m scripts.migrate; exec uvicorn
  alembic.ini
  alembic/
    env.py                     # reads HADIR_ADMIN_DATABASE_URL, version in main schema
    script.py.mako
    versions/
      0001_initial.py          # schema, citext, DB roles, grants, seed
  hadir/
    __init__.py
    main.py                    # FastAPI app factory + /api/health + lifespan
    config.py                  # Settings (HADIR_* env vars, dual DB URLs, P3 knobs)
    db.py                      # metadata (schema=main) + all 8 tables + engine factories
    auth/                      # P3
      __init__.py              # re-exports CurrentUser, router, guards
      passwords.py             # argon2id hash/verify
      sessions.py              # user_sessions CRUD + sliding expiry helpers
      audit.py                 # write_audit() — INSERT only
      ratelimit.py             # in-memory (email, IP) counter + APScheduler
      dependencies.py          # current_user, require_role, require_any_role, require_department
      router.py                # /api/auth/{login,logout,me}
    tenants/
      __init__.py
      scope.py                 # TenantScope + get_tenant_scope FastAPI dep
    employees/                 # P5 + P6
      __init__.py
      schemas.py               # Pydantic request/response models
      repository.py            # tenant-scoped SQL (list/get/create/update/soft-delete/export)
      excel.py                 # openpyxl parse_import() + build_export()
      photos.py                # Fernet write/read + filename parser + photo-row helpers
      router.py                # /api/employees/... including /photos endpoints
    cameras/                   # P7
      __init__.py              # intentionally does NOT re-export router (P8 broke the cycle)
      schemas.py               # CameraCreateIn, CameraPatchIn, CameraOut (no rtsp_url outbound)
      repository.py            # tenant-scoped SQL; decrypt-to-parse-host for row views
      rtsp.py                  # Fernet encrypt/decrypt + rtsp_host() + thread-guarded preview grab
      router.py                # /api/cameras/... including /preview (notifies capture_manager on CRUD)
    capture/                   # P8
      __init__.py              # exports the capture_manager singleton
      tracker.py               # pure IoU tracker: match detections to tracks, drop idle tracks
      analyzer.py              # Analyzer protocol + InsightFace buffalo_l wrapper (P9: recognition on) + test stub hook
      events.py                # emit_detection_event: encrypt crop + P9 matcher call + DB insert; health snapshot
      reader.py                # CaptureWorker: 4 fps read loop + reconnect backoff + per-minute health flush
      manager.py               # CaptureManager singleton + on_camera_created/updated/deleted hooks
    identification/            # P9
      __init__.py              # exports matcher_cache + router
      embeddings.py            # Fernet encrypt/decrypt for 512-D float32 vectors
      enrollment.py            # compute_embedding_for_file, enroll_photo, enroll_missing, reembed_all
      matcher.py               # MatcherCache singleton (in-memory, per-employee invalidation, cosine + top-k)
      router.py                # POST /api/identification/reembed
    attendance/                # P10
      __init__.py              # exports attendance_scheduler
      engine.py                # PURE compute(): no DB, no IO; ShiftPolicy + AttendanceRecord
      repository.py            # active_policy_for, events_for (TZ-converted), upsert_attendance, list_for_date
      scheduler.py             # AttendanceScheduler — APScheduler 15-min job + startup seed
      router.py                # GET /api/attendance with role scoping
    detection_events/          # P11 (read-only)
      __init__.py
      router.py                # GET /api/detection-events (paginated + filters), GET /{id}/crop (decrypt + audit)
    system/                    # P11 (read-only)
      __init__.py
      router.py                # GET /api/system/{health, cameras-health}
    audit_log/                 # P11 (read-only)
      __init__.py
      router.py                # GET /api/audit-log (paginated + filters + distinct selectors)
    reporting/                 # P13
      __init__.py
      attendance.py            # openpyxl write_only XLSX builder, one sheet per ISO week
      router.py                # POST /api/reports/attendance.xlsx (Admin/HR/Manager, manager dept-scoped)
    _test_endpoints/           # P13 — DEV-ONLY (mounted iff HADIR_ENV=dev)
      __init__.py
      router.py                # POST /api/_test/seed_detection, /api/_test/recompute_attendance
  scripts/
    __init__.py
    seed_admin.py              # python -m scripts.seed_admin
  tests/
    __init__.py
    conftest.py                # admin/employee user + clean_employees fixtures
    test_auth.py               # 13 tests — P3 coverage
    test_employees.py          #  5 tests — P5 coverage
    test_photos.py             #  6 tests — P6 coverage (Fernet-at-rest, bulk, drawer, 403)
    test_cameras.py            # 10 tests — P7 coverage (CRUD, encryption, host parse, preview stub, 403)
    test_tracker.py            #  8 tests — P8 IoU tracker pure logic
    test_capture.py            #  5 tests — P8 worker + manager (scripted feed, stub analyzer)
    test_identification.py     #  9 tests — P9 matcher (Fernet round-trip, happy/below-threshold, multi-angle top-k, cache invalidation)
    test_attendance_engine.py  # 12 tests — P10 pure engine (on-time, late, early-out, short-hours, overtime, absent, leave clears absent)
    test_p11_endpoints.py      # 14 tests — P11 detection-events list/filters/crop, system health/cameras-health, audit-log + 403s
    test_p13_reports.py        #  9 tests — P13 report round-trip + manager scoping + dev-only endpoints
```

## Per-schema migration model (v1.0 P2)
**Three categories of migrations** in `alembic/versions/`:

1. **Legacy main pilot** (0001-0007) — pilot history, frozen, only
   ever applied to the `main` schema.
2. **Boundary migration** (0008_tenants_to_public) — one-shot,
   intentionally cross-schema. Creates `public.tenants` from
   `main.tenants`, programmatically rewires every FK in the DB, and
   drops `main.tenants`. Tracked in `main.alembic_version` (which is
   the only place that knew anything about `tenants` pre-P2).
3. **Schema-agnostic forward migrations** (0009+) — every new
   migration ships here. **No hardcoded `main`/`public` literals** —
   `tests/test_migration_lint.py` fails the suite if it spots one.
   `alembic env.py` sets `search_path` to the active schema, so an
   unqualified `op.create_table("foo", ...)` lands in whichever
   tenant schema is being upgraded.

`alembic env.py` reads `-x schema=<name>` from the CLI. The version
table lives in that schema (`<schema>.alembic_version`), and
`search_path` points at it before any DDL runs. The default (no
`-x`) is `main` for backward compat.

`scripts/migrate.py` is the orchestrator the entrypoint runs at
container start:

1. `alembic -x schema=main upgrade head` (advances pilot legacy +
   boundary).
2. Iterate `public.tenants` for `schema_name <> 'main'`; for each,
   run `alembic -x schema=<name> upgrade head`. Schema-agnostic 0009+
   migrations apply uniformly.

A new tenant created via `scripts/provision_tenant.py` arrives with
its `alembic_version` already stamped at head (the CLI runs
`alembic stamp` after `metadata.create_all`), so the orchestrator's
loop is a no-op for it until the next forward migration ships.

## Tenant provisioning CLI (v1.0 P2)
```
docker compose exec -e HADIR_PROVISION_PASSWORD='…' backend \
  python -m scripts.provision_tenant \
    --slug tenant_<slug> --name '<Display Name>' \
    --admin-email <email> [--admin-full-name '<Name>']
```
Steps run inside one transaction (rolled back on any failure):

1. Validate slug against `^[A-Za-z_][A-Za-z0-9_]{0,62}$` (mirrors
   the DB CHECK on `public.tenants.schema_name`).
2. INSERT row into `public.tenants` (returns the new tenant_id).
3. `CREATE SCHEMA <slug>`.
4. `metadata.create_all` against the new schema, filtered to skip
   `public.tenants` (the only `Table` with `schema="public"`).
5. Apply grants: `hadir_admin` owner, `hadir_app` SELECT/INSERT/
   UPDATE/DELETE on every per-tenant table EXCEPT `audit_log`
   (INSERT + SELECT only — same append-only contract as main).
6. Seed defaults: 4 roles (Admin/HR/Manager/Employee), 3 departments
   (ENG/OPS/ADM), one Fixed shift policy `Default 07:30–15:30`.
7. Create the first Admin user with an Argon2id-hashed password.
8. Insert a `tenant.provisioned` audit row in the new schema.

After the transaction commits, `alembic stamp head` runs as a
subprocess to record `<slug>.alembic_version` at the latest revision.
If the stamp fails, the schema and registry row are dropped before
the script exits non-zero. **Password input** order: `--admin-password`
flag → `$HADIR_PROVISION_PASSWORD` → interactive prompt with
confirmation. The plain password never appears in `argv`, logs, or
audit rows.

## Tenant deprovisioning CLI (v1.0 P2 — destructive)
```
docker compose exec backend python -m scripts.deprovision_tenant \
  --slug tenant_<slug> --confirm [--backup-taken] [--yes-i-know]
```
**Red lines** (mirrored at the script's docstring):

- `--confirm` is necessary but not sufficient. Without `--yes-i-know`
  the script prompts the operator to re-type the slug on stdin.
- In `HADIR_ENV=production`, the script refuses without
  `--backup-taken`. There is no way for the script to verify a backup
  was taken — the flag is a hard checkpoint on operator discipline.
- Refuses to drop the pilot schema `main`.
- Drops only the schema (`DROP SCHEMA <slug> CASCADE`) and the
  registry row. Encrypted face crops under
  `/data/faces/<tenant_id>/` and `/data/faces/captures/<tenant_id>/`
  are NOT removed — operators clean up the volume separately.

## Policy resolution priority (P9 + P10)

For any ``(employee, date)`` tuple,
``hadir.attendance.repository.resolve_policies_for_employees``
walks this cascade and returns the **first** match. **Only one
policy applies per (employee, date) — no stacking.** The order is
deterministic and load-bearing:

1. **Custom** policy whose ``config.start_date <= the_date <=
   config.end_date`` (tenant-wide for that date — applies to every
   employee).
2. **Ramadan** policy whose date range covers ``the_date``
   (tenant-wide for that date).
3. **Employee-scoped** ``policy_assignments`` row matching this
   employee.
4. **Department-scoped** ``policy_assignments`` row matching this
   employee's ``department_id``.
5. **Tenant-scoped** ``policy_assignments`` row.
6. **Legacy fallback** — any active ``shift_policies`` row covering
   the date (the pilot seeded a tenant-wide Fixed policy here;
   tenants without explicit assignments rely on this).

The resolver is the **only** DB-touching part of the engine
pipeline (P9 / P10 red lines). The engine itself stays pure.

If a policy is created with a Custom or Ramadan type but no
``config.start_date`` / ``end_date``, the row is invalid and the
resolver skips it rather than apply tenant-wide. The Pydantic
validators on ``PolicyConfig`` reject this shape at the API
boundary; the in-resolver guard is defence in depth.

## Schema map (P2)
**Global** (lives in `public`):

| Table     | Notes |
| --------- | --------- |
| `tenants` | Single globally-visible table. Holds id, name, schema_name, created_at. CHECK on schema_name regex + UNIQUE on schema_name (and on name). |

**Per-tenant** (lives in `<tenant_schema>` — `main` for the pilot,
`tenant_<slug>` for v1.0 tenants). Each row is `tenant_id NOT NULL FK
public.tenants(id)`. Identical shape across every tenant schema.

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
  # backend entrypoint runs `scripts.migrate` (orchestrator: main + every
  # tenant schema in public.tenants), then uvicorn.
  # Migration creates schema `main`, DB roles, and seeds tenant + roles.
  ```
- **Seed admin:**
  ```
  docker compose exec -e HADIR_SEED_PASSWORD='...' backend \
    python -m scripts.seed_admin --email admin@pilot.hadir --full-name "Pilot Admin"
  ```
  Re-running is safe — upserts the user and idempotently asserts the
  `Admin` role. The script never logs the password.
- **Run migrations manually:**
  - All schemas (every tenant): `docker compose exec backend python -m scripts.migrate`
  - One schema (e.g. just `main`): `docker compose exec backend alembic -x schema=main upgrade head`
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

## Auth (P3)
Endpoints:
- `POST /api/auth/login` — body `{email, password}`. 200 sets the
  `hadir_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure=False` in
  dev, `Path=/`, `Max-Age=HADIR_SESSION_IDLE_MINUTES * 60`). 401 on bad
  credentials. 429 when rate-limited.
- `POST /api/auth/logout` — 204, deletes the session row and clears the
  cookie. Requires an authenticated session.
- `GET  /api/auth/me` — returns `{id, email, full_name, roles[], departments[]}`.

Sessions: stored in `main.user_sessions`; ID is `secrets.token_urlsafe(48)`.
Sliding expiry — every authenticated request bumps `expires_at` by
`HADIR_SESSION_IDLE_MINUTES` (default 60) and refreshes the cookie Max-Age.
Expired sessions are deleted and audited as `auth.session.expired`. Never
use JWT here.

Dependencies (in `hadir.auth`):
- `current_user` — resolves the session, refreshes expiry, sets
  `request.state.tenant_id`, returns `CurrentUser`. 401 on missing /
  invalid / expired / inactive.
- `require_role("Admin")`, `require_any_role("Admin", "HR")` — 403 guards
  that compose on `current_user`.
- `require_department` — reads the path param `department_id`. Admin/HR
  bypass; everyone else must be a member.

Audit actions emitted by this module (all INSERT only, via
`hadir_app` — see "Database roles and grants"):
- `auth.login.success`   (entity=user)
- `auth.login.failure`   (entity=user; records `email_attempted`, `reason`
  in `{unknown_email, wrong_password, inactive_user}`, `attempts`, `ip`)
- `auth.login.rate_limited` (entity=user, entity_id null)
- `auth.logout`          (entity=session)
- `auth.session.expired` (entity=session)

**Red line reinforcement:** the plain password never appears in an audit
row, a log line, an exception message, or a response body. If you ever
see it somewhere, that's a bug — fix it, don't justify it.

## Rate limiter (pilot-grade)
In-memory `(email_lower, ip) -> count`, max attempts
`HADIR_LOGIN_MAX_ATTEMPTS` (default 10), reset every
`HADIR_LOGIN_RATE_LIMIT_RESET_MINUTES` (default 10) by an APScheduler job
started via the FastAPI lifespan. On successful login the counter for
that key is cleared. This is a pilot-only placeholder — it has no
cross-process coordination and forgets on restart. **v1.0 must replace it
with a Redis-backed bucket before going to production.**

## Testing
Tests run inside the backend container against the compose Postgres:
```
docker compose exec backend pytest -q
```
Fixtures create/delete test users via the admin engine, so `audit_log`
rows created during a test can be cleaned up (the app role cannot DELETE
from the audit log — that's the point of P2).

## Employees (P5)
All endpoints are **Admin-only** in the pilot (v1.0 opens HR read
access). Every call writes one or more audit rows via the append-only
``write_audit`` helper.

| Method + Path                    | Purpose                                       | Audit actions                          |
| -------------------------------- | --------------------------------------------- | -------------------------------------- |
| `GET  /api/employees`            | Paginated list, text search on code/name/email/department, `department_id` filter, `include_inactive` toggle | — (reads) |
| `POST /api/employees`            | Create one                                    | `employee.created`                     |
| `GET  /api/employees/{id}`       | Detail (returns inactive rows too)            | —                                      |
| `PATCH /api/employees/{id}`      | Partial edit                                  | `employee.updated` with before+after   |
| `DELETE /api/employees/{id}`     | Soft delete (sets `status='inactive'`)        | `employee.soft_deleted`                |
| `POST /api/employees/import`     | Multipart XLSX upsert by `employee_code`      | `employee.created`/`employee.updated` per row + one `employee.imported` summary |
| `GET  /api/employees/export`     | Streams XLSX (includes inactive + photo_count)| `employee.exported`                    |

**Import contract**: XLSX headers (case + space insensitive):
`employee_code`, `full_name`, `email`, `department_code`. Upsert by
`employee_code` within the tenant. Unknown `department_code` and
within-file duplicate `employee_code` produce per-row errors; the rest
of the file commits normally. The response shape is
`{created, updated, errors: [{row, message}]}` where `row` is the
**Excel row number** (1-indexed; data starts at row 2). Per-row
transactions so a row's DB failure doesn't roll back earlier rows' audit
writes.

**Export contract**: XLSX with columns
`employee_code, full_name, email, department_code, status, photo_count`.
Includes inactive rows so an operator can reconcile historical data.

**Hard delete is deliberately not exposed.** It will arrive with the
PDPL right-to-erasure request flow (v1.0) and must route through the
audit log with operator justification. Soft-delete sets
`status='inactive'` and hides the row from default list/search.

## Photos (P6)
All photo endpoints are Admin-only and audit-logged. Endpoints live
under the same `/api/employees` prefix:

| Method + Path                                      | Purpose                                                  | Audit                                 |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `POST /api/employees/{id}/photos`                  | Drawer upload — multiple files, one `angle` form field   | `photo.ingested` per file             |
| `POST /api/employees/photos/bulk`                  | Folder dump — angle inferred from filename convention    | `photo.ingested` + `photo.rejected`   |
| `GET  /api/employees/{id}/photos`                  | List photos (id, angle, employee_id) for the employee    | —                                     |
| `GET  /api/employees/{id}/photos/{photo_id}/image` | Decrypt + stream the JPEG (auth-gated)                   | `photo.viewed`                        |
| `DELETE /api/employees/{id}/photos/{photo_id}`     | Drop DB row + best-effort remove encrypted file on disk  | `photo.deleted`                       |

**Filename convention** (PROJECT_CONTEXT §3) recognised by the bulk
endpoint:
```
OM0097.jpg          → front (unlabelled defaults to front)
OM0097_front.jpg    → front
OM0097_left.jpg     → left
OM0097_right.jpg    → right
OM0097_other.jpg    → other
```
An unmatched `employee_code` is a **rejection**, never an auto-create.
Both rejections and accepts go to the audit log.

**Encryption at rest**: photo bytes are encrypted with Fernet
(`HADIR_FERNET_KEY`) before being written to
`/data/faces/{tenant_id}/{employee_code}/{angle}/{uuid}.jpg`. Opening
the file in an image viewer produces garbage — by design. The path
itself is not sensitive and is stored plaintext in
`employee_photos.file_path`. Pilot: all admin-ingested photos are
considered approved (`approved_by_user_id` = ingesting admin); the
self-upload + approval-queue workflow is deferred per
PROJECT_CONTEXT §8.

**No embeddings yet** — the `embedding` column doesn't exist on
`employee_photos` until P9 adds it via Alembic.

## Cameras (P7)
All endpoints Admin-only. Every audit row and log line uses
``rtsp_host`` at most — the plaintext URL only ever exists inside a
decrypt-to-use block (encrypt on write; decrypt to hit the camera;
discard). If you see a full ``rtsp://user:pass@…`` anywhere outside
``rtsp.py``, that is a bug — fix it, don't justify it.

| Method + Path                         | Purpose                                           | Audit                                   |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `GET  /api/cameras`                   | List; returns ``rtsp_host`` only (never the URL)  | —                                       |
| `POST /api/cameras`                   | Create; Fernet-encrypts the URL before insert     | `camera.created` (after.rtsp_host only) |
| `PATCH /api/cameras/{id}`             | Partial edit; omitted ``rtsp_url`` keeps cipher   | `camera.updated` (before/after rtsp_host + `rtsp_url_rotated` flag if host unchanged) |
| `DELETE /api/cameras/{id}`            | Hard delete                                       | `camera.deleted`                        |
| `GET  /api/cameras/{id}/preview`      | Single JPEG frame; 5-second hard timeout; closes  | `camera.previewed` (rtsp_host only)     |

The preview path runs the OpenCV grab on a throwaway worker thread
inside a ``concurrent.futures`` 5-second wall clock. On timeout or
unreachable host it returns **504** with a host-safe detail string
(``"preview timed out"`` / ``"could not open stream"``). The capture
pipeline (P8) reuses ``rtsp.decrypt_url`` + ``rtsp.rtsp_host`` from
this module and runs its own long-lived reader — the preview never
shares a stream handle with the background workers.

## Capture pipeline (P8)
One background worker thread per enabled camera. Spawned by the
``capture_manager`` singleton on FastAPI lifespan startup; hot-reloaded
when the P7 router processes a camera create / update / delete.

**Worker loop** (``hadir/capture/reader.py``):

1. ``cv2.VideoCapture(plain_url)``; on failure record a health snapshot
   with ``reachable=false`` + exponential backoff and retry.
2. Read frames at ``target_fps=4`` (configurable). Each frame goes
   through ``analyzer.detect`` → ``IoUTracker.update``.
3. **One ``detection_events`` row per track entry**, not per frame.
   The tracker flags ``is_new=True`` on the first frame of a track;
   every continuation frame returns the same ``track_id`` with
   ``is_new=False`` and is intentionally ignored. This is what keeps
   the events table bounded regardless of dwell time.
4. On emit: crop the frame to the bbox → JPEG-encode → Fernet-encrypt
   → write to
   ``/data/faces/captures/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.jpg`` →
   insert the ``detection_events`` row. P9 backfills the embedding /
   employee_id / confidence columns.
5. Every 60 s, write one ``camera_health_snapshots`` row with
   ``frames_last_minute`` and ``reachable=true`` and bump
   ``cameras.last_seen_at``.

**Durability contract**: the on-disk crop write happens before the DB
insert, and both complete before the worker advances to the next
detection. If the process crashes between write and insert we leak an
unreferenced file (acceptable pilot trade-off); once the row is
committed the event survives a restart. On-disk crops are always
Fernet-encrypted — opening one with an image viewer produces garbage.

**Plaintext URL lifecycle**: the decrypted URL exists only on the
worker's stack frame. On rotate/delete the manager stops the worker
(which drops its reference) and spawns a new one with the freshly
decrypted new URL. No log line, audit row, or exception message ever
carries it.

**Hot-reload**: ``capture_manager.on_camera_created/updated/deleted``
are called by the P7 router. ``on_camera_updated`` always stops the
old worker and re-reads the DB row, so credential rotations and
enabled-flag toggles take effect immediately without polling.

**Config knobs** (see ``ReaderConfig`` in ``reader.py``):
``target_fps`` (4), ``iou_threshold`` (0.3), ``track_idle_timeout_s``
(3), ``reconnect_backoff_initial_s`` (1), ``reconnect_backoff_max_s``
(30), ``health_interval_s`` (60). All overridable from
``capture_manager.start(config=…)``.

**Test isolation**: ``tests/conftest.py`` installs an autouse
session-scoped fixture that neutralises ``capture_manager.start/stop``,
so ``TestClient(app)`` entering the lifespan doesn't try to spawn real
workers. The P8 tests instantiate their own ``CaptureManager`` objects
with stubbed analyzers and scripted ``VideoCapture`` feeds — the suite
runs without OpenCV touching a real camera or InsightFace loading the
buffalo_l model.

## Identification (P9)
Every ``employee_photos`` row gets a Fernet-encrypted
``embedding BYTEA`` (512 × float32, L2-normalised) computed from the
decrypted reference photo via InsightFace ``buffalo_l`` recognition.

Trigger points:

- **On photo upload** (P6 ingest, both drawer and bulk paths) — the
  employees router calls ``id_enrollment.enroll_photo`` right after
  the DB row is created. Failure is non-fatal; the row just stays
  embedding-less until ``/reembed`` retries.
- **On photo delete** — the employees router calls
  ``matcher_cache.invalidate_employee`` before returning 204 so we
  don't keep matching against a stale vector.
- **On startup** — the FastAPI lifespan kicks off
  ``enroll_missing`` on a daemon thread so the HTTP server comes up
  immediately.
- **On demand** — ``POST /api/identification/reembed`` (Admin only)
  clears every embedding for the tenant and recomputes from scratch.
  Audits as ``identification.reembedded`` with enrolled/skipped/errors.

**Matching** (``hadir.identification.matcher``):

- ``MatcherCache`` singleton holds ``{tenant_id → {employee_id →
  stacked (N, 512) ndarray}}`` in memory. Loads lazily on first
  ``match()`` call; per-employee invalidation only reloads the
  affected entry.
- For each detection embedding, we compute the cosine similarity
  against every enrolled angle vector, then for each employee take
  the **mean of the top-k** (k=1 for pilot — i.e. "best angle wins").
  The employee with the highest per-employee score takes the row,
  **only if** the score is at or above ``HADIR_MATCH_THRESHOLD``.
- Threshold is **hard, not advisory** (PROJECT_CONTEXT §12 /
  pilot-plan red line). Below threshold → ``employee_id`` stays NULL
  and the detection is marked unidentified.
- At DEBUG, the matcher logs the top-3 scored employees per event so
  operators can eyeball the score distribution during pilot tuning.

**Event-row update**: ``emit_detection_event`` now accepts an optional
``embedding`` kwarg. When present we Fernet-encrypt it, call the
matcher, and persist ``embedding`` + ``employee_id`` + ``confidence``
on the same ``INSERT`` — no subsequent UPDATE pass is needed.

**Test isolation**: ``tests/conftest.py`` installs a
``_NoopAnalyzer`` as the session-wide analyzer factory. Photo-upload
and lifespan-backfill paths call ``get_analyzer().embed_crop`` →
returns ``None`` → enrollment marks the photo as skipped. The suite
runs in ~3 seconds without touching InsightFace or the ~250 MB
``buffalo_l`` model.

## Attendance (P10)
- `hadir.attendance.engine.compute(...)` is **pure** — no DB, no
  network. Inputs: employee_id, the_date, ``ShiftPolicy``, list of
  per-day events (already converted to wall-clock local times),
  optional leaves/holidays. Output: ``AttendanceRecord`` value object
  carrying in/out/total/late/early_out/short_hours/absent/overtime.
  Tests in ``test_attendance_engine.py`` cover the rule set without
  touching Postgres.
- ``hadir.attendance.repository`` does the side-effecty work:
  ``active_policy_for`` resolves the Fixed pilot policy;
  ``events_for`` converts UTC ``detection_events.captured_at`` to
  ``HADIR_LOCAL_TIMEZONE`` (default ``Asia/Muscat``) and returns
  naive local datetimes the engine compares directly;
  ``upsert_attendance`` persists via Postgres ``ON CONFLICT``.
- ``hadir.attendance.scheduler.attendance_scheduler`` runs an
  APScheduler interval job every
  ``HADIR_ATTENDANCE_RECOMPUTE_MINUTES`` (default 15). Recomputes
  today's row for every active employee — never historical days
  (frozen-after-rollover per pilot-plan; v1.0 adds late recompute).
  ``start()`` spawns a daemon thread that does an immediate seed pass
  so the first request after lifespan finds rows already in place.
- ``GET /api/attendance?date=…&department_id=…`` is role-scoped:
  Admin/HR see everything; Manager is auto-scoped to their assigned
  department(s) and is forbidden from filtering across them; Employee
  sees their own row only (employee↔user is matched by lower-cased
  email until v1.0 adds an explicit join table).

The tests' ``conftest.py`` neutralises ``attendance_scheduler.start/stop``
so ``TestClient(app)`` lifespan entries don't spawn 15-minute job
threads on every test.

## P11 endpoints
All Admin-only.

| Method + Path | Notes |
| --- | --- |
| `GET /api/detection-events` | Paginated (100 default, max 200). Filters: `camera_id`, `employee_id`, `identified` (bool), `start`, `end` (ISO datetime). Returns `{items, total, page, page_size}` with each item carrying camera + employee join + `has_crop` flag for the UI. |
| `GET /api/detection-events/{id}/crop` | Decrypts the Fernet-encrypted JPEG on disk (P8 storage) and streams it. Writes a `detection_event.crop_viewed` audit row per fetch (entity_id = event id, after = `{camera_id, employee_id}`). 410 if the file is missing on disk. |
| `GET /api/system/health` | Uptime, process pid, active DB connections (`pg_stat_activity`), capture-workers count, attendance-scheduler/rate-limiter running flags, enrolled-employees + active-employees + cameras totals, today's events + attendance counts. |
| `GET /api/system/cameras-health` | Per-camera latest snapshot (`frames_last_minute`, `reachable`, `last_seen_at`) + 24-hour `series_24h` of `(captured_at, frames_last_minute, reachable)`. |
| `GET /api/audit-log` | Paginated read-only list. Filters: `actor_user_id`, `action`, `entity_type`, `start`, `end`. Response includes `distinct_actions` + `distinct_entity_types` so the UI's filter selectors stay in sync. **No write handlers** anywhere — UPDATE/DELETE on `audit_log` would also be rejected at the DB grant level (P2). |
| `GET /api/attendance/me/recent?days=N` | (P12) Self-only history for the logged-in user, last `N` days (default 7, max 90). Resolves user→employee by lower-cased email; returns `{date, items:[]}` if no employee row matches. |
| `POST /api/reports/attendance.xlsx` | (P13) On-demand attendance Excel. Body: `{start, end, department_id?, employee_id?, max_days?}`. Admin/HR see all rows; Manager auto-scoped to assigned departments and 403'd on cross-dept filter; Employee 403'd outright. Sheets named by ISO week (e.g. `2026-W17`). Audited as `report.generated`. |
| `POST /api/_test/seed_detection` | (P13, **DEV ONLY**) Insert one identified `detection_events` row for the named employee. Mounted only when `HADIR_ENV=dev`. |
| `POST /api/_test/recompute_attendance` | (P13, **DEV ONLY**) Run today's attendance recompute synchronously so the smoke test doesn't have to wait for the 15-min scheduler. |

## Dev-only test endpoints (P13)
The `hadir/_test_endpoints/` package exists solely to make
`frontend/tests/pilot-smoke.spec.ts` runnable without a live camera or
the 15-minute scheduler delay. **Red line**: `hadir.main.create_app`
mounts the router **only when** `HADIR_ENV=dev`. A production build
(env=staging|production) cannot serve `/api/_test/*` even if an
operator imports the module by accident — the include_router call
sits inside the env conditional. See `docs/pilot-deployment.md` for
the operator-facing version of this rule.

## Pilot prompt currently active
P13 — done. Next: **P14 — Omran on-site deployment + acceptance
walkthrough.** Wait for the user before starting P14. Walk through
the demo script in pilot-plan.md §P13 first to surface any UX
papercuts.
