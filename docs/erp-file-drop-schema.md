# Maugood → ERP file-drop schema

**Version:** 1
**Last updated:** 2026-04-25 (v1.0 P19)
**Audience:** ERP integration teams.

## Overview

Maugood writes a daily attendance export file into a directory the
client's ERP polls. One file per run, named:

```
maugood-attendance-{YYYYMMDD}-{HHmmss}.{csv|json}
```

The timestamp is UTC. Format and cadence are configured per tenant
in **Settings → Integrations → ERP Export**. Output is always
written under `/data/erp/{tenant_id}/` (the operator-supplied
relative subpath is joined under that root and **never** escapes
it).

## Common semantics

| Field | Type | Notes |
| --- | --- | --- |
| `employee_code` | string | Tenant-unique HR code, e.g. `OM0042`. |
| `full_name` | string | Display name as recorded in Maugood. |
| `date` | string `YYYY-MM-DD` | Attendance date. |
| `in_time` | string `HH:MM:SS` or empty / null | First detection of the day, in tenant timezone. |
| `out_time` | string `HH:MM:SS` or empty / null | Last detection of the day. |
| `total_minutes` | integer or empty / null | Minutes between in and out. Empty when no events. |
| `late` | boolean | True when in_time exceeded the policy's grace minutes. |
| `early_out` | boolean | True when out_time was earlier than (end − grace). |
| `short_hours` | boolean | True when total_minutes was below the policy's required minimum. |
| `overtime_minutes` | integer | Minutes worked beyond the policy's required hours. |
| `status` | string enum | Reduced single-string view — see "Status reduction" below. |
| `policy_code` | string | Internal policy type — `Fixed`, `Flex`, `Ramadan`, or `Custom`. |
| `tenant_slug` | string | Maugood tenant identifier (Postgres schema name). Useful for ERPs that consume multiple Maugood tenants. |

### Status reduction

`status` reduces the boolean flag set into a single string the ERP
can switch on without reading every flag. Priority order:

1. `leave` — an approved leave covers the date.
2. `absent` — no events recorded for the date.
3. `late` — late but not absent.
4. `short` — short hours but neither late nor absent.
5. `early_out` — left early but neither late nor short.
6. `on_time` — none of the above.

## CSV layout

* UTF-8, LF line terminator, comma separator, no BOM.
* Header row always present.
* Booleans serialised as the lowercase strings `true` / `false`.
* Empty cells (no event, no value) are written as the empty
  string.

```
employee_code,full_name,date,in_time,out_time,total_minutes,late,early_out,short_hours,overtime_minutes,status,policy_code,tenant_slug
OM0042,Aisha Al-Hinai,2026-04-25,07:28:42,15:34:12,486,false,false,false,6,on_time,Fixed,tenant_omran
OM0043,Yousuf Al-Kindi,2026-04-25,07:50:11,15:05:33,435,true,false,true,0,late,Fixed,tenant_omran
OM0044,Layla Al-Busaidi,2026-04-25,,,,false,false,false,0,absent,Fixed,tenant_omran
```

## JSON layout

UTF-8 encoded, single object at the top level:

```json
{
  "metadata": {
    "tenant_slug": "tenant_omran",
    "generated_at": "2026-04-25T08:00:14Z",
    "range_start": "2026-04-25",
    "range_end": "2026-04-25",
    "row_count": 3,
    "schema_version": 1
  },
  "records": [
    {
      "employee_code": "OM0042",
      "full_name": "Aisha Al-Hinai",
      "date": "2026-04-25",
      "in_time": "07:28:42",
      "out_time": "15:34:12",
      "total_minutes": 486,
      "late": false,
      "early_out": false,
      "short_hours": false,
      "overtime_minutes": 6,
      "status": "on_time",
      "policy_code": "Fixed",
      "tenant_slug": "tenant_omran"
    },
    {
      "employee_code": "OM0043",
      "full_name": "Yousuf Al-Kindi",
      "date": "2026-04-25",
      "in_time": "07:50:11",
      "out_time": "15:05:33",
      "total_minutes": 435,
      "late": true,
      "early_out": false,
      "short_hours": true,
      "overtime_minutes": 0,
      "status": "late",
      "policy_code": "Fixed",
      "tenant_slug": "tenant_omran"
    },
    {
      "employee_code": "OM0044",
      "full_name": "Layla Al-Busaidi",
      "date": "2026-04-25",
      "in_time": null,
      "out_time": null,
      "total_minutes": null,
      "late": false,
      "early_out": false,
      "short_hours": false,
      "overtime_minutes": 0,
      "status": "absent",
      "policy_code": "Fixed",
      "tenant_slug": "tenant_omran"
    }
  ]
}
```

## Versioning

`metadata.schema_version` is the integer this document describes. We
bump it whenever a column is added, renamed, or its semantics
change. Consumers should accept unknown extra fields without erroring
— Maugood will only break at a major version (`schema_version=2`).

## Operational notes

* **Atomicity.** A run writes the file in one ``write_bytes`` call.
  The file appears in the drop directory as a complete unit.
* **Retries.** The runner does not auto-retry. If a run fails, the
  config row's ``last_run_status`` is set to ``failed`` with an
  ``last_run_error`` message; the operator can hit "Run now" or wait
  for the next cron tick.
* **Date window.** Default window is 1 day (today, in the tenant's
  timezone). Operators can tune up to 180 days via
  ``window_days``. Wider windows produce larger files; the ERP
  should idempotently re-import based on `(employee_code, date)`.
* **Audit trail.** Every run writes a row to the tenant's
  `audit_log` (`erp_export.run_succeeded` or
  `erp_export.run_failed`) with the resolved file path, row count,
  and date range.
