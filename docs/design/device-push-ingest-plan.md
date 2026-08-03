# Device push ingest — design plan

**Status:** Phase 1 **implemented** (2026-08-04). Phases 2–3 outstanding.
**Supersedes the registration half of:** `docs/design/device-attendance-integration.md`
**Built on:** migrations `0094_attendance_devices`, `0095_device_users_events`,
`0096_device_push_tokens`

## What shipped

| Piece | Where |
| --- | --- |
| Migration | `alembic/versions/0096_device_push_tokens.py` |
| Token mint / hash / registry | `maugood/devices/tokens.py` |
| Payload normalisation (pure) | `maugood/devices/ingest.py` |
| Anonymous ingest endpoint | `maugood/devices/ingest_router.py` |
| Staging → attendance | `maugood/devices/processor.py` |
| Registration + mapping API | `maugood/devices/router.py` |
| UI | `frontend/src/features/devices/` |
| Unit tests (24) | `tests/test_device_push_ingest.py` |
| Live end-to-end smoke (25 checks) | `scripts/smoke_device_push.py` |

**Endpoints added**

```
POST /hik/{token}                                  anonymous ingest
POST /api/devices/ingest/{token}                   same handler, /api alias
POST /api/devices/{id}/regenerate-token            Admin
GET  /api/devices/{id}/events                      Admin
POST /api/devices/{id}/users/{device_user_id}/map  Admin
POST /api/devices/{id}/users/auto-map              Admin
```

**Deviations from the original plan**

* **Token stays at the operator's `b1d1-9f3a7` shape** (~36 bits) rather than
  the 128-bit form proposed in §3.1. Mitigated by per-token rate limiting and
  a logged rejection on every miss. If ingest is ever exposed without that
  throttle, lengthen `_GROUPS` in `tokens.py`.
* **Setup panel shows one complete URL**, not the four separate Hikvision
  fields — the single string already carries protocol, host, token and name.
* **Ingest drains inline** (bounded, 50 rows) as well as via replay, so a tap
  reaches attendance within the same request instead of waiting for a tick.
  The standalone 30-second drainer in §7 is not yet scheduled; `drain_pending`
  exists and is called from the ingest path and from mapping replay.

**Known gaps** (Phase 2 / 3): silent-device detection, the periodic drainer as
a scheduled job, i18n keys (the UI ships English `defaultValue` fallbacks), and
the `connection_mode` UI for `pull` / `both` devices.

---

## 1. The change in one line

Registration flips from **Maugood dials the device** (needs IP, port, username,
password, and a reachable route) to **the device dials Maugood** (needs nothing
but a URL we generate).

| | Committed today (pull) | This plan (push) |
|---|---|---|
| Operator supplies | IP, port, door no, username, password | device name |
| Maugood supplies | — | push URL + token |
| Needs inbound route to device | yes | no |
| Works behind NAT / on a branch LAN | no | yes |
| Event latency | poll interval | real time |

The push model is what the Hikvision **Configuration → Network → Network
Service → HTTP Listening** screen drives, and it is the only model that works
when terminals sit on branch networks we cannot reach.

---

## 2. What "add device" becomes

The form asks for **three** things:

- **Device name** — e.g. `Entrance`
- **Branch / location** — optional label, e.g. `Head Office`
- **Enabled** — toggle

On save, Maugood mints a token and immediately shows a **Device setup** panel
containing the four values the operator types into the terminal, each with its
own copy button, laid out to mirror the device's own form:

| Device field | Value |
|---|---|
| Event Alarm IP/Domain Name | `getdata.mts-om.com` *(from settings)* |
| URL | `/api/devices/ingest/<token>?device_name=entrance` |
| Port | `443` |
| Protocol | `HTTPS` |

Everything else — serial number, model, firmware, user list — is **learned from
the first event the device sends**. Nothing is asked of the operator that the
device can tell us itself.

---

## 3. Token design

### 3.1 Length

The prototype token `b1d1-9f3a7` is ~40 bits. This token is the *only*
authentication on a public, unauthenticated endpoint, so 40 bits is too few —
it is guessable at scale, and a guessed token lets an attacker inject
attendance records into a tenant.

**Recommendation:** keep the readable shape, raise the entropy.

```
dev_7f3a_QmVhcm5hcmRvU2lsdmE4OTIz     # "dev_" + 4-char label + 128+ bits
```

Generated with `secrets.token_urlsafe(24)`. The short `7f3a` segment is what the
UI shows in lists so an operator can tell two devices apart without exposing the
secret.

### 3.2 Storage

Two columns, because we need two different things from it:

- **`push_token_hash`** — SHA-256, `UNIQUE`, indexed. This is what ingest looks
  up. Never reversible.
- **`push_token_encrypted`** — Fernet, using the existing `MAUGOOD_FERNET_KEY`.
  Exists solely so an operator re-configuring a replacement terminal can view
  the token again instead of rotating it.

This satisfies the Fernet-at-rest red line and keeps lookup to a single indexed
hit.

### 3.3 Rotation

A **Regenerate token** action on the device card: mints a new token, revokes the
old one, audits `device.push_token_rotated`. The old token stops working
immediately — the operator must reconfigure the terminal. The UI must say so
plainly before confirming.

---

## 4. The load-bearing piece: resolving tenant on an anonymous request

Ingest arrives with no session cookie, no tenant cookie, and no `Authorization`
header. Before we can write anything we must know which tenant schema to write
into.

**The existing precedent is not reusable here.** The signed-URL report download
(`scheduled_reports/router.py`) resolves its tenant by enumerating
`public.tenants` and re-querying each schema until it finds the row — its own
docstring calls this a "pilot simplification". That is an `O(tenants)` scan with
a fresh transaction per schema. A report download happens occasionally; a device
tap happens every few seconds per door, all day, across every branch. The scan
would become the bottleneck and would get worse with every tenant onboarded.

**Instead: a global token registry in `public`.**

```
public.device_push_tokens
  token_hash     TEXT PRIMARY KEY        -- sha256 of the token
  tenant_id      INT  → public.tenants.id
  tenant_schema  TEXT                    -- denormalised, avoids a second hop
  device_id      INT                     -- id within that tenant's schema
  revoked_at     TIMESTAMPTZ NULL
  created_at     TIMESTAMPTZ
```

Ingest does exactly one indexed lookup, then enters `tenant_context(schema)` and
behaves like every other tenant-scoped write from that point on.

### Why this does not weaken tenant isolation

- The table holds **no attendance data** — only the routing tuple
  `token → (tenant, device)`.
- The token *determines* the tenant. There is no user-supplied tenant hint to
  confuse, so cross-tenant writes are structurally impossible rather than
  merely filtered.
- Every write after resolution still runs inside `tenant_context` **and** carries
  an explicit `WHERE tenant_id = :scope` — search_path is the floor, the filter
  is the wall, unchanged.
- A revoked token resolves to nothing and the request is rejected before any
  schema is touched.

### Migration-lint consequence

Creating a table in `public` requires adding `0096_*.py` to the `_WHITELIST` in
`tests/test_migration_lint.py`, with a justification in the migration docstring —
the same treatment `0009_super_admin.py` received for its global tables. **This
is a deliberate, reviewable exception, not an authoring shortcut**, and should be
called out in review rather than slipped in.

---

## 5. Two defects visible in the prototype payload

```json
{"branch": "branch1", "device": "device1", "employee_no": "1001",
 "name": "Giri", "attendance_status": "checkOut",
 "verify_mode": "faceOrFpOrCardOrPw", "event_serial": 170,
 "event_time": "1970-01-01T01:16:27+04:00"}
```

### 5.1 The device clock is not set — `1970-01-01`

Taken at face value this books attendance on 1 January 1970. The employee shows
**absent today, forever**, and no one notices until payroll.

**Fix in two places:**

- **On the device:** set NTP under Configuration → System → Time. This is the
  real fix and should be a mandatory step in the install checklist.
- **In ingest (defence in depth):** if `occurred_at` falls outside
  `[now − 7 days, now + 1 day]`, fall back to server receive time, set
  `clock_suspect = true` on the row, and raise a **"device clock not set"**
  warning on the device card. Never silently accept a 1970 timestamp, and never
  silently discard the event either.

### 5.2 `event_serial` resets to zero

`event_serial` is a per-device counter that restarts after a factory reset or an
event-log clear. The unique key shipped in migration 0095 is
`(tenant_id, device_id, event_serial)` — after a reset, serial `171` arrives
again, collides, and **every event for the rest of that day is silently swallowed
as a duplicate**. Silent data loss is the worst failure mode here because
attendance simply looks thin; nothing errors.

**Fix:** widen the dedup key so a reset cannot alias onto old rows:

```
dedup_key = sha256(device_id | event_serial | occurred_at)
```

stored as a column with `UNIQUE (tenant_id, dedup_key)`, replacing the existing
constraint. Re-pushes of the *same* event still collapse correctly, because a
genuine duplicate carries the same serial *and* the same timestamp.

---

## 6. Field mapping

| Device payload | Column | Notes |
|---|---|---|
| `employee_no` | `device_user_id` | matched to `employees.employee_code` |
| `name` | `name` | display only — never used for matching |
| `event_serial` | `event_serial` | + `dedup_key` per §5.2 |
| `event_time` | `occurred_at` | sanity-windowed per §5.1 |
| `verify_mode` | `verify_mode` | stored raw, not interpreted |
| `attendance_status` | `direction` | **stored, never computed on** — see below |
| `branch` / `device` | `reported_device_name` | label only, never identity |
| whole body | `raw` (JSONB) | forensics |

### `attendance_status` is recorded but ignored

The attendance engine derives **in = first tap of the day, out = last tap**, and
deliberately ignores the direction label, because operators tap the wrong way
round constantly and terminals mislabel after a reboot. `checkIn`/`checkOut` is
kept for reporting and audit only. **This is existing, intended behaviour — it
should not be "fixed" later without a decision.**

### `device_name` query param is a label, never identity

The token identifies the device. `?device_name=entrance` is a convenience for
reading logs. Store it as `reported_device_name`; if it disagrees with the
device's registered name, show a soft mismatch hint in the UI rather than
routing on it. (The prototype's `DEVICES` map keys on token — correct.)

---

## 7. The endpoint

```
POST /api/devices/ingest/{token}
```

- **Anonymous** — token in path is the credential.
- **Still behind the HTTPS gate.** Do *not* add it to `_HTTPS_EXEMPT_PATHS`
  (unlike `/metrics`): the URL carries a secret, so plain HTTP must keep being
  refused in production.
- **Accepts both content types.** Hikvision sends `multipart/form-data` (JSON
  part + JPEG) when picture upload is on, and `application/json` when it is off.
  An endpoint that handles only JSON silently drops half the events.
- **Always returns `200` fast**, including for an unknown employee. Terminals
  retry-storm and fill their local buffer on any non-2xx. Only an unknown or
  revoked token gets a `401`.
- **Rate-limited per token**, reusing the bucket pattern already in
  `scheduled_reports/router.py`.
- **Never logs the token.** The prototype prints `Received token: 'b1d1-9f3a7'`,
  which writes a live credential into `app.log` — that is the exact class of
  leak the "no plaintext secrets in logs" red line exists to prevent. Log
  `device_id` instead.

### Write path

1. Resolve token → tenant (one indexed lookup, §4).
2. `tenant_context(schema)`.
3. Insert `device_attendance_events` with `ON CONFLICT DO NOTHING` (idempotent).
4. Return `200`.

A **30-second drainer** then moves `pending → processed`: resolve the employee,
insert `detection_events(source='device', device_id, camera_id=NULL)`, call
`attendance.scheduler.recompute_for(...)`.

Splitting the drain out of the request keeps a slow recompute from ever timing
out the device's POST — the terminal gets its `200` in milliseconds regardless
of how long attendance takes to settle.

**No attendance-engine change is required.** `events_for` filters only on
`(tenant_id, employee_id, captured_at)`, so device rows flow through policies,
Ramadan handling, leave, holidays, and reports unchanged. The seed script already
proved this end to end.

### Unmapped taps

`employee_no` with no matching `employee_code` → park the row as `skipped`,
never auto-create an employee (same rule as bulk photo ingest). Surface an
**"N unmapped taps"** count on the device card so it gets fixed rather than lost.

---

## 8. Health without reachability

A push-only device cannot be pinged, so `health_status` must be re-derived from
traffic:

- **Waiting for first event** — registered, nothing received yet.
- **Online** — an event or heartbeat arrived within the last *N* minutes.
- **Silent** — nothing during working hours for *N* hours. This is the state
  that actually matters: a dead terminal at a door looks identical to a quiet
  one, and only the working-hours window distinguishes them.

Hikvision can be configured to send a periodic keepalive to the same URL. Treat
it as liveness only — it must **not** create an attendance row.

---

## 9. What happens to the pull code already committed

**Keep it.** Add `connection_mode`:

- `push` *(new default)* — no IP or credentials; sync-users button hidden.
- `pull` — the committed ISAPI behaviour, for LAN-reachable terminals.
- `both` — push for events, pull for user sync and face enrollment.

`host`, `port`, `credentials_encrypted`, and `serial_number` become **nullable**.
This preserves a working, tested feature at near-zero risk instead of deleting it.

### The operational consequence you must accept

Pushing an employee's **face photo to the terminal** requires reaching the
terminal. In `push`-only mode that is impossible, so:

> **Push-only devices must have faces and fingerprints enrolled at the terminal
> itself.** Remote face enrollment from Maugood requires `pull` or `both`, which
> requires a route to the device (VPN or port-forward).

Fingerprints were already enrol-at-device-only. This extends the same constraint
to faces for push-only sites. Worth confirming against how Omran actually plans
to enroll staff at branches before committing to push-only everywhere.

---

## 10. Migration `0096_device_push_tokens`

- `public.device_push_tokens` — global registry (§4); lint whitelist entry
  required with justification.
- `attendance_devices`: add `push_token_hash` (unique), `push_token_encrypted`,
  `connection_mode`, `reported_device_name`, `last_event_at`, `clock_suspect`.
- `attendance_devices`: relax `host`, `port`, `credentials_encrypted`,
  `serial_number` to nullable.
- `device_attendance_events`: add `dedup_key`; replace
  `uq_device_events_tenant_device_serial` with `UNIQUE (tenant_id, dedup_key)`.
- Grants for `maugood_app` on the new table; `audit_log` untouched.

Backfill: existing rows get `connection_mode='pull'` so nothing already
registered changes behaviour.

---

## 11. Delivery order

**Phase 1 — the flow works end to end**
Migration, token mint + registry, simplified Add-device form, setup panel with
copy buttons, ingest endpoint, dedup, drainer → attendance.
*Done when: a real tap at the terminal appears in Attendance within a minute.*

**Phase 2 — operable**
Clock-suspect warning, unmapped-taps count, silent-device health, regenerate
token, device detail drawer showing recent raw events.
*Done when: an operator can diagnose a misbehaving terminal without the DB.*

**Phase 3 — optional LAN**
Re-enable sync-users and face push for `pull` / `both` devices.

---

## 12. Tests

- Ingest with valid token → `200` + one staged row.
- Same event twice → one row (dedup).
- Serial reset collision → both rows survive (§5.2).
- `1970` timestamp → falls back to receive time, `clock_suspect` set (§5.1).
- Unknown token → `401`, nothing written.
- Revoked token → `401`.
- **Tenant A's token can never write into tenant B** — extend the two-tenant
  isolation canary.
- Multipart *and* JSON bodies both accepted.
- Token never appears in `app.log` or any audit row.
- Unknown `employee_no` → `skipped`, no employee auto-created.

---

## 13. Open questions for the operator

1. **Is `getdata.mts-om.com` intended to become Maugood, or does it stay a
   separate collector that forwards to us?** Nothing in Maugood serves `/hik/*`
   today. This decides whether we own the ingest URL or accept a forwarded feed.
2. **Will any site be LAN-reachable?** Decides whether `pull`/`both` matters or
   we go push-only and enroll faces at the terminal.
3. **Certificate on the push host** — Hikvision terminals reject self-signed
   certificates and fail the push *silently*, with no error shown in their UI.
   A publicly-valid certificate is required.
