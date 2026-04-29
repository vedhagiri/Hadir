# Maugood — data retention policy

This document is the durable, per-table reference for what
Maugood keeps, what it sweeps, and why. Operators consulting it
should be able to answer "where does my X go" in one lookup.

The mechanism is the daily 03:00 (Asia/Muscat) APScheduler job
`maugood.retention.run_retention_sweep`, started by the FastAPI
lifespan. Source of truth is `backend/maugood/retention/sweep.py`.

The PDPL right-to-erasure flow is the only path that mutates
PII outside of the standard CRUD surfaces; see the bottom of
this doc.

---

## Per-table policy

| Table                       | Retention             | Purge rule                                                    | Source                                |
| --------------------------- | --------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `audit_log`                 | **forever**           | NEVER purged. Append-only at the DB grant level (P2).         | BRD NFR-RET-001 (red line)            |
| `attendance_records`        | **forever**           | NEVER purged.                                                 | BRD NFR-RET-004                       |
| `detection_events`          | **forever**           | NEVER purged.                                                 | BRD NFR-RET-004                       |
| `employees`                 | **forever**           | NEVER purged. PDPL redacts PII in place.                      | BRD NFR-RET-004                       |
| `employee_photos`           | **forever**           | NEVER purged. PDPL drops files + rows on operator request.    | BRD FR-EMP-009 / NFR-COMP-003         |
| `requests`                  | **forever**           | NEVER purged.                                                 | BRD NFR-RET-004                       |
| `approved_leaves`           | **forever**           | NEVER purged.                                                 | BRD NFR-RET-004                       |
| `request_attachments`       | **forever**           | NEVER purged. (Files encrypted at rest under `/data/attachments/`.) | BRD NFR-RET-004              |
| `camera_health_snapshots`   | **30 days**           | DELETE where `captured_at < now() - 30 days`.                 | BRD FR-CAM-007                        |
| `notifications`             | **90 days**           | DELETE where `created_at < now() - 90 days`.                  | BRD §"Notifications"                  |
| `report_runs`               | **90 days post-finish** | DELETE row + on-disk file (file first) where `finished_at < now() - 90 days`. | BRD §"Reports"                  |
| `user_sessions`             | **7 days post-expiry** | DELETE where `expires_at < now() - 7 days`.                  | BRD §"Sessions"                       |
| Other operational tables    | indefinitely          | Reviewed per-phase; no automatic sweep today.                 | —                                     |

The four sweeping rules are all overrideable via env var:
`MAUGOOD_RETENTION_CAMERA_HEALTH_DAYS`,
`MAUGOOD_RETENTION_NOTIFICATIONS_DAYS`,
`MAUGOOD_RETENTION_REPORT_RUNS_DAYS`,
`MAUGOOD_RETENTION_USER_SESSIONS_DAYS`. Setting any to 0 (or a
non-numeric value) falls back to the BRD default.

---

## Red lines

* **`audit_log` is never purged.** It's append-only at the
  database grant level (the `maugood_app` role has INSERT +
  SELECT only). Anything that *appears* to delete from it is
  a bug — file an issue.
* **Attendance + detection events stay indefinitely.** They
  underpin payroll and any post-incident face-match audit.
  The pilot deliberately accepts the storage cost.
* **PDPL redacts in place.** A right-to-erasure request
  removes photos and custom-field values, but the employee
  row + their attendance, detection events, requests, and
  audit trail remain. The employee row is updated with
  `full_name='[deleted]'` and `email='deleted-{id}@maugood.local'`
  so the historical records reference a non-PII placeholder.

---

## Logging

Application logs and the application-side audit breadcrumbs
land in two separate files (P25):

| File                          | Purpose                                                         | Retention                              |
| ----------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| `backend/logs/app.log`        | Root logger — INFO+ across the whole app, including stdlib.    | Daily rotation, 30 backups, gzip.      |
| `backend/logs/audit.log`      | `maugood.audit` logger — operator breadcrumbs (PDPL, retention sweeps, etc.) | Daily rotation, 30 backups, gzip. |

Rotation is handled by `maugood.logging_config.GzipRotatingFileHandler`,
which rotates at midnight UTC and gzips each rotated copy in
place. Backup count is overrideable via `MAUGOOD_LOG_BACKUP_COUNT`.

Both files are operator-facing breadcrumbs only. The DB-side
`audit_log` table is the source of truth for cryptographic-
audit-style records.

---

## PDPL right-to-erasure flow

Endpoint: `POST /api/employees/{id}/gdpr-delete` (Admin-only).

Request body:
```json
{ "confirmation": "I CONFIRM PDPL DELETION" }
```

The phrase is exact — case- and whitespace-sensitive — so a
fat-fingered curl can't accidentally invoke this. The phrase
is exposed via `maugood.employees.pdpl.PDPL_CONFIRMATION_PHRASE`
for the UI to render verbatim.

What runs (single transaction):

1. Drop every `employee_photos` row for the employee. Best-
   effort delete the encrypted file under
   `/data/faces/{tenant_id}/{employee_code}/...`. Files that
   no longer exist on disk are not an error — the row is
   removed regardless.
2. Drop every `custom_field_values` row for the employee.
3. Update the employees row:
   * `full_name = '[deleted]'`
   * `email = 'deleted-{id}@maugood.local'`
   * `status = 'deleted'`
4. Invalidate the in-memory `MatcherCache` entry for the
   employee so a captured face never re-matches against
   them post-delete.
5. Write an `audit_log` row with `action='pdpl_delete'`,
   carrying the *previous* full_name + email in the audit
   payload. The audit row is append-only — it can never be
   redacted.
6. Echo a one-line breadcrumb to `backend/logs/audit.log`
   (no PII in the file copy).

What survives (intentional):

* `attendance_records` — historical hours worked.
* `detection_events` — historical face-match outcomes
  (employee_id stays linked to the row).
* `requests` / `approved_leaves` — historical leave +
  exception requests.
* `audit_log` — every operation the employee or system did
  on their behalf.

These rows now reference an employee whose displayed name is
`[deleted]` and whose email is the placeholder. Anyone
running a verifiable-records audit can trace "who did what"
without learning who the deleted person was.

PDPL deletion is **idempotent in spirit** but **rejected in
practice**: a second call against an already-deleted employee
returns HTTP 409. That's deliberate — operators should know
when a request is repeated.

---

## Operator quickref

```sh
# See what the daily sweep would drop right now (read-only):
docker compose exec backend python -c "
from maugood.retention.sweep import run_retention_sweep
from maugood.db import make_admin_engine
res = run_retention_sweep(make_admin_engine())
for p in res.per_tenant:
    print(p)
"

# Tail the audit-side log:
docker compose exec backend tail -f /app/logs/audit.log

# Trigger a PDPL delete from the CLI:
curl -s -b $COOKIE -X POST \
  -H 'Content-Type: application/json' \
  -d '{"confirmation":"I CONFIRM PDPL DELETION"}' \
  https://maugood.example.com/api/employees/123/gdpr-delete
```
