"""API surface for attendance status emails.

* ``GET/PUT /api/attendance-email-config`` — the three tenant-wide
  toggles (present / late / absent). Admin-only; PUT audits with
  before/after so an operator change is reconstructible.
* ``GET /api/attendance-email-log`` — read-only delivery log for
  troubleshooting (who was emailed what, when, and why a row was
  skipped or failed). Admin + HR.

The toggles live in ``tenant_settings.attendance_email_config``; the
log is the ``attendance_email_log`` table the worker drains.
"""

from __future__ import annotations

from datetime import date as dt_date
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict

from maugood.attendance_email import repository as repo
from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    require_any_role,
    require_role,
)
from maugood.db import get_engine
from maugood.tenants.scope import TenantScope

router = APIRouter(prefix="/api", tags=["attendance-email"])

ADMIN = Depends(require_role("Admin"))
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


class AttendanceEmailConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    present: bool
    late: bool
    absent: bool


class AttendanceEmailLogItem(BaseModel):
    id: int
    employee_id: int
    employee_name: str
    employee_code: str
    date: str
    status: str
    recipient_email: Optional[str]
    subject: Optional[str]
    attempts: int
    sent_at: Optional[str]
    failed_at: Optional[str]
    skipped_at: Optional[str]
    last_error: Optional[str]
    created_at: Optional[str]


class AttendanceEmailLogOut(BaseModel):
    items: list[AttendanceEmailLogItem]
    total: int
    page: int
    page_size: int


@router.get("/attendance-email-config", response_model=AttendanceEmailConfig)
def get_attendance_email_config(
    user: Annotated[CurrentUser, ADMIN],
) -> AttendanceEmailConfig:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        return AttendanceEmailConfig.model_validate(
            repo.load_config(conn, scope)
        )


class AttendanceEmailConfigOut(AttendanceEmailConfig):
    cancelled_queue_rows: int = 0


@router.put("/attendance-email-config", response_model=AttendanceEmailConfigOut)
def put_attendance_email_config(
    payload: AttendanceEmailConfig,
    user: Annotated[CurrentUser, ADMIN],
) -> AttendanceEmailConfigOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    new_config = payload.model_dump()
    with get_engine().begin() as conn:
        before = repo.load_config(conn, scope)
        repo.save_config(conn, scope, new_config)

        # Immediately cancel pending queue rows for any status that
        # was just toggled off so no stale emails fire on the next
        # worker tick.
        disabled_now = [
            s for s in ("present", "late", "absent")
            if before.get(s) and not new_config.get(s)
        ]
        cancelled = repo.cancel_pending_for_statuses(
            conn, scope, statuses=disabled_now
        )

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="attendance_email.config.updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before=before,
            after={**new_config, "cancelled_queue_rows": cancelled},
        )
    return AttendanceEmailConfigOut.model_validate(
        {**new_config, "cancelled_queue_rows": cancelled}
    )


class SendTodayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # None / omitted → every active employee with a status on the
    # target date. A list → only those employees (the Daily
    # attendance checkboxes).
    employee_ids: Optional[list[int]] = None
    # Target date (the Daily attendance date picker). None → today in
    # the tenant's timezone. Future dates are rejected — there are no
    # attendance rows to notify about yet.
    date: Optional[dt_date] = None
    # Manual resend: when true, rows already sent/failed/skipped are
    # reset and sent again. The automatic pipeline never resends —
    # this flag exists only for the operator's explicit re-trigger.
    resend: bool = False


class SendResultItem(BaseModel):
    employee_id: int
    employee_name: str
    employee_code: str
    # present | late | absent — None when the employee has no status
    # yet (no check-in, not absent).
    status: Optional[str]
    # sent | already_sent | failed | skipped | pending | no_status |
    # toggle_off
    outcome: str
    recipient_email: Optional[str] = None
    error: Optional[str] = None


class SendTodayOut(BaseModel):
    date: str
    considered: int
    queued: int
    already_queued: int
    no_status: int
    toggle_off: int
    sent: int
    failed: int
    skipped: int
    results: list[SendResultItem]


@router.post("/attendance-email/send-today", response_model=SendTodayOut)
def send_today_attendance_emails(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    payload: Optional[SendTodayIn] = None,
) -> SendTodayOut:
    """Manual trigger from the Daily attendance page (hidden Shift+A
    button): queue an email for every targeted employee whose TODAY
    row already has a status, then drain the queue synchronously and
    report the per-employee outcome.

    Idempotent — anything already emailed today is reported as
    ``already_sent``, never re-sent. Tenant toggles are honoured;
    with all three off the call is a 400 so the operator knows to
    flip them first.
    """

    from datetime import datetime, timezone  # noqa: PLC0415

    from fastapi import HTTPException  # noqa: PLC0415

    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )
    from maugood.attendance_email.worker import (  # noqa: PLC0415
        drain_attendance_emails,
    )

    employee_ids = payload.employee_ids if payload is not None else None
    if employee_ids is not None and not employee_ids:
        raise HTTPException(
            status_code=400, detail="employee_ids must not be empty"
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        config = repo.load_config(conn, scope)
        if not any(config.values()):
            raise HTTPException(
                status_code=400,
                detail="all attendance email toggles are off — enable "
                "Present/Late/Absent in Settings → Notifications first",
            )
        settings = load_tenant_settings(conn, scope)
        today = (
            datetime.now(timezone.utc)
            .astimezone(local_tz_for(settings))
            .date()
        )
        target_date = (
            payload.date if payload is not None and payload.date else today
        )
        if target_date > today:
            raise HTTPException(
                status_code=400,
                detail="cannot send notifications for a future date",
            )
        resend = payload.resend if payload is not None else False
        counts, details = repo.enqueue_today_statuses(
            conn,
            scope,
            the_date=target_date,
            config=config,
            employee_ids=employee_ids,
            resend=resend,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="attendance_email.manual_send",
            entity_type="attendance_email_log",
            entity_id=str(target_date),
            after={
                "date": target_date.isoformat(),
                "selection": employee_ids,
                "resend": resend,
                **counts,
            },
        )

    drain = drain_attendance_emails(scope=scope)

    # Resolve each considered employee's final outcome from the log.
    with get_engine().begin() as conn:
        outcomes = repo.log_outcomes_for(
            conn,
            scope,
            the_date=target_date,
            employee_ids=[d["employee_id"] for d in details],
        )
    results: list[SendResultItem] = []
    for d in details:
        outcome = d["outcome"]
        recipient = None
        error = None
        if d["status"] is not None and outcome in ("queued", "already_queued"):
            row = outcomes.get((d["employee_id"], d["status"]))
            if row is None:
                outcome = "pending"
            elif row["sent_at"] is not None:
                outcome = "sent" if outcome == "queued" else "already_sent"
                recipient = row["recipient_email"]
            elif row["skipped_at"] is not None:
                outcome = "skipped"
                error = row["last_error"]
            elif row["failed_at"] is not None:
                outcome = "failed"
                error = row["last_error"]
            else:
                outcome = "pending"
        results.append(
            SendResultItem(
                employee_id=d["employee_id"],
                employee_name=d["employee_name"],
                employee_code=d["employee_code"],
                status=d["status"],
                outcome=outcome,
                recipient_email=recipient,
                error=error,
            )
        )

    return SendTodayOut(
        date=target_date.isoformat(),
        considered=counts["considered"],
        queued=counts["queued"],
        already_queued=counts["already_queued"],
        no_status=counts["no_status"],
        toggle_off=counts["toggle_off"],
        sent=drain["sent"],
        failed=drain["failed"],
        skipped=drain["skipped"],
        results=results,
    )


@router.get("/attendance-email/pending-count")
def get_pending_count(
    user: Annotated[CurrentUser, ADMIN],
) -> dict:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        count = repo.count_pending(conn, scope)
    return {"count": count}


@router.get("/attendance-email-log", response_model=AttendanceEmailLogOut)
def get_attendance_email_log(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    search: Optional[str] = Query(default=None),
    date_from: Optional[dt_date] = Query(default=None),
    date_to: Optional[dt_date] = Query(default=None),
) -> AttendanceEmailLogOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        items, total = repo.list_log(
            conn,
            scope,
            page=page,
            page_size=page_size,
            search=search or None,
            date_from=date_from,
            date_to=date_to,
        )
    return AttendanceEmailLogOut(
        items=[AttendanceEmailLogItem.model_validate(i) for i in items],
        total=total,
        page=page,
        page_size=page_size,
    )
