# Device-Based Attendance — Integration Design

> **Scope:** How Maugood adds support for **standalone face-recognition
> attendance terminals** (e.g. Hikvision `DS-K1T342MFWX-E1`,
> `DS-K1T671MF`) as a **second attendance source** alongside the existing
> IP-camera capture pipeline. Covers: adding a device with a **unique
> device identity**, **device-based data sync** (enrollment out + events
> in), and **how the existing attendance workflow continues unchanged**.
>
> **Status:** Design / proposal. No code shipped yet. Grounded in the
> real v1.1.x data model (`detection_events`, `attendance` engine,
> `cameras` pattern) and the Maugood red lines.

---

## 1. Two attendance sources, one attendance engine

Maugood today computes attendance from **IP cameras**:

```
IP camera → RTSP → capture worker → detect → match → detection_events → attendance engine → attendance_records
```

A face-recognition **terminal** does the detect + match **on the device
itself** and simply reports "person X was seen at time T". So the device
path is shorter:

```
Face terminal → (on-device match) → event push/pull → device event ingest → detection_events → attendance engine → attendance_records
```

**The load-bearing insight:** the attendance engine only reads
`detection_events` filtered by `(tenant_id, employee_id, captured_at)`
(`attendance/repository.py::events_for`). It does **not** care whether a
row came from a camera or a terminal. So if device events land in
`detection_events` (or a source the repository unions in), the **entire
existing attendance workflow — the 15-minute recompute, the pure
`engine.compute()`, policies, leaves, holidays, reports — continues
completely unchanged.**

> This is the answer to *"how to handle the already-existing workflow /
> continue"*: **do not fork the attendance pipeline.** Add the device as
> a new event **producer** that writes into the same event stream the
> engine already consumes.

---

## 2. What a terminal actually integrates over (Hikvision)

Hikvision access-control terminals expose **ISAPI** (HTTP/REST over the
device, HTTP Digest auth). The three capabilities Maugood needs:

| Capability | ISAPI surface (indicative) | Direction |
| --- | --- | --- |
| **Identify the device** | `GET /ISAPI/System/deviceInfo` → serial number, MAC, model, firmware | read |
| **Enroll a person + face** | `POST /ISAPI/AccessControl/UserInfo/Record` (person) + `POST /ISAPI/Intelligent/FDLib/FaceDataRecord` (face image) | Maugood → device |
| **Receive attendance events** | **Push:** device posts `AccessControllerEvent` JSON to a configured HTTP host. **Pull:** `POST /ISAPI/AccessControl/AcsEvent` to query historical events | device → Maugood |

Each access event carries: `employeeNoString` (the person id Maugood
assigned), `name`, `time`, `doorNo`, `currentVerifyMode` (face / card /
fingerprint), a verify result, and a captured-face picture URL.

> **Design principle — vendor abstraction.** Wrap ISAPI behind a
> `DeviceDriver` interface (`get_info`, `enroll_person`, `delete_person`,
> `fetch_events`, `parse_pushed_event`). Hikvision is the first driver;
> Dahua (HTTP/CGI + similar person/face APIs) and a generic "Wiegand /
> HTTP webhook" driver can follow without touching the ingest or
> attendance layers.

---

## 3. Add Device — registration + unique identity

New Admin surface, modeled on the existing **Cameras** page (same CRUD +
Fernet-encrypted-credential pattern).

**"Add device" form:** name, location, IP/host, port, ISAPI
username/password, driver (`hikvision` default), door number(s),
`worker_enabled` (poll/subscribe on/off), optional `zone`.

**On save, Maugood:**
1. Connects to the device (`GET deviceInfo`) using the supplied
   credentials.
2. Reads the **device serial number** (+ MAC, model, firmware).
3. Stores the row with the credentials **Fernet-encrypted at rest**
   (exactly like `cameras.rtsp_url_encrypted`).

**Unique device identity — the "unique it, device-based" part:**
- The device **serial number** is the natural key. Enforce
  **`UNIQUE (tenant_id, serial_number)`** so the same physical terminal
  can't be registered twice under one tenant.
- Store the serial + MAC so the ingest layer can **authenticate pushed
  events**: a webhook payload is only trusted if its device serial
  matches a registered device in that tenant.
- `(tenant_id, serial_number)` is also how a re-IP'd device is
  recognized as the same unit (IP can change; serial doesn't).

---

## 4. Data sync — the two directions

### 4a. Enrollment sync (Maugood → device)

The terminal matches on-device, so every employee who should be
recognized there must have their **person record + face image pushed to
the device**.

- **Person id contract:** push with `employeeNoString = employee.code`
  (Maugood's existing per-tenant employee code). This makes the mapping
  device-person-id ↔ Maugood-employee **stable and human-readable**, and
  every event the device sends back carries that code — no fragile
  separate mapping table required for the common case (see §5).
- **Face source:** reuse the employee's existing **reference photos**
  (`employee_photos`, already Fernet-encrypted). Decrypt → push the JPEG
  to the device's Face Data Library. *(The device wants a normal photo,
  not Maugood's 512-D embedding — the terminal computes its own
  embedding internally.)*
- **When to sync:** on employee create / photo change / employee
  activate → push; on employee deactivate / hard-delete (PDPL) →
  **delete the person from every device** too (right-to-erasure must
  reach the terminal, not just the DB).
- **Scope:** which employees go to which device is an assignment
  (all-employees default, or per-device/per-department/per-zone). Model
  it like `manager_assignments` if selective enrollment is needed.

### 4b. Event sync (device → Maugood)

Two mechanisms; support **push as primary, pull as backstop** (mirrors
the attendance engine's own "event-driven + periodic sweep" pattern):

- **Push (real-time):** configure each device with Maugood's webhook URL
  (`POST /api/devices/events`). On every recognition the device posts an
  `AccessControllerEvent`. Maugood validates the device serial, maps
  `employeeNoString → employee`, and writes one attendance event.
- **Pull (reconciliation):** a periodic job (same 60-second scheduler
  tick already used by reports/ERP) calls `AcsEvent` per device for
  "events since last cursor", to backfill anything missed while Maugood
  was down or the network dropped. Each device row keeps a
  `last_event_cursor` (timestamp / serialNo) for idempotent catch-up.

**Idempotency:** the device's per-event serial number
(`(device_id, event_serial)`) is unique — dedupe on it so a pushed event
and the same event later pulled don't double-count.

---

## 5. Employee ↔ device-person mapping

- **Default:** `employeeNoString == employee.code` (set at enrollment
  push, §4a). Ingest resolves `WHERE tenant_id = :scope AND code =
  :employeeNoString`. No extra table needed.
- **When a mapping table is needed:** devices enrolled **before**
  Maugood, or where the operator can't control the on-device id. Then a
  small per-tenant `device_person_map (device_id, device_person_id,
  employee_id)` translates. Keep it optional — the code-as-id convention
  avoids it for greenfield deployments.
- **Unknown person id:** write the event with `employee_id = NULL`
  (unidentified), exactly as the camera path does for an unmatched face.
  Never auto-create an employee from a device event.

---

## 6. How the existing attendance workflow continues (the integration seam)

The device ingest writes into the **same event stream** the engine
already consumes. Two implementation options — recommend **Option A**:

### Option A (recommended) — device events into `detection_events`

Add nullable columns to `detection_events` via a schema-agnostic
migration (0094+):
- make `camera_id` **nullable** (today it's `NOT NULL`),
- add `device_id INT NULL FK attendance_devices(id) ON DELETE SET NULL`,
- add `source TEXT NOT NULL DEFAULT 'camera'` with a CHECK
  `IN ('camera','device')`,
- keep `employee_id`, `captured_at`, `confidence` as-is.

Device ingest inserts a row with `source='device'`, `device_id=…`,
`camera_id=NULL`, `employee_id` resolved from the person id,
`captured_at` = device event time (converted to UTC for storage, like
camera events). **`events_for` needs no change** — it filters on
`(tenant_id, employee_id, captured_at)` and the row is already there. The
15-minute recompute picks it up on the next tick; `recompute_for(...)`
can be fired inline from the webhook for near-real-time.

- **Pros:** zero change to the engine, scheduler, policies, reports,
  calendar, former-employee logic. One event table = one place to audit,
  retain, and report. Fully honors *"continue the existing workflow"*.
- **Cons:** `face_crop_path` is camera-oriented; for device rows either
  store the device's captured-face image (Fernet-encrypted, same as
  camera crops) or leave it null and relax the NOT NULL. A device row has
  no `bbox`/`track_id` — make those nullable or default them.

### Option B — separate `device_attendance_events` + union in the repository

Keep device events in their own table and teach
`attendance/repository.py::events_for` to `UNION` camera + device events
per employee.

- **Pros:** camera schema untouched; device-specific columns stay
  isolated.
- **Cons:** touches the one hot-path query, adds a second retention +
  audit surface, and every future consumer of "attendance events" must
  remember to union. More places to get tenant-isolation wrong.

> **Recommendation: Option A.** One event stream keeps the attendance
> engine, retention sweep, reports, and the P28.6 calendar working
> verbatim. The device becomes "a camera-shaped event source" from the
> engine's point of view — which is exactly the coexistence property the
> requirement asks for.

---

## 7. Proposed data model (red-line compliant)

New per-tenant table (schema-agnostic migration, `maugood_app`
CRUD grants, `tenant_id NOT NULL FK public.tenants`):

**`attendance_devices`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `tenant_id` | int NOT NULL FK | isolation |
| `name` | text NOT NULL | |
| `location` | text | |
| `driver` | text NOT NULL | `hikvision` / `dahua` / … |
| `host` | text NOT NULL | IP / DNS |
| `port` | int NOT NULL | |
| `credentials_encrypted` | text NOT NULL | **Fernet** (user:pass) |
| `serial_number` | text NOT NULL | device identity |
| `mac` / `model` / `firmware` | text | auto-read from `deviceInfo` |
| `door_no` | text | |
| `worker_enabled` | bool | poll/subscribe on/off |
| `last_event_cursor` | text | pull reconciliation cursor |
| `last_seen_at` | timestamptz | health |
| `created_at` / `updated_at` | timestamptz | |

Constraint: **`UNIQUE (tenant_id, serial_number)`**.

Changes to **`detection_events`** (Option A): `camera_id` → nullable;
add `device_id` (nullable FK), `source` (CHECK `camera`/`device`);
`bbox` / `track_id` / `face_crop_path` made nullable for device rows.

Optional **`device_person_map`** (only if the code-as-id convention
can't be used): `(tenant_id, device_id, device_person_id) → employee_id`.

---

## 8. API surface (new)

Modeled on `/api/cameras`, all **Admin-only**, all **audited**, all
**tenant-scoped** (`WHERE tenant_id = :scope`; cross-tenant `{id}` → 404):

| Method + Path | Purpose | Audit |
| --- | --- | --- |
| `GET /api/devices` | List (credentials never returned) | — |
| `POST /api/devices` | Register; reads `deviceInfo`, encrypts creds, stores serial | `device.created` |
| `PATCH /api/devices/{id}` | Edit; omitted password keeps cipher | `device.updated` |
| `DELETE /api/devices/{id}` | Remove | `device.deleted` |
| `POST /api/devices/{id}/test` | Connectivity probe (like camera preview) | `device.tested` |
| `POST /api/devices/{id}/sync-enrollment` | Push people + faces to the device | `device.enrollment_synced` |
| `POST /api/devices/events` | **Webhook** the terminal posts events to | `device.event_ingested` (batched) |
| `POST /api/devices/{id}/pull-events` | Manual reconciliation pull | `device.events_pulled` |

---

## 9. Security & red-line checklist

- **Encryption at rest:** device ISAPI username/password Fernet-encrypted
  exactly like RTSP URLs. Plaintext credentials never appear in logs,
  audit rows, exceptions, or API responses (list/detail return host +
  serial only, never the password) — same discipline as `cameras/`.
- **Tenant isolation:** `attendance_devices.tenant_id` + every query
  filtered; the webhook authenticates the posting device by
  `(tenant_id, serial_number)` so one tenant's device can't inject events
  into another; cross-tenant `{id}` returns **404, not 403**.
- **Webhook authentication:** the ingest endpoint is anonymous (the
  device can't hold a session) but must verify the device serial against
  a registered row **and** a per-device shared secret / IP allowlist
  before accepting events. Rate-limit + audit. Treat it like the P18
  signed-URL download surface: anonymous but gated.
- **Audit:** device add/edit/delete/test/enroll and every ingest batch
  audited (append-only, `maugood_app` INSERT+SELECT only). Event ingest
  audits a **summary** row per batch, not per event (avoid audit-log
  flooding — mirror the camera path's "no audit per frame" rule).
- **PDPL:** hard-delete / GDPR-delete of an employee must **also delete
  that person from every device** — erasure has to reach the terminal.
- **Per-tenant timezone:** device `captured_at` stored UTC; the
  attendance hot path converts against the tenant timezone, unchanged.
- **Schema-agnostic migration:** no hardcoded `main`/`public`; new table
  gets `maugood_app` grants; lint test stays green.

---

## 10. Phased rollout (suggested)

1. **D1 — Device registry + identity.** `attendance_devices` table,
   Admin CRUD, `deviceInfo` read, Fernet creds, `UNIQUE(tenant_id,
   serial_number)`, connectivity test. *(No events yet.)*
2. **D2 — Event ingest (pull).** Hikvision `DeviceDriver.fetch_events`,
   `detection_events` Option-A columns, map person-id → employee, write
   events, `last_event_cursor` reconciliation. Attendance flows
   end-to-end with **zero engine changes**.
3. **D3 — Event ingest (push webhook).** Real-time `POST
   /api/devices/events`, serial + secret auth, dedupe on event serial,
   inline `recompute_for` for near-real-time.
4. **D4 — Enrollment sync (Maugood → device).** Push people + reference
   faces; wire to employee lifecycle (create/activate/deactivate/
   PDPL-delete); enrollment assignment scope.
5. **D5 — Second driver (Dahua) + generic webhook** behind the same
   `DeviceDriver` interface.

---

## 11. Open decisions (need a call before building)

1. **Matching authority:** on-device only (terminal decides, Maugood
   trusts) — recommended for terminals — **or** device sends the
   captured face and Maugood re-matches with its own MatcherCache
   (heavier, but one source of truth for identity). Default: trust the
   device; store its confidence.
2. **`detection_events` Option A vs B** (§6) — recommend A.
3. **Enrollment direction:** push Maugood→device (recommended, Maugood is
   the master of record) vs pull device→Maugood (device is master).
4. **Device-face storage:** store the terminal's captured-face image as a
   Fernet crop (enables the same evidence UI + reports) or skip it to
   save disk.
5. **Mixed deployments:** a site with both cameras and terminals for the
   same employees — dedupe policy when both fire for one person in the
   same minute (engine already collapses to first-in/last-out, so likely
   a no-op, but confirm).

---

## Cross-references

- Existing attendance workflow: `docs/architecture/stage6-attendance-events.md`
- Current end-to-end architecture: `docs/architecture/current-architecture.md`
- Camera CRUD + Fernet-credential pattern to mirror: `maugood/cameras/`
- Attendance engine seam: `maugood/attendance/repository.py::events_for`
- Terminal hardware comparison: `docs/hikvision-face-terminals-comparison.md`
- Red lines: `.claude/rules/red-lines.md`
