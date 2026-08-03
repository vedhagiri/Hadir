# Database Table Design — Device Attendance

> Complete table design for **device-based attendance**, with real example
> data for review & approval.
>
> **Examples use the live records:** tenant **inaisys** → `tenant_id = 2`
> (schema `tenant_inaisys`); employee **Harikrishnan** → `employee_id = 2066`,
> code `OM00044`. Timezone: Asia/Kolkata (IST = UTC + 5:30).

---

## Overview — 5 tables

```
attendance_devices → device_users → device_attendance_events → detection_events → attendance_records
   (new)               (new)            (new)                     (reused)          (reused)
```

| Table | Status | Purpose | Uniqueness (prevents duplicates) |
| --- | --- | --- | --- |
| `attendance_devices` | new | Device registry | `(tenant_id, serial_number)` |
| `device_users` | new | Synced device people → mapped to employees | `(tenant_id, device_id, device_user_id)` |
| `device_attendance_events` | new | Raw taps (face / fingerprint) | `(tenant_id, device_id, event_serial)` |
| `detection_events` | reused | "Person seen" — shared with cameras | — |
| `attendance_records` | reused | Final daily record | `(tenant_id, employee_id, date)` |

Every table carries `tenant_id` and every query filters on it → data stays
isolated inside the `tenant_inaisys` schema.

---

## 1. `attendance_devices`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | auto |
| `tenant_id` | int FK | tenant isolation → **2** |
| `name` | text | Main Gate Terminal |
| `location` | text | |
| `driver` | text | hikvision |
| `host` / `port` | text / int | 192.168.1.64 / 80 |
| `credentials_encrypted` | text | **Fernet-encrypted** user:pass |
| `serial_number` | text | read from device; unique per tenant |
| `model` / `firmware` | text | DS-K1T671MF / V3.2.40 |
| `door_no` | text | |
| `enrollment_scope` | text | all / department / zone |
| `enabled` | bool | |
| `health_status` | text | online / unreachable / unknown |
| `users_synced` | int | |
| `last_user_sync_at` / `last_seen_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz | |

**Constraint:** `UNIQUE (tenant_id, serial_number)` — the same physical
terminal can't be registered twice.

**Example row**

| id | tenant_id | name | serial_number | host:port | enabled | health |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **2** | Main Gate Terminal | DS7K1T-INAISYS01 | 192.168.1.64:80 | true | online |

---

## 2. `device_users`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `tenant_id` / `device_id` | int FK | 2 / 1 |
| `device_user_id` | text | the terminal's person id = employee code |
| `name` | text | as stored on device |
| `card_no` | text | optional (M1 card) |
| `employee_id` | int FK (nullable) | **the mapping to Maugood** |
| `mapping_status` | text | mapped / unmapped / ambiguous |
| `face_synced` | bool | face pushed to device? |
| `active` | bool | |
| `raw` | jsonb | full device payload |
| `synced_at` / `created_at` / `updated_at` | timestamptz | |

**Constraint:** `UNIQUE (tenant_id, device_id, device_user_id)` — re-syncing
the same person **updates** the row, never duplicates it.

**Example row (Harikrishnan)**

| id | tenant_id | device_id | device_user_id | name | employee_id | mapping_status | face_synced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **2** | 1 | OM00044 | Harikrishnan | **2066** | mapped | true |

> **Sync the same employee many times → still one row.** A second sync only
> refreshes `synced_at` (and any changed name/card). Sync 100× → 1 row.

---

## 3. `device_attendance_events`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `tenant_id` / `device_id` | int FK | 2 / 1 |
| `device_user_id` | text | who the device recognized (OM00044) |
| `event_serial` | text | device's unique event id |
| `occurred_at` | timestamptz | device time → stored UTC |
| `verify_mode` | text | **face / fingerprint** / card / pin / qr |
| `direction` | text | in / out / unknown (label only — see calc) |
| `status` | text | pending / processed / failed / skipped |
| `attempts` / `last_error` / `next_retry_at` | int / text / ts | retry bookkeeping |
| `employee_id` | int FK (nullable) | resolved at processing → 2066 |
| `detection_event_id` | int FK (nullable) | the produced detection row |
| `raw` | jsonb | full payload |
| `received_at` / `processed_at` | timestamptz | |

**Constraint:** `UNIQUE (tenant_id, device_id, event_serial)` — the same tap
can't be counted twice (push + pull dedupe).

**Example — Harikrishnan's taps on 2026-08-03 (face + fingerprint)**

| id | tenant_id | device_user_id | event_serial | occurred_at (UTC) | verify_mode | direction | employee_id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5001 | 2 | OM00044 | EVT-88121 | 03:42:00Z | face | in | 2066 |
| 5002 | 2 | OM00044 | EVT-88300 | 07:30:00Z | fingerprint | out | 2066 |
| 5003 | 2 | OM00044 | EVT-88355 | 08:15:00Z | fingerprint | in | 2066 |
| 5004 | 2 | OM00044 | EVT-88490 | 13:00:00Z | face | out | 2066 |

> **Two methods, one identity.** Face and fingerprint are both attached to the
> same `employeeNo = OM00044`, so every event maps to employee 2066 regardless
> of method. `verify_mode` is stored only to show *how* each check-in
> happened. **Face** is pushed by Maugood; **fingerprint** is enrolled once on
> the device (can't be pushed).

---

## 4. `detection_events` (reused)

The shared "person seen" table (also used by cameras). Device rows are tagged
`source='device'` with `camera_id` null.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `tenant_id` | int FK | 2 |
| `source` | text (**new col**) | camera / **device** |
| `device_id` | int FK (**new col**) | 1 (null for camera rows) |
| `camera_id` | int FK | null for device rows |
| `employee_id` | int FK | 2066 |
| `captured_at` | timestamptz | UTC |
| `confidence` | float | device's score |

**Example — one row per tap**

| id | tenant_id | source | device_id | camera_id | employee_id | captured_at (UTC) |
| --- | --- | --- | --- | --- | --- | --- |
| 90231 | 2 | device | 1 | null | 2066 | 03:42:00Z |
| 90232 | 2 | device | 1 | null | 2066 | 07:30:00Z |
| 90233 | 2 | device | 1 | null | 2066 | 08:15:00Z |
| 90234 | 2 | device | 1 | null | 2066 | 13:00:00Z |

---

## 5. `attendance_records` (reused)

| Column | Type | Notes |
| --- | --- | --- |
| `tenant_id` / `employee_id` | int FK | 2 / 2066 |
| `date` | date | 2026-08-03 |
| `in_time` / `out_time` | time | first tap / last tap |
| `total_minutes` | int | out − in |
| `late` / `early_out` / `short_hours` / `absent` | bool | from shift policy |
| `overtime_minutes` | int | max(0, total − required) |
| `source` | text | camera / device |

**Constraint:** `UNIQUE (tenant_id, employee_id, date)` — exactly **one row per
employee per day**.

**Example — one row for the day**

| tenant_id | employee_id | date | in_time | out_time | total_min | overtime | source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 2066 | 2026-08-03 | **09:12** | **18:30** | 558 | 78 | device |

---

## How `in_time` & `out_time` are calculated

The engine converts each event UTC → local (IST), sorts by time, then takes
the **first** and **last** tap. The `direction` label is **ignored** — in/out
are decided purely by time.

| event | occurred_at (UTC) | → IST (local) | role |
| --- | --- | --- | --- |
| 5001 | 03:42:00Z | **09:12** | ← first → **in_time** |
| 5002 | 07:30:00Z | 13:00 | middle (lunch — ignored) |
| 5003 | 08:15:00Z | 13:45 | middle (lunch — ignored) |
| 5004 | 13:00:00Z | **18:30** | ← last → **out_time** |

`in_time = 09:12 · out_time = 18:30 · total = 558 min`. The break
(13:00 → 13:45) is **not** deducted — total is the full span (first → last).

> **For manager review:** confirm whether lunch/break time should be
> **subtracted** from the total. Current design = full span (first tap → last
> tap). Break deduction is a policy add-on if required.

---

## Duplicate protection (per day, per employee)

| What | Table | Rows for Harikrishnan / 1 day | Why no duplicates |
| --- | --- | --- | --- |
| Device identity | `device_users` | **1** | upsert on (tenant, device, device_user_id) |
| Every tap | `device_attendance_events` | **N** (4) | unique event_serial |
| Every "seen" | `detection_events` | **N** (4) | one per staged event |
| The attendance | `attendance_records` | **1** | unique (tenant, employee, date) |

**N taps per day → N events → 1 attendance row.** Sync repeatedly, tap
repeatedly — the design never double-counts.

---

## Build status

| Table | Built? |
| --- | --- |
| `attendance_devices` | ✅ migration 0094 applied |
| `device_users` | ⏳ migration 0095 (pending) |
| `device_attendance_events` | ⏳ migration 0095 (pending) |
| `detection_events` (source / device_id columns) | ⏳ migration 0095 (pending) |
| `attendance_records` | ✅ exists (unchanged) |

## Open decisions for approval

1. **Break deduction** — full span (current) vs subtract lunch break.
2. **Fingerprint enrollment** — done once on-device per employee (cannot be
   pushed); face is pushed automatically by Maugood.
3. **Matching authority** — trust the device's on-device match (default) vs
   re-match the captured face in Maugood.
