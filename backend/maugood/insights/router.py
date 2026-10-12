"""``/api/insights/*`` — read-only attendance dashboards.

Role gates + Manager scoping mirror ``POST /api/reports/attendance.pdf``
(``reporting/router.py``): Admin / HR see the whole tenant; a Manager
is limited to ``user.departments``; Employee is 403. Unlike the PDF
endpoint, an out-of-scope or unknown department / employee returns
**404** (a 403 would leak that the id exists).

Reads only — no audit rows (crop views audit themselves on
``/api/detection-events/{id}/crop``).
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from maugood.auth.dependencies import CurrentUser, current_user
from maugood.db import get_engine
from maugood.insights import service
from maugood.insights.schemas import DepartmentOut, EmployeeOut, OverviewOut, PeopleOut
from maugood.tenants.scope import TenantScope

router = APIRouter(prefix="/api/insights", tags=["insights"])

StartQ = Annotated[Optional[date], Query(description="YYYY-MM-DD; defaults to tenant-local today.")]
EndQ = Annotated[Optional[date], Query(description="YYYY-MM-DD; defaults to start (or today).")]


def _require_viewer(user: CurrentUser) -> None:
    if not ({"Admin", "HR", "Manager"} & set(user.roles)):
        raise HTTPException(status_code=403, detail="insights require Admin, HR, or Manager")


def _is_admin_like(user: CurrentUser) -> bool:
    return "Admin" in user.roles or "HR" in user.roles


def _caller_departments(user: CurrentUser) -> Optional[list[int]]:
    """None = whole tenant (Admin / HR); Manager = own departments."""

    return None if _is_admin_like(user) else sorted(set(user.departments))


def _resolve_range(
    conn, scope: TenantScope, start: Optional[date], end: Optional[date]
) -> tuple[date, date]:  # type: ignore[no-untyped-def]
    if start is None and end is None:
        start = end = service.tenant_today(conn, scope)
    elif start is None:
        start = end
    elif end is None:
        end = start
    assert start is not None and end is not None
    if end < start:
        raise HTTPException(status_code=400, detail="end must be on or after start")
    if (end - start).days + 1 > service.MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"date range exceeds {service.MAX_RANGE_DAYS} days",
        )
    return start, end


@router.get("/overview", response_model=OverviewOut)
def insights_overview(
    user: Annotated[CurrentUser, Depends(current_user)],
    start: StartQ = None,
    end: EndQ = None,
    department_id: Annotated[Optional[int], Query()] = None,
) -> dict:
    _require_viewer(user)
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        s, e = _resolve_range(conn, scope, start, end)
        department_ids: Optional[list[int]] = None
        department_label: Optional[str] = None
        if department_id is not None:
            dept = service.get_department(conn, scope, department_id)
            if dept is None or (
                not _is_admin_like(user) and department_id not in set(user.departments)
            ):
                raise HTTPException(status_code=404, detail="department not found")
            department_ids = [department_id]
            department_label = f"{dept.code} · {dept.name}"
        elif not _is_admin_like(user):
            department_ids = sorted(set(user.departments))
        return service.build_overview(
            conn,
            scope,
            start=s,
            end=e,
            department_ids=department_ids,
            department_label=department_label,
        )


@router.get("/departments/{department_id}", response_model=DepartmentOut)
def insights_department(
    department_id: int,
    user: Annotated[CurrentUser, Depends(current_user)],
    start: StartQ = None,
    end: EndQ = None,
) -> dict:
    _require_viewer(user)
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        dept = service.get_department(conn, scope, department_id)
        if dept is None or (
            not _is_admin_like(user) and department_id not in set(user.departments)
        ):
            raise HTTPException(status_code=404, detail="department not found")
        s, e = _resolve_range(conn, scope, start, end)
        return service.build_department(
            conn, scope, dept, start=s, end=e, company_department_ids=_caller_departments(user)
        )


@router.get("/employees/{employee_id}", response_model=EmployeeOut)
def insights_employee(
    employee_id: int,
    user: Annotated[CurrentUser, Depends(current_user)],
    start: StartQ = None,
    end: EndQ = None,
) -> dict:
    _require_viewer(user)
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        exists, dept_id = service.employee_department(conn, scope, employee_id)
        if not exists or (not _is_admin_like(user) and dept_id not in set(user.departments)):
            raise HTTPException(status_code=404, detail="employee not found")
        s, e = _resolve_range(conn, scope, start, end)
        out = service.build_employee(
            conn,
            scope,
            employee_id,
            start=s,
            end=e,
            company_department_ids=_caller_departments(user),
        )
        if out is None:  # pragma: no cover — raced with a delete
            raise HTTPException(status_code=404, detail="employee not found")
        return out


@router.get("/people", response_model=PeopleOut)
def insights_people(
    user: Annotated[CurrentUser, Depends(current_user)],
    start: StartQ = None,
    end: EndQ = None,
    department_id: Annotated[Optional[int], Query()] = None,
    q: Annotated[Optional[str], Query(max_length=100)] = None,
    sort: Annotated[
        Literal["attention", "name", "attendance", "punctuality", "late", "absent"], Query()
    ] = "attention",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 24,
) -> dict:
    """Per-employee summary for the people picker. Default range when
    both dates are omitted: this month to date (tenant-local)."""

    _require_viewer(user)
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        if start is None and end is None:
            start, end = service.month_to_date(conn, scope)
        s, e = _resolve_range(conn, scope, start, end)
        department_ids = _caller_departments(user)
        if department_id is not None:
            dept = service.get_department(conn, scope, department_id)
            if dept is None or (
                department_ids is not None and department_id not in set(department_ids)
            ):
                raise HTTPException(status_code=404, detail="department not found")
            department_ids = [department_id]
        return service.build_people(
            conn,
            scope,
            start=s,
            end=e,
            department_ids=department_ids,
            q=q,
            sort=sort,
            page=page,
            page_size=page_size,
        )
