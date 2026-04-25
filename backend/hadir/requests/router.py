"""FastAPI router for ``/api/requests/*``.

State transitions go through the pure ``state_machine`` module — the
router's job is role gating, audit, and side effects (attendance
recompute on approval; ``approved_leaves`` row for an approved leave
request).

Role scoping on GET:

* Employee — sees own.
* Manager — sees own (if they're also an employee) plus every request
  for an employee they're assigned to.
* HR — sees every request that has reached the HR stage (i.e.
  ``manager_approved`` plus any HR/Admin terminal outcome).
* Admin — sees everything.
"""

from __future__ import annotations

import logging
from datetime import date as date_type, datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import insert, select

from hadir.attendance import scheduler as attendance_scheduler_mod
from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, current_user
from hadir.db import (
    approved_leaves,
    get_engine,
    leave_types,
    manager_assignments,
)
from hadir.requests import repository as repo
from hadir.requests import state_machine as sm
from hadir.requests.schemas import (
    AdminOverrideBody,
    DecisionBody,
    RequestCreate,
    RequestEmployee,
    RequestResponse,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/requests", tags=["requests"])

USER = Depends(current_user)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_response(row: repo.RequestRow) -> RequestResponse:
    return RequestResponse(
        id=row.id,
        tenant_id=row.tenant_id,
        type=row.type,  # type: ignore[arg-type]
        employee=RequestEmployee(
            id=row.employee_id,
            employee_code=row.employee_code,
            full_name=row.employee_full_name,
        ),
        reason_category=row.reason_category,
        reason_text=row.reason_text,
        target_date_start=row.target_date_start,
        target_date_end=row.target_date_end,
        leave_type_id=row.leave_type_id,
        leave_type_code=row.leave_type_code,
        leave_type_name=row.leave_type_name,
        status=row.status,  # type: ignore[arg-type]
        manager_user_id=row.manager_user_id,
        manager_decision_at=row.manager_decision_at,
        manager_comment=row.manager_comment,
        hr_user_id=row.hr_user_id,
        hr_decision_at=row.hr_decision_at,
        hr_comment=row.hr_comment,
        admin_user_id=row.admin_user_id,
        admin_decision_at=row.admin_decision_at,
        admin_comment=row.admin_comment,
        submitted_at=row.submitted_at,
        created_at=row.created_at,
    )


def _has_role(user: CurrentUser, *role_codes: str) -> bool:
    return any(r in user.roles for r in role_codes)


def _can_view(user: CurrentUser, row: repo.RequestRow) -> bool:
    """Check role-based visibility for one request row."""

    if _has_role(user, "Admin"):
        return True
    if _has_role(user, "HR"):
        # HR sees anything that reached HR (manager_approved or beyond).
        if row.status in (
            "manager_approved",
            "hr_approved",
            "hr_rejected",
            "admin_approved",
            "admin_rejected",
        ):
            return True
    if _has_role(user, "Manager"):
        # Manager sees rows for employees they're assigned to.
        scope = TenantScope(tenant_id=user.tenant_id)
        with get_engine().begin() as conn:
            if repo.is_manager_assigned_to(
                conn,
                scope,
                manager_user_id=user.id,
                employee_id=row.employee_id,
            ):
                return True
    if _has_role(user, "Employee"):
        scope = TenantScope(tenant_id=user.tenant_id)
        with get_engine().begin() as conn:
            mine = repo.employee_for_user_email(conn, scope, email=user.email)
        if mine is not None and mine == row.employee_id:
            return True
    return False


def _apply_post_approval_side_effects(
    *, scope: TenantScope, row: repo.RequestRow, actor_user_id: int
) -> None:
    """On hr_approved or admin_approved, mirror the request into the
    attendance world: an approved leave inserts an ``approved_leaves``
    ledger row; an approved exception triggers a per-employee/per-date
    recompute pass.

    Idempotent: re-running for the same request with the same payload
    will UPSERT-style no-op (we guard against duplicate
    ``approved_leaves`` rows by checking existence first).
    """

    if row.status not in ("hr_approved", "admin_approved"):
        return

    if row.type == "leave":
        if row.leave_type_id is None:
            logger.warning(
                "request %s approved without a leave_type_id — skipping ledger row",
                row.id,
            )
            return
        end_date = row.target_date_end or row.target_date_start
        with get_engine().begin() as conn:
            # Idempotency: don't create a duplicate ledger row if a
            # previous approval already wrote one.
            existing = conn.execute(
                select(approved_leaves.c.id).where(
                    approved_leaves.c.tenant_id == scope.tenant_id,
                    approved_leaves.c.employee_id == row.employee_id,
                    approved_leaves.c.leave_type_id == row.leave_type_id,
                    approved_leaves.c.start_date == row.target_date_start,
                    approved_leaves.c.end_date == end_date,
                )
            ).first()
            if existing is None:
                conn.execute(
                    insert(approved_leaves).values(
                        tenant_id=scope.tenant_id,
                        employee_id=row.employee_id,
                        leave_type_id=row.leave_type_id,
                        start_date=row.target_date_start,
                        end_date=end_date,
                        notes=row.reason_text or None,
                        approved_by_user_id=actor_user_id,
                    )
                )

    # Recompute attendance for every covered date so reports reflect
    # the new leave / exception immediately. Past dates are explicitly
    # in scope here — that's the whole point of the request workflow.
    end_date = row.target_date_end or row.target_date_start
    current = row.target_date_start
    while current <= end_date:
        try:
            attendance_scheduler_mod.recompute_for(
                scope, employee_id=row.employee_id, the_date=current
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "request %s post-approval recompute failed for %s on %s: %s",
                row.id,
                row.employee_id,
                current,
                type(exc).__name__,
            )
        # Advance one day.
        current = date_type.fromordinal(current.toordinal() + 1)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[RequestResponse])
def list_requests(user: Annotated[CurrentUser, USER]) -> list[RequestResponse]:
    scope = TenantScope(tenant_id=user.tenant_id)
    if _has_role(user, "Admin"):
        with get_engine().begin() as conn:
            rows = repo.list_all_requests(conn, scope)
        return [_row_to_response(r) for r in rows]
    if _has_role(user, "HR"):
        with get_engine().begin() as conn:
            rows = repo.list_requests_for_hr(conn, scope)
        return [_row_to_response(r) for r in rows]
    if _has_role(user, "Manager"):
        with get_engine().begin() as conn:
            assigned = conn.execute(
                select(manager_assignments.c.employee_id).where(
                    manager_assignments.c.tenant_id == scope.tenant_id,
                    manager_assignments.c.manager_user_id == user.id,
                )
            ).all()
            employee_ids = [int(r.employee_id) for r in assigned]
            # Manager may also be an Employee — include their own row(s).
            mine = repo.employee_for_user_email(conn, scope, email=user.email)
            if mine is not None:
                employee_ids.append(mine)
            rows = repo.list_requests_for_employee_ids(
                conn, scope, employee_ids=employee_ids
            )
        return [_row_to_response(r) for r in rows]
    if _has_role(user, "Employee"):
        with get_engine().begin() as conn:
            mine = repo.employee_for_user_email(conn, scope, email=user.email)
            if mine is None:
                return []
            rows = repo.list_requests_for_employee(
                conn, scope, employee_id=mine
            )
        return [_row_to_response(r) for r in rows]
    return []


@router.get("/{request_id}", response_model=RequestResponse)
def get_request(
    request_id: int, user: Annotated[CurrentUser, USER]
) -> RequestResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="request not found")
    if not _can_view(user, row):
        raise HTTPException(status_code=403, detail="forbidden")
    return _row_to_response(row)


@router.post("", response_model=RequestResponse, status_code=status.HTTP_201_CREATED)
def create_request_endpoint(
    payload: RequestCreate, user: Annotated[CurrentUser, USER]
) -> RequestResponse:
    """Employee submits a new request.

    - The submitting employee is resolved from the session via the
      lower-cased email match — operators can't POST on behalf of
      someone else (Admin override is the audited path for that).
    - ``manager_user_id`` is auto-resolved from ``manager_assignments``
      where ``is_primary``. If the employee has no primary manager,
      the row is still created with ``manager_user_id=NULL`` — HR /
      Admin can still see it; the Manager-decide endpoint will
      403 until an assignment exists.
    """

    if not _has_role(user, "Employee"):
        # Other roles can't self-submit — they have HR / Admin paths
        # for those scenarios.
        raise HTTPException(
            status_code=403,
            detail="only Employee users can submit requests directly",
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        employee_id = repo.employee_for_user_email(conn, scope, email=user.email)
        if employee_id is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "no employee row matches the logged-in user's email — "
                    "ask Admin to attach an employee record"
                ),
            )
        # Validate leave_type belongs to this tenant if provided.
        if payload.leave_type_id is not None:
            lt = conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == scope.tenant_id,
                    leave_types.c.id == payload.leave_type_id,
                )
            ).first()
            if lt is None:
                raise HTTPException(
                    status_code=400, detail="unknown leave_type_id"
                )

        manager_user_id = repo.get_primary_manager_user_id(
            conn, scope, employee_id=employee_id
        )
        new_id = repo.create_request(
            conn,
            scope,
            employee_id=employee_id,
            type=payload.type,
            reason_category=payload.reason_category,
            reason_text=payload.reason_text,
            target_date_start=payload.target_date_start,
            target_date_end=payload.target_date_end,
            leave_type_id=payload.leave_type_id,
            manager_user_id=manager_user_id,
        )
        created = repo.get_request(conn, scope, new_id)
        assert created is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request.submitted",
            entity_type="request",
            entity_id=str(new_id),
            after={
                "type": created.type,
                "employee_id": created.employee_id,
                "reason_category": created.reason_category,
                "target_date_start": str(created.target_date_start),
                "target_date_end": (
                    str(created.target_date_end)
                    if created.target_date_end is not None
                    else None
                ),
                "manager_user_id": created.manager_user_id,
                "status": created.status,
            },
        )
    return _row_to_response(created)


@router.post("/{request_id}/cancel", response_model=RequestResponse)
def cancel_request(
    request_id: int, user: Annotated[CurrentUser, USER]
) -> RequestResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")

        # Own-only check for non-Admin.
        if not _has_role(user, "Admin"):
            mine = repo.employee_for_user_email(conn, scope, email=user.email)
            if mine is None or mine != row.employee_id:
                raise HTTPException(
                    status_code=403,
                    detail="you can only cancel your own requests",
                )

        try:
            new_status = sm.cancel(row.status)  # type: ignore[arg-type]
        except sm.InvalidTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        now = datetime.now(timezone.utc)
        repo.update_status(
            conn,
            scope,
            request_id,
            status=new_status,
            stage="cancel",
            actor_user_id=user.id,
            decision_at=now,
            comment=None,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request.cancelled",
            entity_type="request",
            entity_id=str(request_id),
            before={"status": row.status},
            after={"status": new_status},
        )
        after = repo.get_request(conn, scope, request_id)
        assert after is not None
    return _row_to_response(after)


@router.post(
    "/{request_id}/manager-decide", response_model=RequestResponse
)
def manager_decide_endpoint(
    request_id: int,
    payload: DecisionBody,
    user: Annotated[CurrentUser, USER],
) -> RequestResponse:
    if not _has_role(user, "Manager"):
        raise HTTPException(status_code=403, detail="Manager role required")

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        if not repo.is_manager_assigned_to(
            conn,
            scope,
            manager_user_id=user.id,
            employee_id=row.employee_id,
        ):
            raise HTTPException(
                status_code=403,
                detail="you are not assigned to this employee",
            )

        try:
            new_status = sm.manager_decide(
                row.status, payload.decision  # type: ignore[arg-type]
            )
        except sm.InvalidTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        now = datetime.now(timezone.utc)
        repo.update_status(
            conn,
            scope,
            request_id,
            status=new_status,
            stage="manager",
            actor_user_id=user.id,
            decision_at=now,
            comment=payload.comment or None,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=f"request.manager.{payload.decision}",
            entity_type="request",
            entity_id=str(request_id),
            before={"status": row.status},
            after={"status": new_status, "comment": payload.comment or None},
        )
        after = repo.get_request(conn, scope, request_id)
        assert after is not None
    return _row_to_response(after)


@router.post("/{request_id}/hr-decide", response_model=RequestResponse)
def hr_decide_endpoint(
    request_id: int,
    payload: DecisionBody,
    user: Annotated[CurrentUser, USER],
) -> RequestResponse:
    if not _has_role(user, "HR"):
        raise HTTPException(status_code=403, detail="HR role required")

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        try:
            new_status = sm.hr_decide(
                row.status, payload.decision  # type: ignore[arg-type]
            )
        except sm.InvalidTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        now = datetime.now(timezone.utc)
        repo.update_status(
            conn,
            scope,
            request_id,
            status=new_status,
            stage="hr",
            actor_user_id=user.id,
            decision_at=now,
            comment=payload.comment or None,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=f"request.hr.{payload.decision}",
            entity_type="request",
            entity_id=str(request_id),
            before={"status": row.status},
            after={"status": new_status, "comment": payload.comment or None},
        )
        after = repo.get_request(conn, scope, request_id)
        assert after is not None

    # Side effects run in their own transactions so the decision lands
    # even if a recompute fails (logged + skipped, never fatal).
    _apply_post_approval_side_effects(
        scope=scope, row=after, actor_user_id=user.id
    )
    return _row_to_response(after)


@router.post(
    "/{request_id}/admin-override", response_model=RequestResponse
)
def admin_override_endpoint(
    request_id: int,
    payload: AdminOverrideBody,
    user: Annotated[CurrentUser, USER],
) -> RequestResponse:
    if not _has_role(user, "Admin"):
        raise HTTPException(status_code=403, detail="Admin role required")

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        try:
            new_status = sm.admin_override(
                row.status, payload.decision  # type: ignore[arg-type]
            )
        except sm.InvalidTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        now = datetime.now(timezone.utc)
        repo.update_status(
            conn,
            scope,
            request_id,
            status=new_status,
            stage="admin",
            actor_user_id=user.id,
            decision_at=now,
            comment=payload.comment,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=f"request.admin.{payload.decision}",
            entity_type="request",
            entity_id=str(request_id),
            before={"status": row.status},
            after={"status": new_status, "comment": payload.comment},
        )
        after = repo.get_request(conn, scope, request_id)
        assert after is not None

    _apply_post_approval_side_effects(
        scope=scope, row=after, actor_user_id=user.id
    )
    return _row_to_response(after)
