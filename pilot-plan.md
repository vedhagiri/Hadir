# Hadir — Pilot Plan (v0.1)

> **Historical (pilot delivered).** This plan describes the 5-day pilot
> build, frozen at tag `v0.1-pilot` on branch `release/pilot`. Active
> development now follows `v1.0-phase-plan.md` on `main`. Consult this
> file only when triaging a pilot-era issue; do not pull prompts from
> here into a v1.0 session.

**Purpose:** Step-by-step Claude Code prompts to stand up the 5-day pilot build. This file lives at the repo root and is the authoritative sequence of work for the pilot.

**Audience:** Suresh (driving Claude Code sessions) and any future Claude Code session picking up mid-pilot.

**Scope source:** BRD §7.1.1 and PROJECT_CONTEXT.md §8. The pilot is a **demo, not production**. Everything in the deferred list (BRD Appendix A / PROJECT_CONTEXT §8) stays deferred. If a prompt starts pulling in approval workflow, multi-tenancy provisioning, Arabic translation, OIDC, or scheduled reports — stop, push back, update this file.

**Last updated:** Day 0 (pre-build)
**Status:** Ready to execute

---

## How to run these prompts

1. **One prompt per Claude Code session.** Do not paste two in a row.
2. **Every prompt ends with "stop and show me".** Claude Code must not auto-continue to the next session.
3. **Commit after every approved session.** `git log` becomes the audit trail of the build. Use conventional messages: `feat(P3): local auth with argon2 + server-side sessions`.
4. **Review before committing.** Spin up the app, click through, check DB state, then approve.
5. **If a session runs long,** stop it at the logical checkpoint and re-prompt. Don't let one session balloon to 6 hours.
6. **Keep `CLAUDE.md` current.** Every prompt below instructs Claude Code to update `CLAUDE.md` at the end. If it forgets, that's part of the review gate.

---

## Red lines (repeat in every session as needed)

These come from PROJECT_CONTEXT.md §12 and are non-negotiable throughout the pilot:

- **Tenant plumbing from day 1.** `tenant_id` columns exist on every tenant-scoped table and are passed through every query, even though pilot is single-schema and `tenant_id = 1` always. This lets v1.0 add multi-tenancy without a rewrite.
- **RTSP credentials encrypted with Fernet.** Key from `HADIR_FERNET_KEY` env var. Never in logs, never in API responses. On reads, return `***`.
- **Passwords never logged.** Argon2 hashes are fine in DB; plain passwords never appear anywhere.
- **Audit log is append-only.** No UPDATE or DELETE from the application database user. Grant `INSERT, SELECT` only on `audit_log`.
- **No speculative design improvements.** The design archive at `frontend/src/design/` is authoritative. Copy CSS verbatim. Do not "enhance" the look.
- **No scope creep into v1.0 features.** If a prompt starts adding exception requests, approval workflow, Arabic, dark-mode toggle wiring, PDF, email scheduling, OIDC, HTTPS, Super-Admin, or per-tenant branding — stop and push back.

---

## Pre-flight (Suresh does this BEFORE P1 — no Claude Code yet)

1. Provision a dev machine (Ubuntu 22.04 or macOS) with Node 20+, Python 3.11, Docker + Docker Compose, Postgres client tools.
2. Create GitHub repo `hadir` (private). Clone locally.
3. Add these files to the repo root:
   - `PROJECT_CONTEXT.md` — from planning phase
   - `pilot-plan.md` — this file
   - `Hadir_v1.0_BRD.docx` — optional, for reference
   - Unzip `Globe_loader__3_.zip` into `design-reference/` at the repo root. Do **not** commit the archive itself; commit the unpacked files so Claude Code can read them.
4. Prepare pilot test assets on the dev box:
   - One IP camera reachable by RTSP, credentials known
   - 5–10 test photos named `OM0097.jpg`, `OM0097_front.jpg`, `OM0098.jpg`, etc.
   - A small sample employees Excel (`employees_sample.xlsx`) with IDs matching the photos
5. Generate a Fernet key for local dev:
   ```bash
   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
   Save it — P1 will ask for it in `.env`.
6. Verify `claude-code` is installed and you can start a session in the repo root.

Proceed to P1 only when all of the above is done.

---

## Day 1 — Foundation (P1, P2, P3)

### P1 — Repo scaffold and skeleton apps (~3 hours)

**Goal:** Monorepo boots with `docker compose up`. Backend serves `/api/health`. Frontend serves a placeholder page using the Hadir CSS verbatim.

**Prompt:**

> You are starting work on Hadir, a camera-based employee attendance platform built by Muscat Tech Solutions for Omran (Oman). Before writing anything, read `PROJECT_CONTEXT.md` and `pilot-plan.md` at the repo root. Confirm you understand that this session is **P1 — Repo scaffold and skeleton apps** and that its scope is exactly what is written here.
>
> In this session:
>
> 1. Create the monorepo structure exactly as specified in PROJECT_CONTEXT §7: `backend/`, `frontend/`, `docker-compose.yml`, root-level `CLAUDE.md`, `.gitignore`.
> 2. **Backend skeleton:** Python 3.11, FastAPI, Uvicorn, SQLAlchemy 2.x Core, Pydantic v2 settings, Argon2-cffi, python-dotenv. Expose `GET /api/health` returning `{"status":"ok"}`. Log to stdout. Add a `backend/CLAUDE.md`. Dev tooling: ruff, black, mypy.
> 3. **Frontend skeleton:** Vite + React 18 + TypeScript strict mode. Add React Router v6, TanStack Query, Zustand, React Hook Form, Zod. No Tailwind, no CSS-in-JS. Render a single page reading "Hadir" using `src/styles/` CSS. Add `frontend/CLAUDE.md`.
> 4. **Design archive integration:** From `design-reference/` at the repo root, copy `styles.css`, `styles-enhancements.css`, `styles-enhancements2.css`, `styles-enhancements3.css` **verbatim** into `frontend/src/styles/`. Copy `icons.jsx`, `shell.jsx`, `ui.jsx`, `pages.jsx`, `dashboards.jsx`, `employee.jsx`, `data.jsx` into `frontend/src/design/` as read-only reference for later sessions. Import all four CSS files in order in `src/main.tsx`.
> 5. **Docker Compose:** services `backend` (Python), `frontend` (Vite dev), `postgres` (15). Volumes for node_modules and Postgres data. Environment via `.env` at repo root and `.env.example` per service.
> 6. **.env.example** at repo root with: `HADIR_DATABASE_URL`, `HADIR_SESSION_SECRET`, `HADIR_FERNET_KEY`, `HADIR_TENANT_MODE=single`, `HADIR_ENV=dev`.
> 7. Write the root `CLAUDE.md` so a future Claude Code session can read it and understand the current state: tech stack summary, directory map, how to run, which pilot prompt is active.
>
> Red lines to respect: design files are copied verbatim — do not "fix", reformat, or convert anything. No Tailwind. No extra dependencies beyond what this prompt names.
>
> When `docker compose up` succeeds, the frontend is reachable at `http://localhost:5173`, the backend health endpoint returns 200, and `CLAUDE.md` is up to date — commit with message `feat(P1): repo scaffold + skeleton apps`, **stop, and show me**. Do not start P2.

**Review checklist:**
- [ ] `docker compose up` boots all three services without error
- [ ] `curl http://localhost:8000/api/health` → 200
- [ ] `http://localhost:5173` renders "Hadir" with the warm-neutral background from `styles.css`
- [ ] `frontend/src/design/` contains the archive files, untouched
- [ ] `backend/`, `frontend/`, root `CLAUDE.md` all present and accurate
- [ ] No Tailwind, no CSS-in-JS, no extra deps

---

### P2 — Database schema, migrations, multi-tenant plumbing (~3 hours)

**Goal:** Alembic is wired. Core tables exist in a schema named `main`. Every tenant-scoped table carries `tenant_id`. `audit_log` is append-only at the DB grant level.

**Prompt:**

> Session **P2 — Database schema, migrations, multi-tenant plumbing**. Read `CLAUDE.md` and confirm P1 is complete before proceeding.
>
> In this session:
>
> 1. Add Alembic to the backend. Configure it to target a schema named `main` in the Postgres URL from `HADIR_DATABASE_URL`.
> 2. Create the initial migration with these tables, all under schema `main`:
>    - `tenants` (id, name, created_at) — pilot seeds one row with id=1, name='Omran'
>    - `users` (id, tenant_id, email [citext, unique per tenant], password_hash, full_name, is_active, created_at)
>    - `roles` (id, tenant_id, code, name) — seed: Admin, HR, Manager, Employee
>    - `user_roles` (user_id, role_id, tenant_id) — composite PK
>    - `departments` (id, tenant_id, name, code)
>    - `user_departments` (user_id, department_id, tenant_id) — composite PK
>    - `user_sessions` (id, tenant_id, user_id, expires_at, data JSONB, created_at, last_seen_at)
>    - `audit_log` (id, tenant_id, actor_user_id, action, entity_type, entity_id, before JSONB, after JSONB, created_at)
> 3. **Multi-tenant plumbing:** every table above (except `tenants`) carries a non-null `tenant_id` with FK to `tenants(id)`. Create a `tenant_scope` dependency in the backend that reads `tenant_id` from the session (default 1 for pilot) and injects it into every repository function. Every SQL statement against these tables filters by `tenant_id`. This matters: the pilot runs fine on one tenant, but the plumbing has to be real so v1.0 multi-tenant migration is additive, not invasive.
> 4. **Audit log append-only:** create two Postgres roles — `hadir_app` (INSERT, SELECT, UPDATE, DELETE on most tables; but **only INSERT + SELECT on audit_log**) and `hadir_admin` (full access, used only for migrations and manual ops). The app connects as `hadir_app`. Document this in `backend/CLAUDE.md`.
> 5. **Seed admin script** at `backend/scripts/seed_admin.py`: takes email + password from CLI args or env, creates a user with the Admin role in tenant 1, prints the result. Argon2 hash only; no plain-text password in logs.
> 6. Update `backend/CLAUDE.md` with the schema map and the tenant plumbing pattern so future sessions keep following it.
>
> Red lines: no table without `tenant_id` plumbing (except `tenants` itself). No plain-text passwords in code, logs, or fixtures. `audit_log` grants must reject UPDATE and DELETE at the DB level, not just in code.
>
> When the migration runs cleanly from a fresh Postgres volume, the seed admin script creates a usable admin, and the grants are verified (try an UPDATE on audit_log as `hadir_app` — it must fail) — commit as `feat(P2): schema + migrations + tenant plumbing`, **stop, and show me**. Do not start P3.

**Review checklist:**
- [ ] `alembic upgrade head` creates all tables in schema `main`
- [ ] `seed_admin.py` creates an admin user; password is hashed
- [ ] `UPDATE audit_log SET action='x'` as `hadir_app` raises a permissions error
- [ ] Every tenant-scoped table has `tenant_id NOT NULL` with an FK

---

### P3 — Local auth, server-side sessions, role guards (~3 hours)

**Goal:** Email + password login works end to end. Sessions live in Postgres. Backend guards routes by role. Login and logout write audit entries.

**Prompt:**

> Session **P3 — Local auth, server-side sessions, role guards**. Read `CLAUDE.md` and confirm P1–P2 are complete.
>
> In this session:
>
> 1. Implement email + password login using Argon2-cffi. Email match is case-insensitive (store lowercased; use `citext` at the DB level per P2).
> 2. Session storage in the `user_sessions` table (not JWT). Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` off in dev, path `/`. Idle timeout configurable via `HADIR_SESSION_IDLE_MINUTES` (default 60). Expiry sliding: refresh on every authenticated request.
> 3. Endpoints:
>    - `POST /api/auth/login` — body `{email, password}`, 200 on success with session cookie, 401 otherwise
>    - `POST /api/auth/logout` — clears session
>    - `GET /api/auth/me` — returns `{id, email, full_name, roles: [...], departments: [...]}`
> 4. FastAPI dependencies:
>    - `current_user` — raises 401 if no valid session
>    - `require_role("Admin")` / `require_any_role("Admin", "HR")`
>    - `require_department(dept_id)` — for Manager-scoped endpoints later
>    - `tenant_scope` from P2 composes with `current_user`
> 5. Write audit entries for login (success and failure — failure records email attempted, no password), logout, and session expiry. Use the append-only insert path from P2.
> 6. Rate-limit login attempts by email+IP (simple in-memory counter for pilot; APScheduler reset every 10 minutes; note in `backend/CLAUDE.md` that this is pilot-grade and will be replaced).
> 7. Backend pytest suite: happy path login, wrong password, expired session, role guard allow/deny, audit entries written.
>
> Red lines: plain passwords must never appear in request logs, response bodies, error messages, or audit entries. The audit log INSERT happens through the same `hadir_app` user with grants as defined in P2 — if UPDATE/DELETE ever appears in an audit flow, stop and fix it.
>
> When `curl`-based login produces a session cookie, `/api/auth/me` returns the admin seeded in P2, logout clears the session, and tests pass — commit as `feat(P3): local auth + sessions + role guards`, **stop, and show me**. Do not start P4.

**Review checklist:**
- [ ] Login with seeded admin from P2 succeeds
- [ ] `/api/auth/me` returns `roles: ["Admin"]`
- [ ] Wrong password returns 401, writes an audit entry, logs no password
- [ ] `audit_log` rows exist for login, logout
- [ ] pytest suite green

---

## Day 2 — Config surface (P4, P5, P6)

### P4 — Frontend shell, login page, role-aware navigation (~3 hours)

**Goal:** User can log in via the UI. Sidebar and topbar render per role using the literal `shell.jsx` structure from the design archive. Placeholder pages exist for every nav item.

**Prompt:**

> Session **P4 — Frontend shell, login page, role-aware navigation**. Read `CLAUDE.md` and confirm P1–P3 are complete.
>
> In this session:
>
> 1. **AuthProvider** in `frontend/src/auth/` using TanStack Query: `useMe()` hits `/api/auth/me`, `useLogin()` and `useLogout()` are mutations. Redirect to `/login` on 401.
> 2. **Login page** at `/login`. React Hook Form + Zod validation. Only email and password fields. On success, redirect to `/` (role-default landing).
> 3. **Shell:** port the structure from `frontend/src/design/shell.jsx` into working React Router v6 routes. Sidebar width 232px, topbar height 52px, max content width 1320px — all from the CSS variables already in the archive, do not redefine them. Use `icons.jsx` from the design archive for nav icons.
> 4. **Role-aware nav:** the `NAV` constant in `shell.jsx` already defines the per-role menu for Admin / HR / Manager / Employee. Use it literally. If the logged-in user has multiple roles, pilot behaviour is: use the highest role only (Admin > HR > Manager > Employee). Full role switcher is deferred per PROJECT_CONTEXT §8; add a TODO comment noting that.
> 5. **Placeholder pages** for every route ID in `NAV`: a simple page component that renders the page title and `<p>Coming in P{N}</p>`. Wire routes in `App.tsx`.
> 6. **Topbar:** user name, role badge, logout button. No role switcher in pilot (deferred).
> 7. **Dark mode:** CSS is already present in the archive and loaded in P1. Do **not** wire up a toggle. Leave the app in light mode. This is deferred per PROJECT_CONTEXT §8.
> 8. No Arabic, no RTL. English only in pilot.
>
> Red lines: do not rewrite, "improve", or reformat styles from `styles.css` or any enhancement CSS. Do not import a component library. Do not introduce Tailwind. Primary buttons are black per the design system — resist the urge to use the teal accent for them.
>
> When you can log in as the P2 admin, see the Admin sidebar matching the design, navigate to every placeholder page, and log out — commit as `feat(P4): frontend shell + login + role-aware nav`, **stop, and show me**. Do not start P5.

**Review checklist:**
- [ ] Login UI looks like the design (check against `design-reference/Hadir.standalone.html`)
- [ ] Admin sidebar matches `NAV.Admin` from `shell.jsx` in order and labels
- [ ] Placeholder pages render for every nav item
- [ ] Log out returns to `/login`
- [ ] No console errors

---

### P5 — Employees backend + Excel import/export (~3 hours)

**Goal:** Employees can be created via UI and imported in bulk from Excel. Text search works by ID, name, email, and department.

**Prompt:**

> Session **P5 — Employees backend + Excel import/export**. Read `CLAUDE.md` and confirm P1–P4 are complete.
>
> In this session:
>
> 1. **Tables** (new Alembic migration):
>    - `employees` (id, tenant_id, employee_code [e.g. OM0097, unique per tenant], full_name, email, department_id, status, created_at)
>    - `employee_photos` (id, tenant_id, employee_id, angle [front/left/right/other], file_path, approved_by_user_id, approved_at, created_at) — schema only, photo files come in P6
> 2. **Endpoints** (all Admin-only for pilot; v1.0 will open HR read access):
>    - `GET /api/employees` — text search by id/name/email/department, dept filter, paginated
>    - `POST /api/employees` — create one
>    - `PATCH /api/employees/{id}` — edit
>    - `DELETE /api/employees/{id}` — soft delete (status=inactive; hard delete reserved for PDPL request flow later)
>    - `GET /api/employees/{id}` — detail
>    - `POST /api/employees/import` — multipart Excel upload, returns `{created, updated, errors: [{row, message}]}`
>    - `GET /api/employees/export` — streams XLSX
> 3. **Excel import parser:** use `openpyxl`. Expected columns: `employee_code, full_name, email, department_code`. Upsert by `employee_code`. Unknown department codes → row error, skipped. All changes audit-logged.
> 4. **Excel export:** same columns plus `status` and `photo_count`.
> 5. Seed 3 departments (e.g. Engineering, Operations, Admin) via Alembic data migration for pilot.
> 6. Pytest: import with 5 rows (3 valid, 1 bad dept, 1 duplicate), export round-trip, search hits, soft-delete hides from list.
>
> Red lines: `tenant_id` on every query. Audit-log every create, update, import, and delete.
>
> When the import endpoint accepts the sample Excel from the Suresh pre-flight and the list reflects it — commit as `feat(P5): employees backend + excel import/export`, **stop, and show me**. Do not start P6.

**Review checklist:**
- [ ] `POST /api/employees/import` with sample Excel returns a success summary
- [ ] `GET /api/employees?q=OM0097` returns the expected row
- [ ] Unknown department in Excel produces a row error, not a crash
- [ ] Export file opens cleanly in Excel

---

### P6 — Employees frontend + photo ingestion (~3 hours)

**Goal:** Admin can import the Excel, drop photos by filename, see photo counts on employee cards.

**Prompt:**

> Session **P6 — Employees frontend + photo ingestion**. Read `CLAUDE.md` and confirm P1–P5 are complete.
>
> In this session:
>
> 1. **Employees list page** (replaces P4 placeholder): table with search, department filter, photo count, status. Layout and styling from `frontend/src/design/employee.jsx` and `pages.jsx` — port, don't redesign.
> 2. **Import flow:** drag-and-drop or file picker for `.xlsx`. POST to `/api/employees/import`. Show per-row results: created / updated / errors. Do not close the modal until the user acknowledges.
> 3. **Employee detail drawer:** slides over from the right per the design. Shows profile fields, department, status, photo gallery with angle labels.
> 4. **Photo ingestion:**
>    - Frontend: drop zone on the detail drawer accepting multiple images at once.
>    - Backend endpoint `POST /api/employees/{id}/photos` (multipart, multiple files). Also expose `POST /api/employees/photos/bulk` that accepts a folder-dump where filenames use the `OM0097.jpg` / `OM0097_front.jpg` / `OM0097_left.jpg` / `OM0097_right.jpg` convention from PROJECT_CONTEXT §3. Unlabelled = `front`. The backend parses the filename, resolves the employee by `employee_code`, and creates `employee_photos` rows. If the employee record does not exist → reject the photo (never auto-create employees).
>    - Storage: files written to `/data/faces/{tenant_id}/{employee_code}/{angle}/{uuid}.jpg`. Files on disk must be encrypted at rest — use Fernet from `HADIR_FERNET_KEY` to encrypt the image bytes before writing; decrypt on read.
>    - No embeddings yet. That is P9. The DB row exists; the embedding column is null.
> 5. Self-photo upload and Admin approval queue are **deferred** per PROJECT_CONTEXT §8. Do not build them. For pilot, all photos ingested by Admin are considered approved.
> 6. Audit-log every photo ingestion and rejection.
>
> Red lines: employee records must exist before photos can link to them — no auto-create. Face crops encrypted at rest. File paths inside the DB are fine in plain text; the bytes on disk are encrypted.
>
> When you can import the sample Excel and drop the pre-flight photo set, and the employees list shows correct photo counts — commit as `feat(P6): employees frontend + photo ingestion`, **stop, and show me**. Do not start P7.

**Review checklist:**
- [ ] Import round-trip from Excel works in the UI
- [ ] Dropping `OM0097_front.jpg` links to employee OM0097 as a front-angle photo
- [ ] Dropping a photo for an unknown employee code is rejected with a clear error
- [ ] On-disk photo files are Fernet-encrypted (try to open one in an image viewer — it should fail)

---

## Day 3 — Capture and identification (P7, P8, P9)

### P7 — Cameras CRUD, encrypted RTSP, on-demand live preview (~3 hours)

**Goal:** Admin can add a camera, see a live preview on demand, and edit/delete it. RTSP credentials never appear in plain text.

**Prompt:**

> Session **P7 — Cameras CRUD, encrypted RTSP, on-demand live preview**. Read `CLAUDE.md` and confirm P1–P6 are complete.
>
> In this session:
>
> 1. **Table** (new Alembic migration):
>    - `cameras` (id, tenant_id, name, location, rtsp_url_encrypted, enabled, created_at, last_seen_at, images_captured_24h)
> 2. **Endpoints** (Admin-only):
>    - `GET /api/cameras` — lists cameras; `rtsp_url` is NEVER returned, even to Admin. Instead return `rtsp_host` (parsed host only, no credentials) for display.
>    - `POST /api/cameras` — create; body includes plain `rtsp_url`, backend encrypts with Fernet before storage
>    - `PATCH /api/cameras/{id}` — edit; if `rtsp_url` present, re-encrypt; otherwise leave untouched
>    - `DELETE /api/cameras/{id}`
>    - `GET /api/cameras/{id}/preview` — on-demand single frame: backend opens the RTSP stream with OpenCV, grabs one frame, returns it as JPEG. Timeout 5 seconds. Do NOT keep the stream open.
> 3. **Cameras list page** (replaces P4 placeholder): layout from `design/pages.jsx`. Table with name, location, enabled toggle, "Preview" button.
> 4. **Preview modal:** clicking "Preview" calls the preview endpoint, shows the frame, offers a "Refresh" button. Modal closes, stream closes.
> 5. **Add/Edit form drawer:** fields `name`, `location`, `rtsp_url`, `enabled`. The `rtsp_url` field is write-only in the UI — on edit, it shows `***` as a placeholder and only sends a new value if the user types one.
> 6. No background capture yet. That is P8.
> 7. Audit-log every create/update/delete; audit entry records `rtsp_host` but **never** the full URL or credentials.
>
> Red lines: `rtsp_url_encrypted` is the only place the credentials live. Logs, API responses, audit entries, and error messages all use `rtsp_host` at most. If a log line ever contains `rtsp://user:pass@...`, that is a bug.
>
> When you can add your pre-flight test camera, see a preview frame, edit the location without re-entering credentials, and confirm logs contain no plain RTSP URL — commit as `feat(P7): cameras CRUD + encrypted RTSP + preview`, **stop, and show me**. Do not start P8.

**Review checklist:**
- [ ] Adding the test camera succeeds; preview shows a live frame
- [ ] `SELECT rtsp_url_encrypted FROM cameras` returns base64-looking encrypted bytes, not a URL
- [ ] `docker compose logs backend | grep rtsp://` finds nothing
- [ ] Edit flow does not require re-entering the URL

---

### P8 — Background capture pipeline + IoU tracker + detection events (~4 hours)

**Goal:** When the backend starts, it begins capturing frames from every enabled camera in the background. Faces are detected and tracked; one detection event per tracked face per camera-entry. No identification yet.

**Prompt:**

> Session **P8 — Background capture pipeline + IoU tracker + detection events**. Read `CLAUDE.md` and confirm P1–P7 are complete. Also read `frontend/src/design/` for any capture-related UI hints, though most work here is backend.
>
> In this session:
>
> 1. **Table** (new Alembic migration):
>    - `detection_events` (id, tenant_id, camera_id, captured_at, bbox JSONB, face_crop_path, embedding BYTEA nullable, employee_id nullable, confidence float nullable, track_id)
>    - `camera_health_snapshots` (id, tenant_id, camera_id, captured_at, frames_last_minute, reachable bool, note) — retained 30 days per PROJECT_CONTEXT §3
> 2. **Capture pipeline** in `backend/hadir/capture/`:
>    - `reader.py` — per-camera OpenCV RTSP reader with reconnect-on-failure. Downsamples to a sane frame rate (e.g. 4 fps). Do NOT pull at full 25 fps — the CPU budget is for face detection downstream.
>    - `analyzer.py` — InsightFace face detection only (not embeddings yet; embeddings happen in P9). Use `FaceAnalysis` with the detection model from `buffalo_l`, but skip the recognition step in this prompt.
>    - `tracker.py` — port the IoU tracker from the `detection-app` prototype. If the prototype code is not in this repo, implement a minimal IoU-based tracker: assign a new `track_id` when a detection has IoU < 0.3 with all active tracks; otherwise continue the existing track. Drop tracks idle for >3 seconds.
>    - `events.py` — emit one `detection_events` row per **track entry**, not per frame. Save the face crop (encrypted via Fernet, per P6) to `/data/faces/captures/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.jpg`. Leave `embedding`, `employee_id`, `confidence` null.
>    - `manager.py` — APScheduler job supervisor. On backend startup, reads all `enabled=true` cameras for tenant 1, spawns one capture worker per camera in-process. On camera add/edit/delete (from P7), hot-reload the worker set.
> 3. **Durability:** detection events and face crops are committed to DB/disk before the worker moves on. On restart, in-flight crops are lost (acceptable for pilot); committed events survive. Document this in `backend/CLAUDE.md`.
> 4. **Health snapshots:** every 60 seconds, each worker writes a `camera_health_snapshots` row with frames captured in the last minute and reachable flag. This powers the System page (P11).
> 5. **No UI controls for start/stop per camera.** The pilot captures all enabled cameras automatically. PROJECT_CONTEXT §8 is explicit about this.
>
> Red lines: RTSP URL is decrypted in-process and never leaves it. Face crops encrypted at rest. One event per track entry, not per frame (otherwise the events table explodes).
>
> When the backend starts, your test camera produces `detection_events` rows as people walk past (check with `SELECT COUNT(*) FROM detection_events WHERE captured_at > now() - interval '5 minutes';`), face crops are encrypted on disk, and camera health snapshots are accumulating — commit as `feat(P8): capture pipeline + IoU tracker + detection events`, **stop, and show me**. Do not start P9.

**Review checklist:**
- [ ] With the test camera and you walking past, new `detection_events` rows appear
- [ ] Row count is roughly one per walkthrough, not hundreds per frame
- [ ] Crops on disk are unreadable without Fernet
- [ ] `camera_health_snapshots` accumulates rows every ~60s per enabled camera

---

### P9 — Face identification (InsightFace embeddings + matching) (~4 hours)

**Goal:** Known employees are identified by face. Detection events get populated with `employee_id` and `confidence` when a match clears the threshold; otherwise they remain unidentified.

**Prompt:**

> Session **P9 — Face identification (InsightFace embeddings + matching)**. Read `CLAUDE.md` and confirm P1–P8 are complete.
>
> In this session:
>
> 1. **Extend `capture/analyzer.py`:** enable InsightFace `buffalo_l` recognition (embedding) on detected faces. CPU-only. Handle the download/cache of model files on first run.
> 2. **Enrollment backfill** in `backend/hadir/identification/enrollment.py`:
>    - On first run, and on each new photo upload (P6), compute a normalised embedding per `employee_photos` row and store it. Embeddings stored as Fernet-encrypted BYTEA (biometric data is encrypted at rest).
>    - Add an admin endpoint `POST /api/identification/reembed` that clears and recomputes all enrolled embeddings for the tenant. Useful when the model is upgraded.
> 3. **Matcher** in `backend/hadir/identification/matcher.py`:
>    - Load all enrolled embeddings for the tenant into memory on startup (decrypted). Keyed by `employee_id` → list of angle embeddings.
>    - On each detection event, compute cosine similarity against every enrolled embedding. The match is the employee with the highest mean-of-top-k similarity across their angles (k=1 fine for pilot).
>    - Threshold configurable via `HADIR_MATCH_THRESHOLD` (default 0.45). Below threshold → leave `employee_id` null and mark as `unidentified`.
>    - Update the `detection_events` row in place with `embedding`, `employee_id`, `confidence`.
> 4. **Cache invalidation:** when a photo is added/removed/approved (P6), invalidate the cache entry for that employee and re-load. Do NOT reload the entire cache.
> 5. **Pilot threshold tuning:** log the top-3 matches per event at DEBUG so you can eyeball the distribution and adjust the threshold during the pilot.
> 6. **Pytest:** add a unit test that seeds two enrolled embeddings (synthetic vectors) and verifies matcher output.
>
> Red lines: embeddings encrypted at rest. Face crops encrypted at rest (already enforced in P6 and P8). The identification layer never writes an `employee_id` it is not confident about (threshold is hard, not advisory).
>
> When a known employee (you, on your dev box) walks past the camera and the `detection_events` row shows your `employee_id` with confidence > 0.5 — commit as `feat(P9): face identification (insightface + matching)`, **stop, and show me**. Do not start P10.

**Review checklist:**
- [ ] Enrolling your own face photos produces encrypted embeddings in `employee_photos`
- [ ] Walking past the camera: event row has the right `employee_id`
- [ ] A stranger walking past produces a null `employee_id`
- [ ] Re-embed endpoint clears and repopulates

---

## Day 4 — Attendance and UI polish (P10, P11, P12)

### P10 — Attendance engine, one Fixed policy, 15-minute scheduler (~3 hours)

**Goal:** For every employee and every day, an `attendance_records` row exists with in-time, out-time, flags, and overtime. It recomputes every 15 minutes for "today".

**Prompt:**

> Session **P10 — Attendance engine, one Fixed policy, 15-minute scheduler**. Read `CLAUDE.md` and confirm P1–P9 are complete.
>
> In this session:
>
> 1. **Tables** (new Alembic migration):
>    - `shift_policies` (id, tenant_id, name, type ['Fixed','Flex','Ramadan','Custom'], config JSONB, active_from, active_until nullable) — pilot seeds ONE row: type=Fixed, name='Default 07:30–15:30', config `{"start":"07:30","end":"15:30","grace_minutes":15,"required_hours":8}`, active_from today, active_until null.
>    - `attendance_records` (id, tenant_id, employee_id, date, in_time nullable, out_time nullable, total_minutes nullable, policy_id, late bool, early_out bool, short_hours bool, absent bool, overtime_minutes int default 0, computed_at)
> 2. **Engine** in `backend/hadir/attendance/engine.py`:
>    - Pure function: `compute(employee_id, date, policy, events, leaves, holidays) -> AttendanceRecord`.
>    - First event of day (by `captured_at`) → `in_time`. Last event → `out_time`. Intermediate events kept in `detection_events` but not used for summary (per PROJECT_CONTEXT §3).
>    - `late = in_time > policy.start + grace`
>    - `early_out = out_time < policy.end - grace`
>    - `total_minutes = (out_time - in_time)` minus break deductions (none in pilot)
>    - `short_hours = total_minutes < policy.required_hours * 60` (only meaningful for Flex in v1.0; for Fixed, still compute for reporting)
>    - `absent = no events at all AND no leave on this date` — leaves and holidays module is **deferred** per PROJECT_CONTEXT §8, so in the pilot `absent = (events.empty)` and leaves/holidays are always empty
>    - `overtime_minutes = max(0, total_minutes - required_minutes)`
> 3. **Scheduler** in `backend/hadir/attendance/scheduler.py`:
>    - APScheduler job, interval 15 minutes. For each employee, recompute today's `attendance_records` row. Upsert by (employee_id, date).
>    - On startup, recompute today once to seed.
>    - Do NOT recompute historical days in the pilot (they are frozen once the date rolls over — in v1.0 this becomes a separate "late recompute" flow).
> 4. **Endpoint** `GET /api/attendance?date=YYYY-MM-DD&department_id=...` — returns the list for role scoping (Admin/HR see all; Manager sees their dept; Employee sees self).
>
> Red lines: engine is pure — no DB calls inside. It takes inputs, returns a record object. The caller persists. This keeps it testable and keeps v1.0's multi-policy engine a clean extension.
>
> When today's `attendance_records` row for you shows your first-event in-time and is recomputed 15 minutes after the next detection — commit as `feat(P10): attendance engine + fixed policy + scheduler`, **stop, and show me**. Do not start P11.

**Review checklist:**
- [ ] `attendance_records` has a row per active employee for today
- [ ] Your own row has `in_time` matching your first detection, `late=true/false` as expected
- [ ] Wait 15 min, walk past again → `out_time` updates on next recompute
- [ ] Engine function has unit tests covering late, early-out, absent

---

### P11 — Camera Logs page + System page + Audit Log UI (~3 hours)

**Goal:** Admin can see every detection event (Camera Logs), per-camera health (System), and every audit entry (Audit Log).

**Prompt:**

> Session **P11 — Camera Logs page + System page + Audit Log UI**. Read `CLAUDE.md` and confirm P1–P10 are complete.
>
> In this session:
>
> 1. **Camera Logs page** (replaces P4 placeholder, Admin-only):
>    - Table of `detection_events` with filters: camera, date range, employee, identified/unidentified.
>    - Thumbnail column — backend endpoint `GET /api/detection-events/{id}/crop` decrypts and streams the JPEG (auth-gated, audit-logged).
>    - Columns: captured_at, camera name, employee (or "Unidentified"), confidence, track_id.
>    - Pagination (100 rows/page).
> 2. **System page** (replaces P4 placeholder, Admin-only):
>    - Camera health panel: for each camera, show last_seen, frames_last_minute (from latest `camera_health_snapshots`), 24h chart of frames captured.
>    - App health: backend uptime, scheduler job status, DB connection count, enrolled employees count, today's event count, today's attendance record count.
>    - Design reference: `design/dashboards.jsx` contains a system-metrics layout — port it.
> 3. **Audit Log page** (replaces P4 placeholder, Admin-only):
>    - Table of `audit_log` rows. Filters: actor, action, entity_type, date range.
>    - Read-only. No edit, no delete (the DB will reject those anyway per P2 — this is belt and braces).
>    - Before/after JSONB shown as formatted JSON in an expandable row.
> 4. No new backend tables. Add read endpoints as needed.
>
> Red lines: audit log UI is read-only. Thumbnail endpoint is auth-gated and writes its own audit entries. Non-Admins calling any of these three pages' endpoints get 403.
>
> When all three pages render with live data from your dev setup — commit as `feat(P11): camera logs + system + audit log UI`, **stop, and show me**. Do not start P12.

**Review checklist:**
- [ ] Camera Logs shows your walk-past events with correct thumbnails
- [ ] System page shows the test camera as reachable with a realistic frame count
- [ ] Audit Log shows every P2–P11 action you've performed
- [ ] Logging in as a non-Admin user (create one) and hitting these pages → 403

---

### P12 — Role dashboards + Daily Attendance page with detail drawer (~3 hours)

**Goal:** Each role sees its dashboard. Daily Attendance is the headline demo page with a detail drawer showing underlying events.

**Prompt:**

> Session **P12 — Role dashboards + Daily Attendance page with detail drawer**. Read `CLAUDE.md` and confirm P1–P11 are complete.
>
> In this session:
>
> 1. **Dashboards** (replaces P4 placeholder, one per role):
>    - Port from `design/dashboards.jsx` literally. Pilot data source: live counts (enrolled employees, today's attendance summary, cameras online, recent events).
>    - Admin: system-wide stats.
>    - HR: attendance summary, policy status.
>    - Manager: department scope.
>    - Employee: own attendance today and last 7 days.
> 2. **Daily Attendance page** (replaces P4 placeholder, Admin/HR/Manager):
>    - Date picker (defaults to today).
>    - Department filter (Admin/HR); Manager is auto-scoped to their department(s).
>    - Table rows: employee name, in_time, out_time, total_hours, flags (late, early_out, short, overtime, absent), policy name.
>    - Row click → detail drawer on the right.
>    - Detail drawer: employee profile header, policy applied, list of underlying `detection_events` with thumbnails and times, flag explanations.
> 3. Reuse components from `design/ui.jsx` and `design/pages.jsx` where they exist. Don't reimplement anything the archive already has.
> 4. **Employee self-view** at `/attendance/me` for the Employee role: same data for self only, no filters.
>
> Red lines: Manager scoping is enforced in the backend via the `require_department` dependency from P3 — the frontend does not enforce scope. If you can craft a request as a Manager that returns another department's rows, that's a bug.
>
> When all four role dashboards render with live counts, Daily Attendance lists today's records with a working detail drawer on a real event — commit as `feat(P12): role dashboards + daily attendance page`, **stop, and show me**. Do not start P13.

**Review checklist:**
- [ ] Log in as Admin/HR/Manager/Employee (create test users) and see the right dashboard
- [ ] Daily Attendance with date=today shows your row with correct flags
- [ ] Drawer shows the underlying events with thumbnails
- [ ] Manager logged in cannot see another department's rows (test via API)

---

## Day 5 — Reports, smoke test, Omran deployment (P13, P14)

### P13 — On-demand Excel reports + end-to-end smoke tests (~3 hours)

**Goal:** Admin/HR can generate an attendance Excel for any date range. The full flow from login → enrolment → capture → attendance → report passes an automated smoke test.

**Prompt:**

> Session **P13 — On-demand Excel reports + end-to-end smoke tests**. Read `CLAUDE.md` and confirm P1–P12 are complete.
>
> In this session:
>
> 1. **Reports page** (replaces P4 placeholder, Admin/HR):
>    - Date range picker, employee filter, department filter.
>    - "Generate Excel" button — hits `POST /api/reports/attendance.xlsx` and downloads.
>    - No scheduled reports, no PDF, no email delivery. All deferred per PROJECT_CONTEXT §8.
> 2. **Backend reporter** at `backend/hadir/reporting/attendance.py`:
>    - Query `attendance_records` for the range + filters.
>    - Build XLSX with `openpyxl`: one sheet per week, columns employee_code, name, date, in_time, out_time, total_hours, late, early_out, short, overtime_minutes, policy.
>    - Stream the response; do not buffer large files in memory.
> 3. **Playwright smoke test** at `frontend/tests/pilot-smoke.spec.ts`:
>    - Log in as admin → import sample Excel → upload sample photos → (seed a synthetic detection via a test-only backend endpoint to avoid needing a live camera in CI) → wait for attendance recompute → generate report → verify downloaded file has the expected employee row.
>    - Add a `/api/_test/seed_detection` endpoint guarded by `HADIR_ENV=dev` only. Document in `backend/CLAUDE.md` that this must NOT be present in production builds.
> 4. **Pytest integration tests** covering: Excel report round-trip, role scoping on the report endpoint (Manager gets dept-only rows), 403 for Employee trying to hit the report endpoint for others.
> 5. **Operational readiness checklist** — add `docs/pilot-deployment.md` covering env vars, volume mounts, Postgres setup, how to seed the first admin, how to add cameras, how to import employees, how to roll back. Short and specific.
>
> Red lines: the `/api/_test/` endpoints only mount when `HADIR_ENV=dev`. Not a single byte of test-seed data leaks into production.
>
> When the Playwright smoke test passes green in CI locally and you can generate a real Excel report from yesterday's data (or today's, seeded) — commit as `feat(P13): reports + smoke tests`, **stop, and show me**. Do not start P14 until you also do a final polish pass on the dev box: walk through the demo script below and note any UX papercuts.
>
> **Demo script for self-review (walk through before P14):**
> 1. Log out, log back in as admin
> 2. Cameras → see test camera reachable in System page
> 3. Employees → import, upload photos, confirm photo counts
> 4. Walk past the camera
> 5. Camera Logs → see your events with correct identification
> 6. Daily Attendance → see your row with correct in-time
> 7. Reports → generate Excel for this week
> 8. Audit Log → see every action you just did

**Review checklist:**
- [ ] Report downloads and opens in Excel with real data
- [ ] Smoke test green
- [ ] Demo script runs end-to-end in under 5 minutes
- [ ] No console errors, no backend ERROR logs during the run

---

### P14 — Omran deployment + acceptance walkthrough (Day 5 afternoon, ~3 hours)

**Goal:** The pilot runs on Omran's Ubuntu host with real cameras and real employees. The pilot acceptance checklist (BRD §15.1) is walked through with the client.

**Prompt:**

> Session **P14 — Omran deployment**. Read `CLAUDE.md` and confirm P1–P13 are complete. Deployment is against a clean Ubuntu 22.04 LTS host provided by Omran IT.
>
> In this session (executed partly on the Omran host, not just on the dev box):
>
> 1. **Provision:** install Docker, Docker Compose, git. Clone the repo. Check out the P13 commit.
> 2. **Configure env:**
>    - Generate a new `HADIR_FERNET_KEY` (do NOT reuse the dev key) and a new `HADIR_SESSION_SECRET`.
>    - Point `HADIR_DATABASE_URL` at the Postgres instance (containerised via compose is fine for pilot; Omran IT decides post-pilot).
>    - `HADIR_TENANT_MODE=single`, `HADIR_ENV=production`.
>    - Pilot runs on HTTP over the corporate LAN per PROJECT_CONTEXT §3. Do NOT wire HTTPS — it's deferred.
> 3. **Bring up the stack:** `docker compose up -d`. Run Alembic migrations. Seed the first admin for a named Omran HR contact (not a shared account).
> 4. **Configure cameras:** add Omran's real IP cameras via the Cameras page with their RTSP URLs. Verify previews.
> 5. **Import employees:** Omran provides the employee Excel. Import it. Omran provides the photo set following the `OM0097.jpg` naming convention. Bulk upload. Confirm photo counts.
> 6. **Run identification backfill:** `POST /api/identification/reembed` to make sure all enrolled photos have embeddings.
> 7. **Observe for at least an hour:** watch detections populate, attendance records form, Daily Attendance show realistic results for whoever is in the office.
> 8. **Walk through the BRD §15.1 pilot acceptance checklist with the Omran sponsor:**
>    - Excel import + photo ingestion ✓
>    - Background capture on all enabled cameras ✓
>    - Face identification producing events with employee IDs ✓
>    - Fixed policy (07:30–15:30) flagging in-time, out-time, late, early-out correctly ✓
>    - Daily Attendance, Camera Logs, Audit Log, System page all render with live data ✓
>    - On-demand Excel export ✓
>    - UI matches the Hadir design system in English, light mode ✓
>    - **Written acknowledgement from Omran that the deferred list (PROJECT_CONTEXT §8) is understood and expected for v1.0, not pilot.**
> 9. **Document in `docs/pilot-signoff.md`:** what was deployed, what was demonstrated, what was signed off, what open items were raised, date, attendees.
>
> Red lines: this is a pilot demo, not go-live. Do not announce it as production. Do not promise v1.0 behaviours. Do not give Omran IT the impression that backup, DR, OIDC, HTTPS, Arabic, or approval workflow are present — they are not, and the BRD is explicit about that.
>
> When the sign-off document is filed and the client acknowledges the deferred list — commit as `feat(P14): omran pilot deployment + signoff`, update `CLAUDE.md` with "pilot delivered", and **stop, and show me**.

**Review checklist (this is the pilot acceptance gate):**
- [ ] Omran host running for ≥1 hour, events and attendance records populating
- [ ] Sponsor signed off on BRD §15.1 checklist
- [ ] `docs/pilot-signoff.md` committed with dated acknowledgement of the deferred list
- [ ] Open items (from the day) logged for v1.0 planning

---

## Contingency

If a session runs over time or blocks on a real-world issue (camera firmware, network permissions, missing photos), the collapse order is:

1. **Keep the critical path alive.** P1 → P2 → P3 → P7 → P8 → P9 → P10 → P14. Without any of these, the demo fails.
2. **Defer to v1.0, not to Day 5 afternoon.** The following can slide out of pilot without killing the demo: P11 System page live charts, P12 per-role dashboards (keep Admin only), P13 Playwright smoke test (pytest-only is acceptable). They become early v1.0 work.
3. **Do not drop:** encryption, tenant plumbing, audit log, the deferred-list acknowledgement from the client. These are red lines.
4. **If the camera is flaky on Day 5,** demo against the dev setup on Suresh's laptop plus a pre-recorded walk-through in the Omran conference room. Better than a flaky live demo.

---

## After the pilot

This file is superseded by `docs/phases/` entries for v1.0. Keep `pilot-plan.md` in git history as a reference. Add a top-line note at the top of this file marking it done and pointing to the v1.0 phase plan.
