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

from hadir.attendance.engine import (
    AttendanceRecord,
    HolidayRecord,
    LeaveRecord,
    ShiftPolicy,
    policy_from_row,
)
from hadir.config import get_settings
from hadir.db import (
    approved_leaves,
    attendance_records,
    departments,
    detection_events,
    employees,
    holidays,
    leave_types,
    shift_policies,
    tenant_settings,
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
    """Server-scoped legacy fallback. New callers use ``local_tz_for``."""

    return ZoneInfo(get_settings().local_timezone)


# --- P11: tenant settings + leaves + holidays ------------------------------


@dataclass(frozen=True, slots=True)
class TenantTimeSettings:
    """Subset of ``tenant_settings`` used by the engine pipeline."""

    weekend_days: tuple[str, ...]
    timezone: str


def load_tenant_settings(
    conn: Connection, scope: TenantScope
) -> TenantTimeSettings:
    """Return the tenant's ``weekend_days`` + ``timezone``.

    Falls back to the global ``HADIR_LOCAL_TIMEZONE`` setting +
    ``("Friday", "Saturday")`` if no row exists. Defence in depth —
    the migration seeds rows for every tenant; this fallback only
    fires for partially-bootstrapped DBs.
    """

    row = conn.execute(
        select(
            tenant_settings.c.weekend_days,
            tenant_settings.c.timezone,
        ).where(tenant_settings.c.tenant_id == scope.tenant_id)
    ).first()
    if row is None:
        return TenantTimeSettings(
            weekend_days=("Friday", "Saturday"),
            timezone=get_settings().local_timezone,
        )
    raw_days = row.weekend_days or []
    return TenantTimeSettings(
        weekend_days=tuple(str(d) for d in raw_days),
        timezone=str(row.timezone or get_settings().local_timezone),
    )


def local_tz_for(settings: TenantTimeSettings) -> ZoneInfo:
    """ZoneInfo from tenant settings — the P11 red line in code form.

    Timezone is **tenant-scoped, not server-scoped**. Every
    attendance comparison must run through this helper or a value
    returned by ``load_tenant_settings``.
    """

    return ZoneInfo(settings.timezone)


def holidays_on(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
) -> list[HolidayRecord]:
    """Active holidays falling on ``the_date`` for this tenant."""

    rows = conn.execute(
        select(holidays.c.date, holidays.c.name).where(
            holidays.c.tenant_id == scope.tenant_id,
            holidays.c.date == the_date,
            holidays.c.active.is_(True),
        )
    ).all()
    return [HolidayRecord(date=r.date, name=str(r.name)) for r in rows]


def leaves_for_employee_on(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
) -> list[LeaveRecord]:
    """Approved leaves whose date range covers ``the_date`` for this employee."""

    rows = conn.execute(
        select(
            approved_leaves.c.leave_type_id,
            approved_leaves.c.start_date,
            approved_leaves.c.end_date,
            leave_types.c.code,
            leave_types.c.name,
            leave_types.c.is_paid,
        )
        .select_from(
            approved_leaves.join(
                leave_types,
                and_(
                    leave_types.c.id == approved_leaves.c.leave_type_id,
                    leave_types.c.tenant_id == approved_leaves.c.tenant_id,
                ),
            )
        )
        .where(
            approved_leaves.c.tenant_id == scope.tenant_id,
            approved_leaves.c.employee_id == employee_id,
            approved_leaves.c.start_date <= the_date,
            approved_leaves.c.end_date >= the_date,
        )
        .order_by(approved_leaves.c.id.asc())
    ).all()
    return [
        LeaveRecord(
            leave_type_id=int(r.leave_type_id),
            leave_type_code=str(r.code),
            leave_type_name=str(r.name),
            is_paid=bool(r.is_paid),
            start_date=r.start_date,
            end_date=r.end_date,
        )
        for r in rows
    ]


# --- Policy lookup ----------------------------------------------------------


def active_policy_for(
    conn: Connection, scope: TenantScope, *, the_date: date
) -> Optional[ShiftPolicy]:
    """Return *some* policy covering ``the_date`` for this tenant.

    Legacy fallback used when ``policy_assignments`` (P9) has no
    matching row in any of the three scope tiers. Picks the most
    recent ``active_from`` whose window covers ``the_date``.
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


# --- Multi-tier resolution (P9) --------------------------------------------


def _date_window_match(active_from_col, active_until_col, the_date):
    """SQLAlchemy expression: row covers ``the_date`` (NULL until = open-ended)."""

    return and_(
        active_from_col <= the_date,
        or_(
            active_until_col.is_(None),
            active_until_col >= the_date,
        ),
    )


def _custom_or_ramadan_for_date(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
    policy_type: str,
) -> Optional[ShiftPolicy]:
    """Return the Custom or Ramadan policy whose date range covers
    ``the_date`` for this tenant, or ``None``.

    Date-range filter is applied in Python because ``config`` is a
    JSONB blob — keeps the SQL portable and the index strategy
    simple. Tenant-scale (a few Custom days a year, one Ramadan) is
    well below the threshold where a JSON path index would matter.
    Multiple matches → most recent ``active_from`` wins (the policy
    table's existing window check still applies on top).
    """

    rows = conn.execute(
        select(
            shift_policies.c.id,
            shift_policies.c.name,
            shift_policies.c.type,
            shift_policies.c.config,
            shift_policies.c.active_from,
        )
        .where(
            shift_policies.c.tenant_id == scope.tenant_id,
            shift_policies.c.type == policy_type,
            shift_policies.c.active_from <= the_date,
            or_(
                shift_policies.c.active_until.is_(None),
                shift_policies.c.active_until >= the_date,
            ),
        )
        .order_by(shift_policies.c.active_from.desc())
    ).all()

    for row in rows:
        cfg = row.config or {}
        rs_raw = cfg.get("start_date")
        re_raw = cfg.get("end_date")
        if not rs_raw or not re_raw:
            # A Custom/Ramadan row missing its date range is
            # malformed — skip rather than apply tenant-wide.
            continue
        try:
            rs = date.fromisoformat(str(rs_raw))
            re_ = date.fromisoformat(str(re_raw))
        except ValueError:
            continue
        if rs <= the_date <= re_:
            return policy_from_row(row)
    return None


def resolve_policies_for_employees(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
    employee_ids: list[int],
) -> dict[int, ShiftPolicy]:
    """Return ``{employee_id: ShiftPolicy}`` via the resolution cascade.

    Priority — highest first wins (P10 update):

    0a. **Custom** policy whose date range covers ``the_date``
        (tenant-wide for that date — applies to every employee).
    0b. **Ramadan** policy whose date range covers ``the_date``
        (tenant-wide for that date).
    1.  Employee-scoped assignment matching this employee.
    2.  Department-scoped assignment matching this employee's
        ``department_id``.
    3.  Tenant-scoped assignment.
    4.  Legacy fallback — any ``shift_policies`` row covering the
        date (the pilot seeded this; new tenants may rely on it too
        if no ``policy_assignments`` rows exist).

    **Only one policy applies per (employee, date) — no stacking.**
    Custom beats Ramadan beats everything else; this is the
    deterministic priority documented in
    ``backend/CLAUDE.md §"Policy resolution priority"``.

    Resolution is the **only DB-touching part** of the engine
    pipeline (P9 red line). The engine itself receives the resolved
    ``ShiftPolicy`` and stays pure.
    """

    if not employee_ids:
        return {}

    from hadir.db import policy_assignments  # noqa: PLC0415

    # ----- Tier 0a + 0b: Custom / Ramadan tenant-wide overrides -----
    custom = _custom_or_ramadan_for_date(
        conn, scope, the_date=the_date, policy_type="Custom"
    )
    if custom is not None:
        # Tenant-wide one-off — every employee uses it for this date.
        return {eid: custom for eid in employee_ids}

    ramadan = _custom_or_ramadan_for_date(
        conn, scope, the_date=the_date, policy_type="Ramadan"
    )
    if ramadan is not None:
        return {eid: ramadan for eid in employee_ids}

    # 1. Employee-scoped — at most one policy per employee in scope.
    emp_rows = conn.execute(
        select(
            policy_assignments.c.scope_id.label("scope_id"),
            shift_policies.c.id,
            shift_policies.c.name,
            shift_policies.c.type,
            shift_policies.c.config,
        )
        .select_from(
            policy_assignments.join(
                shift_policies,
                and_(
                    shift_policies.c.id == policy_assignments.c.policy_id,
                    shift_policies.c.tenant_id == policy_assignments.c.tenant_id,
                ),
            )
        )
        .where(
            policy_assignments.c.tenant_id == scope.tenant_id,
            policy_assignments.c.scope_type == "employee",
            policy_assignments.c.scope_id.in_(employee_ids),
            _date_window_match(
                policy_assignments.c.active_from,
                policy_assignments.c.active_until,
                the_date,
            ),
        )
        .order_by(policy_assignments.c.active_from.desc())
    ).all()
    by_employee: dict[int, ShiftPolicy] = {}
    for r in emp_rows:
        eid = int(r.scope_id)
        if eid not in by_employee:
            by_employee[eid] = policy_from_row(r)

    # Resolve every employee's department in one query — we'll need
    # it for tier 2 lookups even when no employee-scope hit landed.
    emp_dept_rows = conn.execute(
        select(employees.c.id, employees.c.department_id).where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id.in_(employee_ids),
        )
    ).all()
    dept_by_employee = {int(r.id): int(r.department_id) for r in emp_dept_rows}
    needed_dept_ids = sorted(
        {
            dept_by_employee[eid]
            for eid in employee_ids
            if eid in dept_by_employee and eid not in by_employee
        }
    )

    # 2. Department-scoped — only fetch for departments still needed.
    by_department: dict[int, ShiftPolicy] = {}
    if needed_dept_ids:
        dept_rows = conn.execute(
            select(
                policy_assignments.c.scope_id.label("scope_id"),
                shift_policies.c.id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
            )
            .select_from(
                policy_assignments.join(
                    shift_policies,
                    and_(
                        shift_policies.c.id == policy_assignments.c.policy_id,
                        shift_policies.c.tenant_id
                        == policy_assignments.c.tenant_id,
                    ),
                )
            )
            .where(
                policy_assignments.c.tenant_id == scope.tenant_id,
                policy_assignments.c.scope_type == "department",
                policy_assignments.c.scope_id.in_(needed_dept_ids),
                _date_window_match(
                    policy_assignments.c.active_from,
                    policy_assignments.c.active_until,
                    the_date,
                ),
            )
            .order_by(policy_assignments.c.active_from.desc())
        ).all()
        for r in dept_rows:
            did = int(r.scope_id)
            if did not in by_department:
                by_department[did] = policy_from_row(r)

    # 3. Tenant-scoped — at most one applicable per date in practice.
    tenant_row = conn.execute(
        select(
            shift_policies.c.id,
            shift_policies.c.name,
            shift_policies.c.type,
            shift_policies.c.config,
        )
        .select_from(
            policy_assignments.join(
                shift_policies,
                and_(
                    shift_policies.c.id == policy_assignments.c.policy_id,
                    shift_policies.c.tenant_id == policy_assignments.c.tenant_id,
                ),
            )
        )
        .where(
            policy_assignments.c.tenant_id == scope.tenant_id,
            policy_assignments.c.scope_type == "tenant",
            _date_window_match(
                policy_assignments.c.active_from,
                policy_assignments.c.active_until,
                the_date,
            ),
        )
        .order_by(policy_assignments.c.active_from.desc())
        .limit(1)
    ).first()
    tenant_policy = policy_from_row(tenant_row) if tenant_row is not None else None

    # 4. Legacy fallback — any active shift_policies row.
    legacy = (
        active_policy_for(conn, scope, the_date=the_date)
        if tenant_policy is None
        else None
    )

    out: dict[int, ShiftPolicy] = {}
    for eid in employee_ids:
        if eid in by_employee:
            out[eid] = by_employee[eid]
            continue
        did = dept_by_employee.get(eid)
        if did is not None and did in by_department:
            out[eid] = by_department[did]
            continue
        if tenant_policy is not None:
            out[eid] = tenant_policy
            continue
        if legacy is not None:
            out[eid] = legacy
    return out


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
        leave_type_id=record.leave_type_id,
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
            "leave_type_id": stmt.excluded.leave_type_id,
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
