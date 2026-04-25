"""Tenant-scoped SQL for attendance.

All queries filter by ``scope.tenant_id``. The engine itself is pure
(see ``engine.py``); this module is the thin layer that pulls inputs
out of the DB, hands them to the engine, and writes the result back.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from hadir.attendance.engine import AttendanceRecord, ShiftPolicy, policy_from_row
from hadir.config import get_settings
from hadir.db import (
    attendance_records,
    departments,
    detection_events,
    employees,
    shift_policies,
)
from hadir.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class AttendanceRow:
    """Joined shape the router returns to the frontend."""

    employee_id: int
    employee_code: str
    full_name: str
    department_id: int
    department_code: str
    department_name: str
    date: date
    in_time: Optional[time]
    out_time: Optional[time]
    total_minutes: Optional[int]
    policy_id: int
    policy_name: str
    late: bool
    early_out: bool
    short_hours: bool
    absent: bool
    overtime_minutes: int


def local_tz() -> ZoneInfo:
    return ZoneInfo(get_settings().local_timezone)


# --- Policy lookup ----------------------------------------------------------


def active_policy_for(
    conn: Connection, scope: TenantScope, *, the_date: date
) -> Optional[ShiftPolicy]:
    """Return the pilot policy covering ``the_date``.

    Multi-policy resolution (overlapping windows, per-department
    assignment) is a v1.0 concern. The pilot seed provides exactly one
    row; this query tolerates a second row (useful if an operator
    changes the policy mid-pilot) by taking the most recent
    ``active_from`` whose window covers ``the_date``.
    """

    row = conn.execute(
        select(
            shift_policies.c.id,
            shift_policies.c.name,
            shift_policies.c.type,
            shift_policies.c.config,
            shift_policies.c.active_from,
            shift_policies.c.active_until,
        )
        .where(
            shift_policies.c.tenant_id == scope.tenant_id,
            shift_policies.c.active_from <= the_date,
            or_(
                shift_policies.c.active_until.is_(None),
                shift_policies.c.active_until >= the_date,
            ),
        )
        .order_by(shift_policies.c.active_from.desc())
        .limit(1)
    ).first()
    if row is None:
        return None
    return policy_from_row(row)


# --- Event lookup -----------------------------------------------------------


def _local_day_bounds(the_date: date) -> tuple[datetime, datetime]:
    """Return (start_utc, end_utc) for the local-timezone day boundaries."""

    tz = local_tz()
    local_start = datetime.combine(the_date, time(0, 0), tzinfo=tz)
    local_end = datetime.combine(the_date, time(23, 59, 59, 999999), tzinfo=tz)
    return local_start, local_end


def events_for(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
) -> list[datetime]:
    """Return identified detection timestamps for the employee on the local date."""

    start_utc, end_utc = _local_day_bounds(the_date)
    rows = conn.execute(
        select(detection_events.c.captured_at)
        .where(
            detection_events.c.tenant_id == scope.tenant_id,
            detection_events.c.employee_id == employee_id,
            detection_events.c.captured_at >= start_utc,
            detection_events.c.captured_at <= end_utc,
        )
        .order_by(detection_events.c.captured_at.asc())
    ).all()
    tz = local_tz()
    # Return naive local-time datetimes so the engine compares wall clocks
    # directly against policy ``start`` / ``end`` (also naive ``time``).
    return [r.captured_at.astimezone(tz).replace(tzinfo=None) for r in rows]


# --- Employees --------------------------------------------------------------


def active_employee_ids(conn: Connection, scope: TenantScope) -> list[int]:
    rows = conn.execute(
        select(employees.c.id).where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.status == "active",
        )
    ).all()
    return [int(r.id) for r in rows]


# --- Upsert today's row -----------------------------------------------------


def upsert_attendance(
    conn: Connection,
    scope: TenantScope,
    record: AttendanceRecord,
) -> None:
    """Insert or update the (tenant_id, employee_id, date) row."""

    stmt = pg_insert(attendance_records).values(
        tenant_id=scope.tenant_id,
        employee_id=record.employee_id,
        date=record.date,
        in_time=record.in_time,
        out_time=record.out_time,
        total_minutes=record.total_minutes,
        policy_id=record.policy_id,
        late=record.late,
        early_out=record.early_out,
        short_hours=record.short_hours,
        absent=record.absent,
        overtime_minutes=record.overtime_minutes,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_attendance_records_tenant_emp_date",
        set_={
            "in_time": stmt.excluded.in_time,
            "out_time": stmt.excluded.out_time,
            "total_minutes": stmt.excluded.total_minutes,
            "policy_id": stmt.excluded.policy_id,
            "late": stmt.excluded.late,
            "early_out": stmt.excluded.early_out,
            "short_hours": stmt.excluded.short_hours,
            "absent": stmt.excluded.absent,
            "overtime_minutes": stmt.excluded.overtime_minutes,
            "computed_at": __import__("sqlalchemy").func.now(),
        },
    )
    conn.execute(stmt)


def list_for_employee_range(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    start_date: date,
    end_date: date,
) -> list["AttendanceRow"]:
    """Return attendance rows for one employee across a date range, descending."""

    stmt = (
        select(
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.policy_id,
            shift_policies.c.name.label("policy_name"),
            attendance_records.c.late,
            attendance_records.c.early_out,
            attendance_records.c.short_hours,
            attendance_records.c.absent,
            attendance_records.c.overtime_minutes,
        )
        .select_from(
            attendance_records.join(
                employees,
                and_(
                    employees.c.id == attendance_records.c.employee_id,
                    employees.c.tenant_id == attendance_records.c.tenant_id,
                ),
            )
            .join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
            .join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id == attendance_records.c.tenant_id,
                ),
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.employee_id == employee_id,
            attendance_records.c.date >= start_date,
            attendance_records.c.date <= end_date,
        )
        .order_by(attendance_records.c.date.desc())
    )
    rows = conn.execute(stmt).all()
    return [
        AttendanceRow(
            employee_id=int(r.employee_id),
            employee_code=str(r.employee_code),
            full_name=str(r.full_name),
            department_id=int(r.department_id),
            department_code=str(r.department_code),
            department_name=str(r.department_name),
            date=r.date,
            in_time=r.in_time,
            out_time=r.out_time,
            total_minutes=r.total_minutes,
            policy_id=int(r.policy_id),
            policy_name=str(r.policy_name),
            late=bool(r.late),
            early_out=bool(r.early_out),
            short_hours=bool(r.short_hours),
            absent=bool(r.absent),
            overtime_minutes=int(r.overtime_minutes),
        )
        for r in rows
    ]


# --- List for the day (GET endpoint) ---------------------------------------


def list_for_date(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
    department_ids: Optional[list[int]] = None,
    employee_id: Optional[int] = None,
    employee_ids: Optional[list[int]] = None,
) -> list[AttendanceRow]:
    """Return joined attendance rows for role-scoped listing.

    ``employee_ids`` (P8) is the explicit set of employees the caller
    is allowed to see — used by the Manager scope to combine
    department membership with direct ``manager_assignments``. When
    both ``employee_ids`` and ``department_ids`` are provided, rows
    must satisfy BOTH (intersection) so an Admin-style department
    filter still narrows the visibility further.
    """

    stmt = (
        select(
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.policy_id,
            shift_policies.c.name.label("policy_name"),
            attendance_records.c.late,
            attendance_records.c.early_out,
            attendance_records.c.short_hours,
            attendance_records.c.absent,
            attendance_records.c.overtime_minutes,
        )
        .select_from(
            attendance_records.join(
                employees,
                and_(
                    employees.c.id == attendance_records.c.employee_id,
                    employees.c.tenant_id == attendance_records.c.tenant_id,
                ),
            )
            .join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
            .join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id == attendance_records.c.tenant_id,
                ),
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date == the_date,
        )
        .order_by(employees.c.employee_code.asc())
    )
    if department_ids is not None:
        if not department_ids:
            return []
        stmt = stmt.where(employees.c.department_id.in_(department_ids))
    if employee_id is not None:
        stmt = stmt.where(employees.c.id == employee_id)
    if employee_ids is not None:
        if not employee_ids:
            # Manager has zero visible employees → empty list.
            # Distinguishes from ``None`` (unrestricted).
            return []
        stmt = stmt.where(employees.c.id.in_(employee_ids))

    rows = conn.execute(stmt).all()
    return [
        AttendanceRow(
            employee_id=int(r.employee_id),
            employee_code=str(r.employee_code),
            full_name=str(r.full_name),
            department_id=int(r.department_id),
            department_code=str(r.department_code),
            department_name=str(r.department_name),
            date=r.date,
            in_time=r.in_time,
            out_time=r.out_time,
            total_minutes=r.total_minutes,
            policy_id=int(r.policy_id),
            policy_name=str(r.policy_name),
            late=bool(r.late),
            early_out=bool(r.early_out),
            short_hours=bool(r.short_hours),
            absent=bool(r.absent),
            overtime_minutes=int(r.overtime_minutes),
        )
        for r in rows
    ]
