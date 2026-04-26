"""Build CSV / JSON file payloads for the ERP file-drop.

The columns + JSON shape are documented in
``docs/erp-file-drop-schema.md``; we mirror that doc here so the
file the runner produces is the file the schema doc describes.

Pure: no DB access. Caller pulls rows via ``_fetch_rows`` and hands
them in.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, select
from sqlalchemy.engine import Connection

from hadir.db import (
    attendance_records,
    departments,
    employees,
    shift_policies,
    tenants,
)
from hadir.tenants.scope import TenantScope


CSV_COLUMNS: tuple[str, ...] = (
    "employee_code",
    "full_name",
    "date",
    "in_time",
    "out_time",
    "total_minutes",
    "late",
    "early_out",
    "short_hours",
    "overtime_minutes",
    "status",
    "policy_code",
    "tenant_slug",
)


@dataclass(frozen=True, slots=True)
class ExportRow:
    employee_code: str
    full_name: str
    date: date
    in_time: Optional[time]
    out_time: Optional[time]
    total_minutes: Optional[int]
    late: bool
    early_out: bool
    short_hours: bool
    overtime_minutes: int
    status: str
    policy_code: str
    tenant_slug: str


def fetch_rows(
    conn: Connection,
    scope: TenantScope,
    *,
    start_date: date,
    end_date: date,
    tenant_slug: str,
) -> list[ExportRow]:
    """Pull attendance rows for the date window. Joined to employees,
    departments, and shift_policies. Status reflects the engine flags
    in priority order: leave > absent > late > short > early_out > on_time.
    """

    stmt = (
        select(
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.status.label("employee_status"),
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.late,
            attendance_records.c.early_out,
            attendance_records.c.short_hours,
            attendance_records.c.absent,
            attendance_records.c.overtime_minutes,
            attendance_records.c.leave_type_id,
            shift_policies.c.name.label("policy_name"),
            shift_policies.c.type.label("policy_type"),
        )
        .select_from(
            attendance_records.join(
                employees,
                and_(
                    employees.c.id == attendance_records.c.employee_id,
                    employees.c.tenant_id == attendance_records.c.tenant_id,
                ),
            ).join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date >= start_date,
            attendance_records.c.date <= end_date,
        )
        .order_by(
            attendance_records.c.date.asc(),
            employees.c.employee_code.asc(),
        )
    )
    rows = conn.execute(stmt).all()
    out: list[ExportRow] = []
    for r in rows:
        out.append(
            ExportRow(
                employee_code=str(r.employee_code),
                full_name=str(r.full_name),
                date=r.date,
                in_time=r.in_time,
                out_time=r.out_time,
                total_minutes=int(r.total_minutes) if r.total_minutes is not None else None,
                late=bool(r.late),
                early_out=bool(r.early_out),
                short_hours=bool(r.short_hours),
                overtime_minutes=int(r.overtime_minutes),
                status=_status_for(r),
                policy_code=str(r.policy_type),
                tenant_slug=tenant_slug,
            )
        )
    return out


def _status_for(row) -> str:  # type: ignore[no-untyped-def]
    """Reduce the engine flags to a single string the ERP can switch on."""

    if row.leave_type_id is not None:
        return "leave"
    if row.absent:
        return "absent"
    if row.late:
        return "late"
    if row.short_hours:
        return "short"
    if row.early_out:
        return "early_out"
    return "on_time"


def _format_time(t: Optional[time]) -> str:
    return t.strftime("%H:%M:%S") if t is not None else ""


def render_csv(rows: Iterable[ExportRow]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for r in rows:
        writer.writerow(
            [
                r.employee_code,
                r.full_name,
                r.date.isoformat(),
                _format_time(r.in_time),
                _format_time(r.out_time),
                r.total_minutes if r.total_minutes is not None else "",
                "true" if r.late else "false",
                "true" if r.early_out else "false",
                "true" if r.short_hours else "false",
                r.overtime_minutes,
                r.status,
                r.policy_code,
                r.tenant_slug,
            ]
        )
    return buf.getvalue().encode("utf-8")


def render_json(
    rows: Iterable[ExportRow],
    *,
    metadata: dict,
) -> bytes:
    """Top-level object with a ``metadata`` block + ``records`` array.

    Documented in ``docs/erp-file-drop-schema.md``. The metadata
    block lets the consumer verify what they got (range, count,
    tenant) without parsing dates from the file body.
    """

    serialised: list[dict] = []
    for r in rows:
        serialised.append(
            {
                "employee_code": r.employee_code,
                "full_name": r.full_name,
                "date": r.date.isoformat(),
                "in_time": _format_time(r.in_time) or None,
                "out_time": _format_time(r.out_time) or None,
                "total_minutes": r.total_minutes,
                "late": r.late,
                "early_out": r.early_out,
                "short_hours": r.short_hours,
                "overtime_minutes": r.overtime_minutes,
                "status": r.status,
                "policy_code": r.policy_code,
                "tenant_slug": r.tenant_slug,
            }
        )
    payload = {"metadata": metadata, "records": serialised}
    return json.dumps(payload, indent=2).encode("utf-8")


def filename_for(*, fmt: str, now: datetime) -> str:
    return f"hadir-attendance-{now.strftime('%Y%m%d-%H%M%S')}.{fmt}"


def get_tenant_slug(conn: Connection, *, tenant_id: int) -> str:
    """Return the friendly slug from ``public.tenants.slug``.

    The ERP file-drop schema (``docs/erp-file-drop-schema.md``)
    surfaces ``tenant_slug`` to the integration team — they consume
    the friendly identifier, not the internal Postgres schema name.
    """

    row = conn.execute(
        select(tenants.c.slug).where(tenants.c.id == tenant_id)
    ).first()
    return str(row.slug) if row is not None else f"tenant-{tenant_id}"
