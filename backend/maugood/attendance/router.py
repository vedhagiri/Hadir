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

from maugood.attendance import repository as repo
from maugood.auth.dependencies import CurrentUser, current_user
from maugood.db import employees, get_engine
from maugood.employees.repository import manager_team_employee_ids
from maugood.tenants.scope import TenantScope, get_tenant_scope

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
    employee_status: str = "active"
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
    # ``pending`` = true when the row is for today's date AND the
    # employee hasn't checked in yet AND their shift end is still in
    # the future. Lets the frontend render "Waiting for login"
    # instead of "Absent" for staff who simply haven't arrived yet.
    pending: bool = False
    # Per-row context flags so the frontend can render "Weekend" /
    # "Holiday" pills instead of falling through to "Present" on
    # rows that simply weren't expected to have a check-in.
    is_weekend: bool = False
    is_holiday: bool = False
    holiday_name: Optional[str] = None


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
        employee_status=row.employee_status,
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


def _compute_pending_employee_ids(
    scope: TenantScope,
    rows: list,  # type: ignore[type-arg]
    tenant_tz,  # ZoneInfo — caller's tenant clock for "now"
) -> set[int]:
    """For today's rows, return the set of employee_ids whose shift
    end is still in the future and who haven't checked in yet (i.e.
    the row is "absent" with no in_time and no leave).

    Delegates the per-policy shift-end lookup to
    ``repository.policy_shift_end_times`` so the calendar view can
    apply the same "waiting" logic without duplicating the config
    parsing.
    """

    pending: set[int] = set()
    if not rows:
        return pending

    candidate_rows = [
        r
        for r in rows
        if r.absent and r.in_time is None and r.leave_type_id is None
    ]
    if not candidate_rows:
        return pending

    from maugood.attendance.repository import (  # noqa: PLC0415
        policy_shift_end_times,
    )

    policy_ids = sorted({int(r.policy_id) for r in candidate_rows})
    with get_engine().begin() as conn:
        shift_end_by_policy = policy_shift_end_times(
            conn, scope, policy_ids
        )

    now_local = datetime.now(timezone.utc).astimezone(tenant_tz).time()

    for r in candidate_rows:
        shift_end = shift_end_by_policy.get(int(r.policy_id))
        if shift_end is None:
            continue
        if now_local < shift_end:
            pending.add(int(r.employee_id))

    return pending


def _compute_day_context(
    scope: TenantScope,
    the_date: date_type,
    tenant_settings_snapshot,  # TenantTimeSettings — caller-loaded
) -> tuple[bool, Optional[str]]:
    """Return ``(is_weekend, holiday_name)`` for one date.

    Reads tenant_settings.weekend_days + the holidays table so the
    frontend can render "Weekend" / "Holiday" pills instead of
    falling through to "Present" on a non-working day. The
    tenant-settings snapshot is loaded once by the caller and
    threaded through so all helpers see the same values.
    """

    from sqlalchemy import select  # noqa: PLC0415

    from maugood.db import holidays as _holidays  # noqa: PLC0415

    is_weekend = False
    holiday_name: Optional[str] = None
    try:
        weekday_name = the_date.strftime("%A")
        is_weekend = weekday_name in tenant_settings_snapshot.weekend_days
        with get_engine().begin() as conn:
            row = conn.execute(
                select(_holidays.c.name).where(
                    _holidays.c.tenant_id == scope.tenant_id,
                    _holidays.c.date == the_date,
                )
            ).first()
            if row is not None and row.name:
                holiday_name = str(row.name)
    except Exception:  # noqa: BLE001
        # Defence in depth — if the lookup fails we fall back to
        # workday semantics so absentees aren't masked.
        return False, None
    return is_weekend, holiday_name


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
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    # Per-tenant timezone is the canonical clock for "today" /
    # shift-end comparisons. Load tenant_settings once at the top so
    # every helper below uses the same tz snapshot.
    with get_engine().begin() as conn:
        _tenant_settings_snapshot = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(_tenant_settings_snapshot)
    the_date = date or datetime.now(timezone.utc).astimezone(tenant_tz).date()

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
        # Manager scope = the team-rule team (My Team / Team Members
        # tab). Replaces the legacy P8 visible-set so every
        # team-scoped surface reads consistently.
        with get_engine().begin() as conn:
            visible = manager_team_employee_ids(
                conn, scope, user_email=user.email, user_id=user.id
            )
        if not visible:
            return AttendanceListOut(date=the_date, items=[])
        if department_id is not None:
            # The Admin-style department filter narrows further but
            # cannot widen past the Manager's team. The repo
            # intersects employee_ids ∩ department_ids, so a
            # department that has no team-mates simply yields zero
            # rows. We refuse a filter outside the manager's own
            # department membership to keep the UX coherent with
            # the dropdown (which only lists their depts).
            allowed_depts = set(user.departments)
            if department_id not in allowed_depts:
                raise HTTPException(
                    status_code=403, detail="not a member of this department"
                )
            department_ids = [department_id]
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

    # Decorate rows for today with the ``pending`` flag — the
    # frontend renders "Waiting for login" when the shift end hasn't
    # passed yet, otherwise the existing "Absent" pill. Both
    # helpers take the per-tenant tz so a tenant in Asia/Dubai uses
    # the right "today" / "now" for shift-end comparison.
    today_local = (
        datetime.now(timezone.utc).astimezone(tenant_tz).date()
    )
    pending_ids: set[int] = set()
    if the_date == today_local and rows:
        pending_ids = _compute_pending_employee_ids(scope, rows, tenant_tz)

    # Per-row context flags (weekend / holiday) so the frontend
    # doesn't fall through to "Present" on a non-working day.
    is_weekend, holiday_name = _compute_day_context(
        scope, the_date, _tenant_settings_snapshot
    )

    items = []
    for r in rows:
        item = _row_to_item(r)
        if r.employee_id in pending_ids:
            item.pending = True
        item.is_weekend = is_weekend
        if holiday_name is not None:
            item.is_holiday = True
            item.holiday_name = holiday_name
        items.append(item)
    return AttendanceListOut(date=the_date, items=items)


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
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    # P11: per-tenant timezone is the canonical clock for "today".
    with get_engine().begin() as conn:
        _settings = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(_settings)
    today = datetime.now(timezone.utc).astimezone(tenant_tz).date()
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
            visible = manager_team_employee_ids(
                conn, scope, user_email=user.email, user_id=user.id
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


class RegenerateEmployeeBody(BaseModel):
    """Per-employee single-day recompute. Lets a focused view (Day
    Detail drawer, Attendance drawer, My Attendance card) trigger the
    same recompute the 15-min scheduler does, but scoped to one
    (employee, date) — no full-tenant sweep, instant UI refresh.
    """

    employee_id: int
    target_date: Optional[date_type] = None


class RegenerateEmployeeOut(BaseModel):
    employee_id: int
    date: date_type
    upserted: bool  # True iff a row was upserted; False if no policy resolved


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
    from maugood.attendance import scheduler as attendance_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    # P11: tenant's own timezone drives "today" + the same-day branch.
    with get_engine().begin() as conn:
        _settings = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(_settings)
    today_local = datetime.now(timezone.utc).astimezone(tenant_tz).date()

    the_date = target_date or today_local

    if the_date == today_local:
        # Today — use the bulk helper that walks every active employee.
        rows = attendance_scheduler.recompute_today(scope)
    else:
        # Historical day — walk every active employee through the
        # single-row recompute. This is rare (operator triage) and
        # the loop is bounded by tenant size.
        from maugood.attendance import repository as attendance_repo  # noqa: PLC0415
        from maugood.db import tenant_context  # noqa: PLC0415

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


@router.post("/regenerate-employee", response_model=RegenerateEmployeeOut)
def regenerate_attendance_employee(
    body: RegenerateEmployeeBody,
    user: Annotated[CurrentUser, Depends(current_user)],
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> RegenerateEmployeeOut:
    """Recompute attendance for ONE (employee, date) synchronously.

    Authorisation:
      * Admin / HR can recompute any employee.
      * Manager can recompute any employee on their visible team
        (department membership ∪ manager_assignments).
      * Everyone else can recompute their own row only (matched on
        lower-cased email — same pattern the GET endpoints use).

    The recompute runs **inline** on the request thread, exactly like
    the 15-min scheduler tick — no background queue. By the time the
    response lands the row is upserted, so the UI can refetch and show
    the fresh numbers immediately.

    ``scope`` is taken from ``get_tenant_scope`` so ``scope.tenant_schema``
    is the request's actual tenant schema. Constructing
    ``TenantScope(tenant_id=...)`` here would silently default
    ``tenant_schema='main'`` and the downstream ``tenant_context(...)``
    wraps would route queries to the pilot schema in multi-mode.
    """

    from maugood.attendance import scheduler as attendance_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )
    from maugood.db import employees as _employees, tenant_context  # noqa: PLC0415
    from sqlalchemy import select  # noqa: PLC0415

    is_admin_hr = "Admin" in user.roles or "HR" in user.roles

    # Resolve "today" in the tenant's timezone for the default-date branch.
    with get_engine().begin() as conn:
        _settings = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(_settings)
    today_local = datetime.now(timezone.utc).astimezone(tenant_tz).date()
    the_date = body.target_date or today_local

    # Authorisation check + employee existence proof.
    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            emp_row = conn.execute(
                select(
                    _employees.c.id,
                    _employees.c.email,
                ).where(
                    _employees.c.tenant_id == scope.tenant_id,
                    _employees.c.id == body.employee_id,
                )
            ).first()
            if emp_row is None:
                raise HTTPException(status_code=404, detail="employee_not_found")

            # Self-row fast path: a user regenerating their own
            # attendance is always allowed, regardless of role-specific
            # visible-set membership. ``get_manager_visible_employee_ids``
            # excludes the Manager's own row by design (Team Members
            # shape), which would otherwise 403 a Manager opening My
            # Attendance and clicking Regenerate.
            is_self_row = (
                emp_row.email is not None
                and str(emp_row.email).lower() == user.email.lower()
            )
            if not is_admin_hr and not is_self_row:
                # Manager: must see this employee via team membership.
                if "Manager" in user.roles:
                    from maugood.manager_assignments.repository import (  # noqa: PLC0415
                        get_manager_visible_employee_ids,
                    )
                    visible = get_manager_visible_employee_ids(
                        conn, scope, manager_user_id=user.id
                    )
                    if body.employee_id not in visible:
                        raise HTTPException(status_code=403, detail="forbidden")
                else:
                    # Employee role: only their own row, matched by email.
                    # The self-row guard above already handled the happy
                    # path; this raises for the "Employee asking for
                    # someone else's row" case.
                    raise HTTPException(status_code=403, detail="forbidden")

    # Synchronous recompute — same helper the scheduler uses.
    upserted = bool(
        attendance_scheduler.recompute_for(
            scope, employee_id=body.employee_id, the_date=the_date
        )
    )
    logger.info(
        "attendance regenerate-employee by user %s — employee=%s date=%s upserted=%s",
        user.id,
        body.employee_id,
        the_date,
        upserted,
    )
    return RegenerateEmployeeOut(
        employee_id=body.employee_id,
        date=the_date,
        upserted=upserted,
    )


class RegenerateRangePerDate(BaseModel):
    date: date_type
    rows_upserted: int


class RegenerateRangeOut(BaseModel):
    start: date_type
    end: date_type
    days_processed: int
    total_rows_upserted: int
    per_date: list[RegenerateRangePerDate]


# Cap the range so a careless operator can't issue a multi-year request
# that walls the request thread. 92 days ≈ a fiscal quarter — covers
# the common "regenerate the last few months after a tz change" case.
_REGENERATE_RANGE_MAX_DAYS = 92


@router.post("/regenerate-range", response_model=RegenerateRangeOut)
def regenerate_attendance_range(
    user: Annotated[CurrentUser, Depends(current_user)],
    start: Annotated[date_type, Query(description="Inclusive start date.")],
    end: Annotated[date_type, Query(description="Inclusive end date.")],
) -> RegenerateRangeOut:
    """Recompute attendance for every date in ``[start, end]``.

    Designed for the post-timezone-change recovery flow: detection
    events stored in UTC bucket into the **new** tenant timezone,
    fixing historical in/out/total/late/short-hours/overtime values
    that were computed against the **old** day boundaries.

    Admin/HR only. Synchronous — capped at 92 days to keep request
    threads bounded. For longer ranges, split the call.
    """

    if "Admin" not in user.roles and "HR" not in user.roles:
        raise HTTPException(status_code=403, detail="forbidden")
    if start > end:
        raise HTTPException(status_code=400, detail="start must be <= end")
    span_days = (end - start).days + 1
    if span_days > _REGENERATE_RANGE_MAX_DAYS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"range too large ({span_days} days); maximum is "
                f"{_REGENERATE_RANGE_MAX_DAYS}. Split into smaller "
                f"ranges and call this endpoint multiple times."
            ),
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    from maugood.attendance import repository as attendance_repo  # noqa: PLC0415
    from maugood.attendance import scheduler as attendance_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )
    from maugood.db import tenant_context  # noqa: PLC0415

    with get_engine().begin() as conn:
        _settings = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(_settings)
    today_local = datetime.now(timezone.utc).astimezone(tenant_tz).date()

    per_date: list[RegenerateRangePerDate] = []
    total = 0
    with tenant_context(scope.tenant_schema):
        current = start
        while current <= end:
            if current == today_local:
                day_rows = attendance_scheduler.recompute_today(scope)
            else:
                day_rows = 0
                with get_engine().begin() as conn:
                    emp_ids = attendance_repo.active_employee_ids(
                        conn, scope, on_date=current
                    )
                for eid in emp_ids:
                    try:
                        if attendance_scheduler.recompute_for(
                            scope, employee_id=eid, the_date=current
                        ):
                            day_rows += 1
                    except Exception:
                        logger.exception(
                            "regenerate-range: recompute_for failed "
                            "(tenant_id=%s, employee_id=%s, date=%s) — "
                            "continuing with the rest of the range",
                            scope.tenant_id,
                            eid,
                            current,
                        )
            per_date.append(
                RegenerateRangePerDate(
                    date=current, rows_upserted=day_rows
                )
            )
            total += day_rows
            current = current + timedelta(days=1)

    logger.info(
        "attendance regenerate-range by user %s: %s → %s (%d days, %d rows)",
        user.id,
        start,
        end,
        span_days,
        total,
    )
    return RegenerateRangeOut(
        start=start,
        end=end,
        days_processed=span_days,
        total_rows_upserted=total,
        per_date=per_date,
    )
