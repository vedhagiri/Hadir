"""GET /api/attendance — role-scoped daily list.

Admin / HR → every row. Manager → rows for employees in the manager's
department assignments (multiple allowed per PROJECT_CONTEXT §3).
Employee → only their own row.
"""

from __future__ import annotations

import logging
from datetime import date as date_type, datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from hadir.attendance import repository as repo
from hadir.auth.dependencies import CurrentUser, current_user
from hadir.db import employees, get_engine
from hadir.manager_assignments.repository import (
    get_manager_visible_employee_ids,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/attendance", tags=["attendance"])


class DepartmentOut(BaseModel):
    id: int
    code: str
    name: str


class PolicyRef(BaseModel):
    id: int
    name: str


class AttendanceItem(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    department: DepartmentOut
    date: date_type
    in_time: Optional[str] = None
    out_time: Optional[str] = None
    total_minutes: Optional[int] = None
    policy: PolicyRef
    late: bool
    early_out: bool
    short_hours: bool
    absent: bool
    overtime_minutes: int
    leave_type_id: Optional[int] = None


class AttendanceListOut(BaseModel):
    date: date_type
    items: list[AttendanceItem]


def _iso(t) -> Optional[str]:  # type: ignore[no-untyped-def]
    return t.isoformat(timespec="seconds") if t is not None else None


def _row_to_item(row: repo.AttendanceRow) -> AttendanceItem:
    return AttendanceItem(
        employee_id=row.employee_id,
        employee_code=row.employee_code,
        full_name=row.full_name,
        department=DepartmentOut(
            id=row.department_id,
            code=row.department_code,
            name=row.department_name,
        ),
        date=row.date,
        in_time=_iso(row.in_time),
        out_time=_iso(row.out_time),
        total_minutes=row.total_minutes,
        policy=PolicyRef(id=row.policy_id, name=row.policy_name),
        late=row.late,
        early_out=row.early_out,
        short_hours=row.short_hours,
        absent=row.absent,
        overtime_minutes=row.overtime_minutes,
        leave_type_id=row.leave_type_id,
    )


def _employee_row_id_for(user: CurrentUser) -> Optional[int]:
    """Map the logged-in user to an ``employees.id`` by email.

    Pilot has no explicit ``user_id → employee_id`` join table (v1.0
    will add one). A sensible approximation is "the employee whose
    email matches the user's email"; returns None if no such employee
    exists — an Employee-role user without a matching row sees an empty
    list rather than a 404.
    """

    from sqlalchemy import func, select  # noqa: PLC0415

    with get_engine().begin() as conn:
        row = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == user.tenant_id,
                func.lower(employees.c.email) == (user.email or "").lower(),
            )
        ).first()
    return int(row.id) if row is not None else None


@router.get("", response_model=AttendanceListOut)
def list_attendance(
    user: Annotated[CurrentUser, Depends(current_user)],
    date: Annotated[Optional[date_type], Query(description="Local date; defaults to today.")] = None,
    department_id: Annotated[Optional[int], Query()] = None,
    employee_id: Annotated[
        Optional[int],
        Query(description="Filter to a single employee (Admin/HR/Manager)."),
    ] = None,
) -> AttendanceListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    from hadir.attendance.repository import local_tz  # noqa: PLC0415

    the_date = date or datetime.now(timezone.utc).astimezone(local_tz()).date()

    # Role scoping. Admin/HR see everything; Manager's view is the
    # **union** of (a) their department(s) and (b) employees directly
    # assigned via ``manager_assignments``; Employee sees only
    # themselves. Never trust a path/query parameter to widen the
    # scope.
    department_ids: Optional[list[int]] = None
    employee_ids: Optional[list[int]] = None
    employee_filter_id: Optional[int] = None
    is_admin_like = "Admin" in user.roles or "HR" in user.roles

    if is_admin_like:
        if department_id is not None:
            department_ids = [department_id]
    elif "Manager" in user.roles:
        with get_engine().begin() as conn:
            visible = get_manager_visible_employee_ids(
                conn, scope, manager_user_id=user.id
            )
        if not visible:
            return AttendanceListOut(date=the_date, items=[])
        if department_id is not None:
            # The Admin-style department filter narrows further but
            # cannot widen past the Manager's union. Refuse a filter
            # that lands outside any visible department membership.
            allowed_depts = set(user.departments)
            if department_id not in allowed_depts:
                raise HTTPException(
                    status_code=403, detail="not a member of this department"
                )
            department_ids = [department_id]
        # Always pass the visible-employee union — together with the
        # optional department filter, the repo intersects them.
        employee_ids = sorted(visible)
    else:  # Employee-only
        if department_id is not None:
            raise HTTPException(
                status_code=403, detail="Employee cannot filter by department"
            )
        employee_filter_id = _employee_row_id_for(user)
        if employee_filter_id is None:
            return AttendanceListOut(date=the_date, items=[])

    # Optional ``employee_id`` query narrows further (Admin/HR can pin
    # to one row; Manager can do the same as long as the employee is
    # in their visible set; Employee cannot widen past themselves).
    if employee_id is not None:
        if not is_admin_like and "Manager" in user.roles:
            if employee_ids is None or employee_id not in employee_ids:
                raise HTTPException(
                    status_code=403,
                    detail="employee not in manager scope",
                )
            employee_ids = [employee_id]
        elif is_admin_like:
            employee_filter_id = employee_id
        else:
            # Employee role: refuse to filter to a different employee.
            if employee_filter_id is not None and employee_id != employee_filter_id:
                raise HTTPException(
                    status_code=403, detail="cannot filter another employee"
                )

    with get_engine().begin() as conn:
        rows = repo.list_for_date(
            conn,
            scope,
            the_date=the_date,
            department_ids=department_ids,
            employee_id=employee_filter_id,
            employee_ids=employee_ids,
        )
    return AttendanceListOut(
        date=the_date, items=[_row_to_item(r) for r in rows]
    )


@router.get("/me/recent", response_model=AttendanceListOut)
def my_recent_attendance(
    user: Annotated[CurrentUser, Depends(current_user)],
    days: Annotated[int, Query(ge=1, le=90)] = 7,
) -> AttendanceListOut:
    """Last ``days`` days of attendance for the **current user**.

    Self-only by design — there's no employee_id parameter to widen the
    scope. The user→employee join uses lower-cased email (pilot
    convention; v1.0 will introduce an explicit join table).
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    from hadir.attendance.repository import local_tz  # noqa: PLC0415

    today = datetime.now(timezone.utc).astimezone(local_tz()).date()
    start = today - timedelta(days=days - 1)

    employee_id = _employee_row_id_for(user)
    if employee_id is None:
        return AttendanceListOut(date=today, items=[])

    with get_engine().begin() as conn:
        rows = repo.list_for_employee_range(
            conn,
            scope,
            employee_id=employee_id,
            start_date=start,
            end_date=today,
        )
    return AttendanceListOut(
        date=today, items=[_row_to_item(r) for r in rows]
    )


@router.get("/employee/{employee_id}", response_model=AttendanceListOut)
def employee_attendance_range(
    employee_id: int,
    user: Annotated[CurrentUser, Depends(current_user)],
    start: Annotated[date_type, Query(description="Inclusive start date.")],
    end: Annotated[date_type, Query(description="Inclusive end date.")],
) -> AttendanceListOut:
    """Attendance rows for one employee across a date range.

    Role gating mirrors the daily list:

    * Admin / HR can pin to any employee in the tenant.
    * Manager can pin only to employees in their visible set
      (``manager_assignments`` + ``user_departments``).
    * Employee can only pin to themselves; widening 403s.

    Returns the standard ``AttendanceListOut`` shape; ``date`` echoes
    ``end`` for downstream callers that need a single anchor.
    """

    if start > end:
        raise HTTPException(
            status_code=400, detail="start must be <= end"
        )
    if (end - start).days > 366:
        raise HTTPException(
            status_code=400, detail="range too large (max 366 days)"
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    is_admin_like = "Admin" in user.roles or "HR" in user.roles

    if is_admin_like:
        pass  # any employee in tenant
    elif "Manager" in user.roles:
        with get_engine().begin() as conn:
            visible = get_manager_visible_employee_ids(
                conn, scope, manager_user_id=user.id
            )
        if employee_id not in visible:
            raise HTTPException(
                status_code=404, detail="employee not visible"
            )
    else:  # Employee role — must match own row.
        own = _employee_row_id_for(user)
        if own is None or employee_id != own:
            raise HTTPException(
                status_code=403, detail="cannot view another employee"
            )

    with get_engine().begin() as conn:
        # Defence in depth — confirm the row is in this tenant before
        # returning; cross-tenant ids 404 instead of leaking via empty.
        from sqlalchemy import select  # noqa: PLC0415

        match = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.id == employee_id,
            )
        ).first()
        if match is None:
            raise HTTPException(status_code=404, detail="employee not found")

        rows = repo.list_for_employee_range(
            conn,
            scope,
            employee_id=employee_id,
            start_date=start,
            end_date=end,
        )
    return AttendanceListOut(
        date=end, items=[_row_to_item(r) for r in rows]
    )


class RegenerateOut(BaseModel):
    date: date_type
    rows_upserted: int


@router.post("/regenerate", response_model=RegenerateOut)
def regenerate_attendance(
    user: Annotated[CurrentUser, Depends(current_user)],
    target_date: Annotated[
        Optional[date_type], Query(alias="date")
    ] = None,
) -> RegenerateOut:
    """Recompute attendance from current detection events.

    Admin/HR only. Defaults to today in the tenant's local timezone.
    Wraps the same recompute_for_today helper the 15-minute scheduler
    uses, so a manual regenerate produces identical rows.
    """

    if "Admin" not in user.roles and "HR" not in user.roles:
        raise HTTPException(status_code=403, detail="forbidden")

    scope = TenantScope(tenant_id=user.tenant_id)
    from hadir.attendance import scheduler as attendance_scheduler  # noqa: PLC0415
    from hadir.attendance.repository import local_tz  # noqa: PLC0415

    the_date = (
        target_date
        or datetime.now(timezone.utc).astimezone(local_tz()).date()
    )

    if the_date == datetime.now(timezone.utc).astimezone(local_tz()).date():
        # Today — use the bulk helper that walks every active employee.
        rows = attendance_scheduler.recompute_today(scope)
    else:
        # Historical day — walk every active employee through the
        # single-row recompute. This is rare (operator triage) and
        # the loop is bounded by tenant size.
        from hadir.attendance import repository as attendance_repo  # noqa: PLC0415
        from hadir.db import tenant_context  # noqa: PLC0415

        rows = 0
        with tenant_context(scope.tenant_schema):
            with get_engine().begin() as conn:
                emp_ids = attendance_repo.active_employee_ids(
                    conn, scope, on_date=the_date
                )
            for eid in emp_ids:
                if attendance_scheduler.recompute_for(
                    scope, employee_id=eid, the_date=the_date
                ):
                    rows += 1
    logger.info(
        "attendance regenerate by user %s for %s — %d rows",
        user.id,
        the_date,
        rows,
    )
    return RegenerateOut(date=the_date, rows_upserted=rows)
