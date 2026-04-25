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
) -> AttendanceListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    from hadir.attendance.repository import local_tz  # noqa: PLC0415

    the_date = date or datetime.now(timezone.utc).astimezone(local_tz()).date()

    # Role scoping. Admin/HR see everything; Manager's view is scoped to
    # their department membership; Employee sees only themselves. Never
    # trust a path/query parameter to widen the scope.
    department_ids: Optional[list[int]] = None
    employee_filter_id: Optional[int] = None
    is_admin_like = "Admin" in user.roles or "HR" in user.roles

    if is_admin_like:
        if department_id is not None:
            department_ids = [department_id]
    elif "Manager" in user.roles:
        allowed = set(user.departments)
        if not allowed:
            return AttendanceListOut(date=the_date, items=[])
        if department_id is not None:
            if department_id not in allowed:
                raise HTTPException(
                    status_code=403, detail="not a member of this department"
                )
            department_ids = [department_id]
        else:
            department_ids = sorted(allowed)
    else:  # Employee-only
        if department_id is not None:
            raise HTTPException(
                status_code=403, detail="Employee cannot filter by department"
            )
        employee_filter_id = _employee_row_id_for(user)
        if employee_filter_id is None:
            return AttendanceListOut(date=the_date, items=[])

    with get_engine().begin() as conn:
        rows = repo.list_for_date(
            conn,
            scope,
            the_date=the_date,
            department_ids=department_ids,
            employee_id=employee_filter_id,
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
