# Admin Role — module-wise test plan

**Audience:** QA + operators validating an Admin user's coverage
across every Maugood surface.
**Scope:** every backend endpoint and frontend page an Admin can
reach, including cross-cutting concerns (multi-tenant isolation,
timezone propagation, worker/recovery flow, restart sanity).
**Not in scope:** Super-Admin console (separate doc),
employee/HR/manager role validation (separate sub-pass).

---

## 0. Conventions

* Test IDs are `<MODULE>-<NN>`. Backend-only cases have a `(B)`
  suffix, frontend-only cases have an `(F)` suffix, end-to-end
  cases have no suffix.
* **Category**: P=positive, N=negative, E=empty-state, ER=error,
  AC=role/access, T=multi-tenant, R=recovery, PL=pipeline,
  TZ=timezone, PF=performance/restart.
* Each test expects a fresh login as an Admin user against a
  tenant whose data was seeded by
  `backend/scripts/pre_omran_reset_seed.py` (see
  `docs/testing/pre-omran-validation.md`). Where multi-tenant
  isolation is being exercised, you'll log in as the second
  tenant's Admin as instructed in the step body.
* For every audit-emitting case, after the action run
  `GET /api/audit-log?action=<expected>&limit=1` (or open the
  Audit Log page in the UI) and confirm the row's `actor_user_id`,
  `entity_type`, `entity_id`, and `after` payload match the
  expected shape.
* "Should 403" means the API returns HTTP 403 *and* the UI does
  not surface the navigation entry; "should 404" means the API
  returns 404 without leaking existence of cross-tenant rows.

---

## 1. Authentication & Sessions

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| AUTH-01 (B) | P | Login with valid credentials + tenant_slug | `POST /api/auth/login` with `{email, password, tenant_slug}` | 200; `maugood_session` + `maugood_tenant` cookies set; `auth.login.success` audit row |
| AUTH-02 (B) | N | Wrong password | Same as AUTH-01 with bad password | 401 `invalid credentials`; `auth.login.failure` audit; counter increments |
| AUTH-03 (B) | N | Unknown email | Same with non-existent email | 401 `invalid credentials` (NOT 404); `auth.login.failure` with `reason=unknown_email` |
| AUTH-04 (B) | N | Missing `tenant_slug` in multi-mode | omit field | 400 with explicit message |
| AUTH-05 (B) | N | Unknown tenant slug | Use a slug that doesn't exist | 401 `invalid credentials` (NOT 404 — tenant enumeration block) |
| AUTH-06 (B) | ER | Rate-limit hit | 11 failed attempts from same (email, ip) | 429 with `auth.login.rate_limited` audit |
| AUTH-07 (B) | P | Session sliding expiry | Hit `/api/auth/me` 50 minutes into a 60-min session | 200; cookie `Max-Age` bumped to 60 |
| AUTH-08 (B) | N | Expired session is rejected | Manually expire `user_sessions.expires_at`; hit any endpoint | 401; `auth.session.expired` audit |
| AUTH-09 (B) | P | Logout clears session | `POST /api/auth/logout` | 204; session row deleted; cookie cleared |
| AUTH-10 (B) | AC | `/api/auth/me` returns full Admin profile | Admin GET `/api/auth/me` | 200; payload includes id, email, full_name, roles[] (includes "Admin"), departments[], preferred_language, preferred_theme, preferred_density |
| AUTH-11 (B) | P | Switch role | `POST /api/auth/switch-role` if Admin holds another role too | 200; subsequent calls evaluate as the new role |
| AUTH-12 (B) | N | Switch to a role not held | POST a role Admin doesn't hold | 403 |
| AUTH-13 (B) | P | OIDC config CRUD | GET/PUT `/api/auth/oidc/config` | Round-trips secrets via `has_*` flags; secrets never returned in plaintext |
| AUTH-14 (B) | P | OIDC config validation | PUT with invalid discovery URL | 400 |
| AUTH-15 (B) | P | Preferred language patch | `PATCH /api/auth/preferred-language` `{language:"ar"}` | 200; audit `auth.preferred_language.updated`; subsequent `/me` returns ar |
| AUTH-16 (B) | P | Preferred theme + density patches | Same for theme `dark` / density `compact` | 200; audits land |
| AUTH-17 (B) | N | Preferred language not in {en, ar, null} | PATCH with `"de"` | 422 |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| AUTH-F-01 | P | Login page renders + accepts creds | Open `/login`, enter creds, click Sign in | Redirects to `/dashboard`; topbar shows role chip + email |
| AUTH-F-02 | ER | Login error surfaces | Enter wrong password | Page shows "Invalid credentials" inline; no spinner stuck |
| AUTH-F-03 | E | LoginPage with OIDC enabled | Enable OIDC at backend; reload `/login` | "Sign in with Microsoft" is primary CTA |
| AUTH-F-04 | P | Role chip swap | Open topbar role dropdown, pick another role | Page reloads; sidebar nav reflects new role |
| AUTH-F-05 | P | Language switcher EN/AR | Topbar language switch | `<html dir>` flips to `rtl` for ar; every translated string flips |
| AUTH-F-06 | P | Theme + density toggles | Topbar Display switcher | `<html data-theme>` + `data-density` flip; persists across reload |
| AUTH-F-07 | P | Logout | Topbar logout | Redirects to `/login`; protected route guards |
| AUTH-F-08 | N | Direct protected URL while signed out | Open `/employees` incognito | Redirected to `/login` |

---

## 2. Employees & Photos

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| EMP-01 (B) | P | List employees | `GET /api/employees` | 200; paginated; matches DB |
| EMP-02 (B) | P | Search by code/name/email/department | Use `?search=` | Hits across all four fields |
| EMP-03 (B) | P | Department filter | Use `?department_id=` | Returns only that dept |
| EMP-04 (B) | E | `include_inactive=true` returns inactive | Soft-delete one, then list with flag | Inactive row included |
| EMP-05 (B) | P | Create employee | POST with valid body | 201; `employee.created` audit |
| EMP-06 (B) | N | Duplicate employee_code | POST same code twice | 409 (or 400) with clear message |
| EMP-07 (B) | P | Patch employee | PATCH with one field | 200; `employee.updated` audit with before/after |
| EMP-08 (B) | P | Soft delete | DELETE | 204; status flips to `inactive`; row stays |
| EMP-09 (B) | P | XLSX import — valid rows | POST `/employees/import` with 5-row file | created/updated counts match; per-row audits |
| EMP-10 (B) | N | XLSX import — unknown department_code | One row with `department_code=ZZZ` | Row error returned; other rows still commit |
| EMP-11 (B) | N | XLSX import — within-file duplicate code | Two rows same code | Row error for duplicate; first one commits |
| EMP-12 (B) | P | XLSX export | GET `/employees/export` | Streams XLSX; includes inactive; custom-field columns appended |
| EMP-13 (B) | P | Photo drawer upload | POST one or more photos with `angle=front` | Per-file `photo.ingested` audit; Fernet-encrypted on disk (not JPEG magic) |
| EMP-14 (B) | P | Photo bulk dump | POST a folder of files matching `OM001_left.jpg` etc. | `photo.ingested` per accepted file; `photo.rejected` per unknown code |
| EMP-15 (B) | N | Bulk upload unknown code | Filename whose code doesn't exist | Rejected; never auto-creates the employee |
| EMP-16 (B) | P | Decrypt + stream photo | GET `/employees/{id}/photos/{pid}/image` | JPEG bytes returned; `photo.viewed` audit |
| EMP-17 (B) | P | Delete photo | DELETE photo | 204; matcher cache invalidated; file removed best-effort |
| EMP-18 (B) | E | No photos | List photos for fresh employee | Returns empty array |
| EMP-19 (B) | AC | HR can read; Employee 403 | Repeat EMP-01 as HR (200) and Employee (403) | as labelled |
| EMP-20 (B) | T | Cross-tenant photo blocked | As tenant A Admin GET `/employees/{B's_id}/photos` | 404 |
| EMP-21 (B) | P | PDPL gdpr-delete (P25) | POST with exact confirmation string | 200; photos dropped; PII redacted; status=deleted; audit row carries previous PII |
| EMP-22 (B) | N | PDPL gdpr-delete wrong phrase | POST with mismatched confirmation | 400 |
| EMP-23 (B) | P | Custom field values per-employee | GET/PATCH `/employees/{id}/custom-fields` | Round-trips; type coercion holds (text/number/date/select) |
| EMP-24 (B) | P | Lifecycle: relieving_date in past | Set a relieving_date before today + run cron | Employee flips to inactive at the tenant-local boundary |
| EMP-25 (B) | P | Lifecycle: joining_date in future | Set future joining_date | Active list excludes employee until that date; matcher classifies as "future" |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| EMP-F-01 | P | Employees page renders rows | Open `/employees` | List + pagination + photo-count pills |
| EMP-F-02 | P | Search + department filter | Type in search; pick dept | Server-side filter; row count updates |
| EMP-F-03 | P | Include inactive toggle | Toggle on | Inactive rows show with badge |
| EMP-F-04 | E | Empty employee list | Brand-new tenant, no employees yet | Empty-state card with "Add employee" CTA |
| EMP-F-05 | P | Add / Edit drawer | Click + Add; fill required fields; Save | New row appears; toast confirms |
| EMP-F-06 | P | Photo gallery in detail drawer | Click row; view gallery | Images decrypt + display |
| EMP-F-07 | P | Photo drop-zone upload | Drop file with angle selector | Upload progress + new row in gallery |
| EMP-F-08 | P | Import modal | Drop XLSX | Per-row results table with errors/warnings |
| EMP-F-09 | ER | Photo upload over size limit | Drop a huge file | Server returns 413/400; UI surfaces an inline error |
| EMP-F-10 | P | PDPL delete confirmation flow | Click delete (admin-only); type exact phrase | Confirms; row disappears |
| EMP-F-11 | P | Approvals tab — "Delete requests" | Open Approvals → Delete requests tab | Sees pending delete requests for the tenant |
| EMP-F-12 | E | Former employees seen — empty range | Open `/former-employees`, pick a range with no detections | "No former-employee detections in this range" |

---

## 3. Custom Fields

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CF-01 (B) | P | CRUD on `/api/custom-fields` | Create / list / patch / delete | Audits per change |
| CF-02 (B) | P | Reorder | POST `/custom-fields/reorder` with new id list | display_order updates atomically |
| CF-03 (B) | N | Invalid type | Create with `type=foo` | 422 |
| CF-04 (B) | P | Per-type coercion | PATCH employee custom-field of type=number with "12" | Stored as "12"; subsequent GET returns it |
| CF-05 (B) | N | Required field empty | Mark required + PATCH employee with empty value | 400 with field name |
| CF-06 (B) | AC | HR read; Employee 403 | Repeat CF-01 read for each role | as labelled |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CF-F-01 | P | Settings → Custom Fields page | Open `/settings/custom-fields` | Lists fields; drag-handle reorder |
| CF-F-02 | P | Add field | Click + Add; pick type=select; fill options | Saves; appears in list |
| CF-F-03 | P | Delete with cascade warning | Click delete | Modal warns about cascading values |
| CF-F-04 | P | Custom fields surface in employee drawer | Open any employee | Custom fields rendered below standard fields |

---

## 4. Cameras & RTSP

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CAM-01 (B) | P | List cameras (host-only) | GET `/api/cameras` | Returns `rtsp_host` only; never the full URL |
| CAM-02 (B) | P | Create camera | POST with valid rtsp_url | 201; URL Fernet-encrypted on disk; audit carries `rtsp_host` only |
| CAM-03 (B) | N | Invalid RTSP scheme | POST `http://...` | 400 (only rtsp/rtsps allowed per P27 SSRF hardening) |
| CAM-04 (B) | N | Duplicate camera name | POST same name twice | 409 |
| CAM-05 (B) | P | Patch without `rtsp_url` | PATCH `{name:"..."}` | Ciphertext untouched; audit `rtsp_url_rotated=false` |
| CAM-06 (B) | P | Patch with `rtsp_url` rotation | PATCH new URL same host | `rtsp_url_rotated=true` flag in audit |
| CAM-07 (B) | P | Delete camera | DELETE | 204; capture worker stopped |
| CAM-08 (B) | P | Preview single frame | GET `/cameras/{id}/preview` | 200 JPEG bytes; `camera.previewed` audit |
| CAM-09 (B) | ER | Preview timeout | Disconnect camera; preview | 504 with host-safe detail string |
| CAM-10 (B) | P | Capture config patch | PATCH `capture_config={...}` | New config hot-reloads via reconcile tick; no worker restart needed |
| CAM-11 (B) | P | Worker enabled toggle | PATCH `worker_enabled=false` | Worker stops within 2 s |
| CAM-12 (B) | P | Display enabled toggle | PATCH `display_enabled=false` | MJPEG endpoint 503; worker keeps running |
| CAM-13 (B) | T | Cross-tenant preview | As tenant A Admin GET tenant B's camera preview | 404 |
| CAM-14 (B) | AC | Employee 403 on `/api/cameras` | Repeat as Employee role | 403 |
| CAM-15 (B) | P | No plaintext URL in logs/audit | `docker compose logs backend | grep "rtsp://.*:.*@"` | 0 matches after CRUD + rotation |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CAM-F-01 | P | Cameras page list | Open `/cameras` | Rows with Preview / Edit / Delete |
| CAM-F-02 | P | Add camera drawer | Click + Add; fill fields | Saved; row appears |
| CAM-F-03 | P | Edit drawer placeholder | Open Edit; rtsp_url shows `***` | Saving without typing keeps cipher |
| CAM-F-04 | P | Preview modal | Click Preview | Modal with JPEG; Refresh button |
| CAM-F-05 | ER | Preview unreachable | Camera offline | Error toast/inline; modal stays |
| CAM-F-06 | P | Capture settings panel | Expand panel in drawer | Four knobs (max_faces/duration/quality/save_full_frames) round-trip |
| CAM-F-07 | E | No cameras configured | Fresh tenant | Empty state with + Add camera CTA |

---

## 5. Live Capture

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| LC-01 (B) | P | MJPEG stream open | GET `/api/live-capture/cameras/{id}/mjpg` while worker running | Multipart JPEG stream; audit `live_capture.mjpg.sub` on connect |
| LC-02 (B) | N | Display disabled | Toggle display_enabled=false; GET MJPEG | 503 `camera_display_disabled` |
| LC-03 (B) | N | Worker disabled | Toggle worker_enabled=false; GET MJPEG | Returns last frame stale → empty/eventual error |
| LC-04 (B) | T | Cross-tenant MJPEG | Tenant A admin GET tenant B's camera | 404 |
| LC-05 (B) | P | WebSocket events | Connect WS `/live-capture/cameras/{id}/events`; trigger a match | One JSON detection event per new track |
| LC-06 (B) | ER | Viewer cap | Open 11 concurrent MJPEG viewers for one camera | 11th gets 429 (or close on overflow) |
| LC-07 (B) | E | Idle viewer disconnect | Open MJPEG; leave for >10 s with no consumer read | Server closes |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| LC-F-01 | P | Live Capture page | Open `/live-capture` | Camera tiles render; MJPEG fills each |
| LC-F-02 | E | No cameras | Brand-new tenant | Empty state with "Add camera" link |
| LC-F-03 | P | Display-disabled tile | Toggle off on one camera | Tile shows "Display disabled" explanatory state, not error |
| LC-F-04 | P | Worker-disabled tile | Toggle worker off | Tile shows "Worker disabled" state |
| LC-F-05 | P | Detection event ticker | Walk past camera | Event row appears on right with name + confidence |

---

## 6. Detection Events & Camera Logs

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| DE-01 (B) | P | List with filters | GET `/api/detection-events?identified=true&start=...&end=...` | Paginated; correct filter behaviour |
| DE-02 (B) | P | Crop fetch | GET `/detection-events/{id}/crop` | JPEG; `detection_event.crop_viewed` audit |
| DE-03 (B) | ER | Missing file | Manually delete the encrypted file on disk; GET crop | 410 `crop file missing` |
| DE-04 (B) | ER | Orphan row (NULL path) | Row carries `face_crop_path=NULL` | 404 `crop_unavailable` |
| DE-05 (B) | T | Cross-tenant event | A admin requests B's event | 404 |
| DE-06 (B) | E | No events today | Empty range | Empty `items=[]` |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| DE-F-01 | P | Camera Logs page | Open camera-logs page | Rows with thumbnail, employee, confidence |
| DE-F-02 | P | Former-employee badge | Walk a former employee past camera | Row shows former badge + filter chip works |
| DE-F-03 | E | Empty list | Fresh tenant | Empty-state message |
| DE-F-04 | ER | Broken crop | Same as DE-03 | Tile shows "Crop unavailable" not browser broken icon |

---

## 7. Attendance Engine

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| ATT-01 (B) | P | GET /api/attendance for today | Admin GET with date=today | List with one row per active employee |
| ATT-02 (B) | P | Department filter | `?department_id=…` | Only that dept |
| ATT-03 (B) | P | Manager scope | As Manager: GET | Auto-scoped to assigned employees; can't cross-filter |
| ATT-04 (B) | P | Engine recompute | POST `/api/_test/recompute_attendance` (dev) or wait 15-min | Rows match engine output |
| ATT-05 (B) | P | Per-employee for-date recompute | POST `/api/attendance/regenerate-range` for a date range | Per-date counts returned; 92-day cap enforced |
| ATT-06 (B) | N | Range > 92 days | POST a 100-day range | 422 |
| ATT-07 (B) | TZ | Recompute uses tenant tz | Change tenant tz; trigger recompute | in/out times bucketed in new tz |
| ATT-08 (B) | P | Waiting state for today's pre-shift-end rows | Pre-shift-end fresh today | status="waiting" for un-checked-in employees, not "absent" |
| ATT-09 (B) | E | No events | Day with no detections | Rows are `absent` (or `waiting` if today pre-shift-end), no crash |

### Frontend — Daily Attendance + My Attendance

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| ATT-F-01 | P | Daily attendance page | Open `/attendance` | Table with status pills |
| ATT-F-02 | P | Status filter | Filter by Late | Only late rows |
| ATT-F-03 | P | Waiting status visible | Open before shift-end with un-checked-in employees | "Waiting" pill, not Absent |
| ATT-F-04 | E | Empty result | Filter that returns zero | Friendly empty-state |
| ATT-F-05 | P | Drawer detail | Click row | Drawer with in/out, totals, events |

### Attendance Calendar (P28.6)

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CAL-01 (B) | P | Company view month | GET `/api/attendance/calendar/company?month=…` | One row per day with count blocks |
| CAL-02 (B) | P | Person view month | GET `?person&employee_id=…` | Status per day; policy_name carried |
| CAL-03 (B) | P | Day-detail drawer | GET `/calendar/day` | Status, in/out, totals, timeline, evidence crops |
| CAL-04 (B) | T | Cross-tenant employee_id | As A admin pass B's id | 404 (not 403 — red line) |
| CAL-05 (B) | P | Export | GET `/calendar/export?month=…` | XLSX streams |
| CAL-F-01 | P | Company calendar UI | Open `/calendar` (Admin tab) | Month grid with status counts per day |
| CAL-F-02 | P | Person calendar UI | Pick employee | Per-day cells with status badges + "Waiting" today |
| CAL-F-03 | P | Day drawer evidence crops | Click a day | Up to 5 crops render |
| CAL-F-04 | P | Submit exception CTA | From drawer click + Submit exception | Pre-filled NewRequestDrawer opens |

---

## 8. Shift Policies

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| POL-01 (B) | P | CRUD on `/api/policies` | Create Fixed, Flex, Ramadan, Custom | Audits per change |
| POL-02 (B) | P | Set-as-default | POST `/policies/{id}/set-as-default` | Wipes existing tenant assignment; creates new; audit `shift_policy.default_set` |
| POL-03 (B) | N | Set-as-default on soft-deleted | Policy with `active_until<today` | 409 |
| POL-04 (B) | P | Ramadan/Custom date range required | Create without `start_date`/`end_date` | 422 |
| POL-05 (B) | P | Inverted date range rejected | end_date < start_date | 422 |
| POL-06 (B) | P | Per-employee/dept/tenant assignment | POST `/policy-assignments` for each scope | Resolver picks employee > dept > tenant in that order |
| POL-07 (B) | P | Custom precedes Ramadan | Both cover same date | Custom wins on resolver |
| POL-08 (B) | AC | HR can CRUD; Manager/Employee 403 | Repeat per role | as labelled |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| POL-F-01 | P | Policies page | Open `/policies` | Three tables: Standard / Ramadan / Custom |
| POL-F-02 | P | Create form per type | New → pick type | Fields switch (date range for R/C; inner_type for C) |
| POL-F-03 | P | Default pill + Set as default button | Click "Set as default" in row | Default badge moves to the new policy |
| POL-F-04 | P | Assignment chips | Open detail panel | Department/employee chips render |
| POL-F-05 | E | Empty (fresh tenant) | No policies seeded except default | Default policy visible; empty Ramadan + Custom sections |

---

## 9. Leaves, Holidays & Tenant Settings

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| LV-01 (B) | P | Leave types CRUD | `/api/leave-types` | Audits |
| LV-02 (B) | P | Holidays CRUD | `/api/holidays` | Audits |
| LV-03 (B) | P | Holidays XLSX import | POST import | Per-row results |
| LV-04 (B) | P | Approved leaves CRUD | `/api/approved-leaves` | Engine clears `absent` for those dates |
| LV-05 (B) | P | Tenant-settings GET | GET `/api/tenant-settings` | Returns weekend_days + timezone |
| LV-06 (B) | TZ | Tenant-settings PATCH timezone | PATCH timezone Asia/Kolkata | Audit fires; attendance recompute auto-runs (today); next subscriber sees new tz |
| LV-07 (B) | P | Weekend days change | PATCH `weekend_days=["Saturday","Sunday"]` | Engine respects on next recompute |
| LV-08 (B) | AC | HR can edit; Employee 403 | as labelled | |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| LV-F-01 | P | Leave & Calendar page tabs | Open `/leave-policy` | Three tabs + tenant settings panel |
| LV-F-02 | P | TZ change banner | Change tz | "Timezone changed — Regenerate historical attendance" banner with date-range modal |
| LV-F-03 | P | Regenerate Historical modal centred | Open modal | Centred via fixed + translate; not bottom-left |

---

## 10. Requests & Approvals

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REQ-01 (B) | P | Employee submit request | POST `/api/requests` as Employee | State `submitted`; audit |
| REQ-02 (B) | P | Manager approve | Patch with decision | State `manager_approved` |
| REQ-03 (B) | N | HR decide on manager-rejected | Try HR decide | 409 (manager rejection terminal — red line) |
| REQ-04 (B) | P | HR approve | After manager_approved | `hr_approved`; for leave type, idempotent `approved_leaves` row; per-employee recompute |
| REQ-05 (B) | P | Admin override | POST `/admin-override` with comment len>=10 | `admin_approved`; notifications queued to all parties; audit `previous_stage` carries old state |
| REQ-06 (B) | N | Admin override comment <10 chars | comment="too short" | 422 |
| REQ-07 (B) | P | Attachment upload — JPEG | POST attachment with .jpg | 201; Fernet-encrypted |
| REQ-08 (B) | N | Attachment magic-byte mismatch | Upload .jpg renamed from .exe | 400 |
| REQ-09 (B) | N | Attachment over size cap | POST > 5 MB | 413 |
| REQ-10 (B) | P | Inbox endpoints | GET `/requests/inbox/{pending,decided,summary}` | Counts + lists role-scoped |
| REQ-11 (B) | P | SLA flag | Wait > 48 business hours then GET | `sla_breached=true` |
| REQ-12 (B) | P | Reason categories CRUD | `/api/request-reason-categories` Admin-only writes | Audits |
| REQ-13 (B) | T | Cross-tenant request_id | A admin GET B's request | 404 |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REQ-F-01 | P | Approvals page tabs | Open `/approvals` | Pending mine / Decided by me / All (Admin) |
| REQ-F-02 | P | Decision drawer | Open + approve | Comment optional; reject mandatory |
| REQ-F-03 | P | Admin override modal | Click Override | Red banner + 10-char client guard |
| REQ-F-04 | P | Sidebar approvals badge | Have SLA-breached request pending | Badge shows danger tone |
| REQ-F-05 | E | No pending | Fresh tenant | Empty-state copy |

---

## 11. Manager Assignments

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| MA-01 (B) | P | List grouped | GET `/api/manager-assignments` | Manager → employees grouping |
| MA-02 (B) | P | Upsert + primary | POST with `is_primary=true` | Audit `manager_assignment.primary_set`; partial-unique-index DB level enforced |
| MA-03 (B) | N | Two primaries for one employee | Direct INSERT (or POST twice) | Postgres rejects |
| MA-04 (B) | P | Delete assignment | DELETE | Audit `manager_assignment.deleted` |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| MA-F-01 | P | Drag-and-drop | Move employee card to a manager column | Persists on drop |
| MA-F-02 | P | Star toggle primary | Click star on an assignment | Visual + DB flip |

---

## 12. Reports (On-Demand)

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REP-01 (B) | P | XLSX attendance report | POST `/api/reports/attendance.xlsx` valid range | Streams XLSX; audit `report.generated` |
| REP-02 (B) | P | PDF attendance report | POST `/reports/attendance.pdf` | Streams PDF; multi-employee gets page breaks |
| REP-03 (B) | N | Range > max_days | Pass > tenant's max | 422 |
| REP-04 (B) | AC | Employee 403 | Repeat as Employee | 403 |
| REP-05 (B) | P | Manager scope | As Manager pass cross-dept filter | 403 on cross-filter |
| REP-06 (B) | P | Former-employees-seen report | GET `/api/reports/former-employees-seen` json + xlsx | Audit row |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REP-F-01 | P | Reports page | Open `/reports` | Generate Excel + Generate PDF buttons with same form |
| REP-F-02 | E | No employees in range | Generate over empty range | Toast notice; no broken file |

---

## 13. Scheduled Reports & Email

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| SCH-01 (B) | P | Email config CRUD | `/api/email-config` SMTP or Graph | secrets via `has_*` flags; never returned plaintext |
| SCH-02 (B) | P | Send test | POST `/email-config/test` | One sample notification email arrives |
| SCH-03 (B) | P | Schedule CRUD | `/api/report-schedules` | Audits; `next_run_at` advances via croniter |
| SCH-04 (B) | P | Run-now | POST `/report-schedules/{id}/run` | report_runs row inserted; status running→completed |
| SCH-05 (B) | P | Signed URL download | Fetch token URL | Anonymous + HMAC-gated + rate-limited; audit `report.signed_url_downloaded` |
| SCH-06 (B) | N | Tampered token | Modify token | 401 |
| SCH-07 (B) | P | Pause / delete | toggle / delete | as labelled |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| SCH-F-01 | P | Settings → Email | open page | provider toggle; Send test button |
| SCH-F-02 | P | Settings → Schedules | open page | Run-now / Pause / Delete + cron preview |

---

## 14. ERP Export

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| ERP-01 (B) | P | GET/PATCH config | `/api/erp-export-config` | Audits |
| ERP-02 (B) | N | Path traversal | PATCH `output_path=../../etc/...` | 400 (red line — every output stays under `/data/erp/{tenant_id}/`) |
| ERP-03 (B) | N | Invalid cron | bad expression | 422 |
| ERP-04 (B) | P | Run-now | POST run-now | Writes file under tenant root; streams same bytes back; audit row |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| ERP-F-01 | P | Settings → ERP Export | open page | Config + Run-now Download + last-run status |

---

## 15. Notifications

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| NOT-01 (B) | P | List + mark-read | GET / PATCH read | Per-row read flag flips |
| NOT-02 (B) | P | Preferences CRUD | PATCH per (category, channel) | Email defaults true; per-row preference resolves at send time |
| NOT-03 (B) | P | Camera unreachable producer | Disconnect a camera for >5 min | One notification row; dedupes during the outage |
| NOT-04 (B) | P | Request submit/decide producers | trigger via REQ-01 / REQ-04 | Rows in the right recipients' queues |
| NOT-05 (B) | P | Recipient language honored | A and B users with different prefs | Subject/body in each user's language |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| NOT-F-01 | P | Topbar bell + dropdown | Click bell | List with unread badge |
| NOT-F-02 | P | `/notifications` history | open page | Paginated history |
| NOT-F-03 | P | Settings → Notifications grid | open page | category × channel toggles |

---

## 16. Branding

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| BR-01 (B) | P | GET branding | `/api/branding` | Returns curated colour key + font key |
| BR-02 (B) | P | PATCH branding | PATCH new colour/font | Audit; immediate effect on next reload |
| BR-03 (B) | N | Free-form hex | PATCH `primary_color_hex` | 422 (BRD red line — curated palette only) |
| BR-04 (B) | P | Logo upload PNG | POST 200KB PNG | 201; magic-byte validated |
| BR-05 (B) | N | Logo upload .exe renamed | POST .exe with .png extension | 400 |
| BR-06 (B) | N | Logo > 200KB | POST oversize | 413 |
| BR-07 (B) | AC | HR can't write | PATCH as HR | 403 (Admin-only) |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| BR-F-01 | P | Settings → Branding | open page | Curated colour swatches + font dropdown + logo upload |
| BR-F-02 | P | Live preview | pick a new colour | Topbar accent updates on save (no reload) |

---

## 17. System Settings (Detection / Tracker / Capture)

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| SYS-01 (B) | P | GET detection config | `/api/system/detection-config` | Returns mode, det_size, thresholds |
| SYS-02 (B) | P | PUT detection config (yolo+face) | PUT valid payload | Workers hot-swap on next reconcile tick (≤2 s); audit |
| SYS-03 (B) | N | PUT invalid mode | `mode=yolov12` | 400 with `detail.field=mode` |
| SYS-04 (B) | N | det_size out of range | `det_size=999` | 400 |
| SYS-05 (B) | P | Tracker config round-trip | GET/PUT | Audit |
| SYS-06 (B) | T | Per-tenant isolation | A's PUT doesn't affect B | Two-tenant verify |
| SYS-07 (B) | AC | HR 403 | as labelled | |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| SYS-F-01 | P | System settings page | Open `/system-settings` | Detection + Tracker cards |
| SYS-F-02 | P | Mode swap radio | Pick yolo+face | Save; toast confirms |
| SYS-F-03 | P | Reset-to-defaults | Confirm modal | Reverts and saves |

---

## 18. Operations / Worker Monitoring (Pipeline Monitor)

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| OPS-01 (B) | P | List workers | GET `/api/operations/workers` | Per-camera worker payload with stage state + counters |
| OPS-02 (B) | P | Per-camera restart | POST `/workers/{id}/restart` | Worker stops + restarts within ~5 s; status returns updated |
| OPS-03 (B) | R | Per-camera restart does NOT trigger tenant recovery | POST single-camera restart | No `clip_pipeline.recovered_at_boot` audit rows fire |
| OPS-04 (B) | P | Worker errors | GET `/workers/{id}/errors` | Recent error strings + audit log entries |
| OPS-05 (B) | P | Camera metadata PATCH | PATCH `/cameras/{id}/metadata` (brand/model/location) | Audit; visible on next list |
| OPS-06 (B) | T | Cross-tenant camera_id | as A admin POST restart on B's camera | 404 (not 403) |
| OPS-07 (B) | AC | HR 403 | All ops endpoints | 403 |
| OPS-08 (B) | P | Pipeline-monitor payload | GET `/api/operations/pipeline` | 4 sections (rtsp/recording/encoding/identify) populated |
| OPS-09 (B) | E | No cameras | fresh tenant | empty sections; no 500 |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| OPS-F-01 | P | Pipeline Monitor page renders | Open `/pipeline-monitor` | 4 tabs + summary chips |
| OPS-F-02 | P | Cameras tab | Click Cameras tab | Table with workers per camera |
| OPS-F-03 | P | Per-camera restart button | Click restart on a row | Action confirms; row status flips |
| OPS-F-04 | E | No active workers | fresh tenant | Friendly empty state with "Add camera" link |
| OPS-F-05 | ER | Session expired | Let cookie expire; refresh | Page shows "Sign in again", not stuck |

---

## 19. Clip Pipeline / Person Clips / Face Crops

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CLP-01 (B) | P | List person clips | GET `/api/person-clips` | Paginated; filter by recording_status |
| CLP-02 (B) | P | Submit batch (clips × use_cases) | POST `/clip-pipeline/submit` | batch_id returned; jobs enter queues |
| CLP-03 (B) | P | Skip existing flag | Re-submit a completed (clip,uc) | Counted as skipped, not duplicated |
| CLP-04 (B) | P | Status snapshot | GET `/clip-pipeline/status` | Queues + workers + per-tenant batches |
| CLP-05 (B) | P | Single-clip reprocess | POST `/person-clips/{id}/reprocess` | Async; `is_single_clip_running` flips to true |
| CLP-06 (B) | E | No clips today | empty range | empty list; no 500 |
| CLP-07 (B) | PL | clip_pipeline `recording_status='recording'` write on capture | Walk past camera | One placeholder row INSERTed at clip start, UPDATEd to `completed` on finalize |
| CLP-08 (B) | T | Cross-tenant clip lookup | as A admin GET B's clip | 404 |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| CLP-F-01 | P | Clip Analytics page | open page | List + filter chips (All / Completed / Recording / Failed / etc.) |
| CLP-F-02 | P | Live recording rows | Walk past camera | Row appears with 🔴 LIVE indicator; flips to Completed when clip ends |
| CLP-F-03 | E | No clips configured | brand new | Empty state |
| CLP-F-04 | P | Identify event drawer | Click on a clip | Detail with match results + face crops |
| CLP-F-05 | P | Matched clips tab on employee | open employee drawer | Lists per-employee matches across clips |

---

## 20. Recovery & Restart-All-Workers (P29)

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REC-01 (B) | R | Boot-time recovery fires after lifespan delay | `docker compose restart backend`; wait 30 s | INFO log `clip pipeline recovery: starting (delay_s=30)`; summary log line |
| REC-02 (B) | R | Class A — match complete, status not flipped | Manually flip a `processing` row's match_duration_ms; restart backend | Row flips to `completed`; one `clip_pipeline.recovered_at_boot` audit `class=A` |
| REC-03 (B) | R | Class B — UC1 with crops on disk | Seed UC1 row with face_extract_duration_ms + face_crops files; restart | Row resumes match-only; `class=B`; recognition runs on saved crops |
| REC-04 (B) | R | Class C — no face_crops yet | UC1 row stuck in processing with zero face_crops; restart | `class=C`; row flipped to `pending`; full re-crop job enqueued |
| REC-05 (B) | R | Class C — partial crops (no duration) | face_crops rows exist but face_extract_duration_ms NULL; restart | `class=C`; partial crops deleted; re-enqueued |
| REC-06 (B) | R | Class C — disk files missing | face_extract_duration_ms set but encrypted JPEGs deleted on disk; restart | `class=C`; sample disk check finds missing; falls back to full restart |
| REC-07 (B) | R | UC2/UC3 always Class C | Same shape as REC-03 but use_case=uc2 | `class=C` |
| REC-08 (B) | R | Poison-job cap | Same row stuck after 3 recoveries | `class=failed_cap`; status flips to `failed` with explicit error |
| REC-09 (B) | R | Atomic claim guards concurrent recoveries | Hit `restart-all-and-recover` while deferred recovery still in flight | Second pass sees `recovery_attempts < cap` predicate fail or `recovery_in_flight`; no double-claim |
| REC-10 (B) | R | Per-camera restart does NOT trigger recovery | Single-camera restart while stuck rows exist | No new `clip_pipeline.recovered_at_boot` audits |
| REC-11 (B) | R | `restart-all-and-recover` triggers everything | POST `/api/operations/workers/restart-all-and-recover` | Capture workers restart; reprocess cancelled if running; immediate synchronous recovery sweep; legacy reprocess async fire; audit `pipeline.restart_all_and_recover` |
| REC-12 (B) | AC | restart-all-and-recover is Admin-only | as HR | 403 |
| REC-13 (B) | R | Recovery audit payload shape | After any recovery; GET audit-log filtered | Each row carries `class`, `label`, `reason`, `artifact_count`, `artifact_disk_ok`, `recovery_attempts_before/after` |
| REC-14 (B) | E | No stuck rows | Fresh tenant; restart | `scanned=0` log line; zero audit rows; zero work |
| REC-15 (B) | R | Legacy reprocess recovery — Class A | `matched_status='processing'` with `matched_employees` populated; restart | flip to `processed`; audit |
| REC-16 (B) | R | Legacy reprocess recovery — Class C | `matched_status='processing'`, matched_employees empty; restart | flip to `pending`; `trigger_single_clip_reprocess` fires; drip-fed |

### Frontend

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| REC-F-01 | P | Restart All Workers button visible in PM | Open Pipeline Monitor as Admin | Red "Restart all workers" button in page header |
| REC-F-02 | AC | Not visible to non-Admin | as HR | Button absent |
| REC-F-03 | P | Type-to-confirm modal | Click button | Type `RESTART ALL`; Confirm enabled |
| REC-F-04 | P | Result toast | After success | Toast in bottom-right: capture counts + recovery breakdown |
| REC-F-05 | P | Auto refresh on success | Click Confirm | Pipeline Monitor refreshes; queries invalidated |
| REC-F-06 | N | Double-click guard | Click Confirm twice | Pending state; second click no-ops |
| REC-F-07 | ER | Endpoint 500 | Simulate failure | Modal closes; error toast surfaces; no silent failure |

---

## 21. Audit Log

### Backend / API

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| AUD-01 (B) | P | List | GET `/api/audit-log` | Paginated; filter by actor/action/entity/start/end |
| AUD-02 (B) | P | distinct_actions + distinct_entity_types | GET | Lists drive UI selectors |
| AUD-03 (B) | N | Try to DELETE a row | direct DB or attempted endpoint | Rejected at the DB grant level (P2 red line) |
| AUD-04 (B) | T | Cross-tenant | A admin scope only sees A's rows | tenant_id filter holds |
| AUD-F-01 | P | Audit Log page | Open `/audit-log` | filter UI works |

---

## 22. Multi-Tenant Isolation (cross-cutting)

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| MT-01 | T | Login as tenant A | A admin login | Cookie carries A's `schema_name` |
| MT-02 | T | Read employees A vs B | A list / B list | No row leakage |
| MT-03 | T | Cross-tenant photo via A's admin | GET B's photo id | 404 |
| MT-04 | T | Cross-tenant audit search | A admin filter by B's actor_user_id | no rows (filter on tenant_id only returns A's rows) |
| MT-05 | T | Multi-tenant attendance | Both tenants have today's row | Disjoint counts |
| MT-06 | T | Multi-tenant capture workers | Both tenants have cameras | Workers attached to their own tenant_id; preview cross-call 404 |
| MT-07 | T | CI canary | Run `tests/test_multi_tenant_isolation.py` + `test_two_tenant_isolation.py` | both green |
| MT-08 | T | Multi-mode + no-context fail-closed | Issue a raw `engine.begin()` outside `tenant_context` in multi-mode | RuntimeError "no tenant schema in scope" |

---

## 23. Timezone Validation (cross-cutting)

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| TZ-01 | TZ | Change tenant tz to Asia/Kolkata | PATCH /tenant-settings | Audit fires; immediate today recompute |
| TZ-02 | TZ | Calendar/person uses tenant tz | Open `/calendar` | in/out times bucketed in new tz |
| TZ-03 | TZ | System health uses tenant tz | GET `/api/system/health` | "today" boundaries reflect tz |
| TZ-04 | TZ | Reports use tenant tz | Generate XLSX with dates around midnight | Rows fall on the correct local day |
| TZ-05 | TZ | Banner + regenerate-historical | After tz change | Banner shows "Regenerate historical attendance…" CTA |
| TZ-06 | TZ | Regenerate range respects new tz | POST regenerate-range | Per-date breakdown bucketed in new tz |
| TZ-07 | TZ | TanStack Query cache wipe | After tz change | Cached pages reflect new times without manual refresh |

---

## 24. Performance & Restart Sanity (cross-cutting)

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| PF-01 | PF | Backend cold boot to healthy | `docker compose restart backend`; poll `/api/health` | < 15 s to 200 |
| PF-02 | PF | Capture worker spawn | After PF-01 with N enabled cameras | One worker per camera; log shows the count |
| PF-03 | PF | Reconcile tick alive | Watch logs for 30 s | "capture manager reconcile" tick every 2 s, no errors |
| PF-04 | PF | Recovery doesn't spike CPU | While 100 stuck rows exist, restart backend | Recovery thread drip-feeds; load average stays < 2× normal during ramp |
| PF-05 | PF | Restart-all-and-recover roundtrip | Click button with N cameras + M stuck rows | Returns within ~15 s; recovery summary matches DB state |
| PF-06 | PF | 5-second polling sustained | Open Pipeline Monitor for 10 min | No memory growth on frontend; backend stable |
| PF-07 | PF | Background schedulers all running | GET `/api/system/health` | attendance / report / notification / retention / lifecycle / pipeline schedulers all true |
| PF-08 | PF | Migrations idempotent | `python -m scripts.migrate` twice | second run is a no-op (already at head per schema) |

---

## 25. Health, Metrics & Background Schedulers

| ID | Cat | Title | Steps | Expected |
|---|---|---|---|---|
| HM-01 (B) | P | `/api/health` returns 200 | curl | `{status:"ok"}` |
| HM-02 (B) | P | `/api/system/health` Admin payload | GET | uptime, pid, conn count, scheduler flags, totals |
| HM-03 (B) | AC | `/api/system/health` HR allowed | as HR | 200 (or 403 — confirm against current implementation) |
| HM-04 (B) | P | `/api/system/cameras-health` | GET | per-camera 24h series |
| HM-05 (B) | P | `/metrics` (internal-only) | from inside docker network | Prometheus exposition (NOT proxied via nginx in prod) |
| HM-06 (B) | N | `/metrics` external | curl from public IP in prod | 421 / not proxied |
| HM-07 (B) | P | Detection events counter | walk past camera + scrape | `maugood_detection_events_total{tenant,camera,identified}` increments |
| HM-08 (B) | P | Camera reachable gauge | disconnect camera | `maugood_camera_reachable` flips 1 → 0 within ~1 min |
| HM-F-01 | P | System page | Open `/system` | Shows uptime, capture workers, attendance scheduler status, totals |

---

## 26. Empty-state coverage matrix (cross-cutting)

For each page below, log in as Admin against a **brand new tenant with
no data beyond the seed defaults** and confirm the page shows a
friendly empty-state, NOT a spinner or 500.

| Page | Expected empty-state |
|---|---|
| `/dashboard` | Zero-state cards; no broken numbers |
| `/employees` | "No employees yet — Import or Add" |
| `/cameras` | Empty list + add camera CTA |
| `/live-capture` | Empty state with "Add camera" link |
| `/attendance` | "No attendance for this date" |
| `/calendar` (Company) | Month grid with all-zero counts + no-record badge |
| `/calendar` (Person) | Pick employee picker shows "No employees yet" |
| `/approvals` | "No pending requests" |
| `/my-requests` | "No requests yet" |
| `/policies` | Default Fixed policy visible, Ramadan/Custom sections empty |
| `/leave-policy` | Empty leave types + holidays |
| `/notifications` | Empty bell + page |
| `/reports` | Form usable; "no rows" toast on empty result |
| `/audit-log` | Shows seed audits (provisioning + roles) |
| `/pipeline-monitor` | No active workers + empty queues |
| `/camera-logs` | Empty list |
| `/system` | All counts zero |
| `/system-settings` | Default detection + tracker configs |
| `/branding` | Default palette + Inter font |

---

## 27. Error-handling matrix (cross-cutting)

| Surface | Error scenario | Expected |
|---|---|---|
| Any UI API call | 401 | Redirect to `/login` (route guard) |
| Any UI API call | 403 | Inline "permission denied" |
| Any UI API call | 5xx | Toast with retry option; no silent failure |
| Any UI API call | network error | "Network error" badge / toast |
| Photo decrypt | invalid Fernet | 500 logged; UI shows "Crop unavailable" |
| RTSP preview | timeout | 504 with host-safe detail string |
| Restart-all | backend down mid-call | toast surfaces failure; modal closes |
| Recovery sweep | DB outage | per-tenant log + continue with next tenant |
| Migration | already at head | no-op; entrypoint exits 0 |

---

## 28. Sign-off

Tester: ______________________________
Tenant slug(s): ______________________
Backend git ref: ______________________
Frontend git ref: ______________________
Date: ______________________

Issues found (link to GitHub issues / per-row notes):

```
ID    Status   Notes
---   ------   ---------------------------------------------
```

When every section above is ticked and no open critical issue
remains, Admin-role validation is complete. File this document
alongside the matching pre-Omran-validation pass under
`docs/testing/`.
