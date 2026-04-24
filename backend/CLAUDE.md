# Hadir backend — Claude Code notes

## Status
P1 + P2 + P3 + P5 + P6 + P7 complete. **P8 complete**: per-camera
background capture workers (4 fps, reconnect-with-backoff), IoU
tracker, detection_events emitted one-per-track-entry, Fernet-encrypted
crops under `/data/faces/captures/`, per-minute camera_health_snapshots.
Capture manager hot-reloads on camera CRUD. P9 next — wait for the user.

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
  entrypoint.sh                # alembic upgrade head; exec uvicorn
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
      analyzer.py              # Analyzer protocol + InsightFace buffalo_l wrapper + test stub hook
      events.py                # emit_detection_event: encrypt crop + DB insert; write_health_snapshot
      reader.py                # CaptureWorker: 4 fps read loop + reconnect backoff + per-minute health flush
      manager.py               # CaptureManager singleton + on_camera_created/updated/deleted hooks
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

## Pilot prompt currently active
P8 — done. Next: **P9 — Face identification (InsightFace embeddings +
matching).** Wait for the user before starting P9.
