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

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import delete, insert, select

from hadir.attendance import scheduler as attendance_scheduler_mod
from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, current_user, require_role
from hadir.config import get_settings
from hadir.db import (
    approved_leaves,
    get_engine,
    leave_types,
    manager_assignments,
    request_attachments,
)
from hadir.requests import attachments as attachment_io
from hadir.requests import reason_categories as cat_repo
from hadir.requests import repository as repo
from hadir.requests import state_machine as sm
from hadir.requests.schemas import (
    AdminOverrideBody,
    AttachmentConfigResponse,
    AttachmentResponse,
    DecisionBody,
    ReasonCategoryCreate,
    ReasonCategoryPatch,
    ReasonCategoryResponse,
    RequestCreate,
    RequestEmployee,
    RequestResponse,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/requests", tags=["requests"])

# Sibling router for the Admin-managed reason categories. Lives at the
# top-level ``/api/request-reason-categories`` so it doesn't sit under
# the ``/api/requests/{id}/...`` namespace.
reason_categories_router = APIRouter(
    prefix="/api/request-reason-categories", tags=["request-reason-categories"]
)

USER = Depends(current_user)
ADMIN = Depends(require_role("Admin"))


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


@router.get(
    "/attachment-config", response_model=AttachmentConfigResponse
)
def get_attachment_config(
    _user: Annotated[CurrentUser, USER],
) -> AttachmentConfigResponse:
    """Surface the upload limits to the client so it can pre-validate.

    Declared **before** the ``/{request_id}`` route so FastAPI's
    route matcher picks the static path first.
    """

    settings = get_settings()
    return AttachmentConfigResponse(
        max_mb=settings.request_attachment_max_mb,
        accepted_mime_types=sorted(attachment_io.ALLOWED_TYPES),
    )


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


# ---------------------------------------------------------------------------
# Attachments (P14)
# ---------------------------------------------------------------------------


def _attachment_can_modify(user: CurrentUser, row: repo.RequestRow) -> bool:
    """Same rule as ``cancel``: only the owning Employee (or an Admin)
    can attach files to or delete files from a request, and only while
    the request is still ``submitted``.
    """

    if not _can_view(user, row):
        return False
    if _has_role(user, "Admin"):
        return True
    if row.status != "submitted":
        return False
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        mine = repo.employee_for_user_email(conn, scope, email=user.email)
    return mine is not None and mine == row.employee_id


def _attachment_to_response(row) -> AttachmentResponse:  # type: ignore[no-untyped-def]
    return AttachmentResponse(
        id=int(row.id),
        request_id=int(row.request_id),
        original_filename=str(row.original_filename),
        content_type=str(row.content_type),
        size_bytes=int(row.size_bytes),
        uploaded_at=row.uploaded_at,
    )


@router.post(
    "/{request_id}/attachments",
    response_model=AttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    request_id: int,
    user: Annotated[CurrentUser, USER],
    file: UploadFile = File(...),
) -> AttachmentResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="request not found")
    if not _attachment_can_modify(user, row):
        raise HTTPException(
            status_code=403,
            detail=(
                "you can only attach files to your own request while it "
                "is still in submitted"
            ),
        )

    data = await file.read()
    declared = file.content_type or ""
    original = file.filename or "upload"

    try:
        stored = attachment_io.validate_and_store(
            scope=scope,
            data=data,
            declared_content_type=declared,
            original_filename=original,
        )
    except attachment_io.AttachmentError as exc:
        msg = str(exc)
        code = 413 if "max is" in msg else 400
        raise HTTPException(status_code=code, detail=msg) from exc

    with get_engine().begin() as conn:
        new_id = int(
            conn.execute(
                insert(request_attachments)
                .values(
                    request_id=request_id,
                    tenant_id=scope.tenant_id,
                    file_path=stored.file_path,
                    original_filename=original,
                    content_type=stored.detected_mime,
                    size_bytes=stored.size_bytes,
                )
                .returning(request_attachments.c.id)
            ).scalar_one()
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request.attachment.uploaded",
            entity_type="request",
            entity_id=str(request_id),
            after={
                "attachment_id": new_id,
                "original_filename": original,
                "content_type": stored.detected_mime,
                "size_bytes": stored.size_bytes,
            },
        )
        new_row = conn.execute(
            select(
                request_attachments.c.id,
                request_attachments.c.request_id,
                request_attachments.c.original_filename,
                request_attachments.c.content_type,
                request_attachments.c.size_bytes,
                request_attachments.c.uploaded_at,
            ).where(request_attachments.c.id == new_id)
        ).first()
        assert new_row is not None
    return _attachment_to_response(new_row)


@router.get(
    "/{request_id}/attachments", response_model=list[AttachmentResponse]
)
def list_attachments(
    request_id: int, user: Annotated[CurrentUser, USER]
) -> list[AttachmentResponse]:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        if not _can_view(user, row):
            raise HTTPException(status_code=403, detail="forbidden")
        rows = conn.execute(
            select(
                request_attachments.c.id,
                request_attachments.c.request_id,
                request_attachments.c.original_filename,
                request_attachments.c.content_type,
                request_attachments.c.size_bytes,
                request_attachments.c.uploaded_at,
            )
            .where(
                request_attachments.c.tenant_id == scope.tenant_id,
                request_attachments.c.request_id == request_id,
            )
            .order_by(request_attachments.c.id.asc())
        ).all()
    return [_attachment_to_response(r) for r in rows]


@router.get(
    "/{request_id}/attachments/{attachment_id}/download"
)
def download_attachment(
    request_id: int,
    attachment_id: int,
    user: Annotated[CurrentUser, USER],
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        if not _can_view(user, row):
            raise HTTPException(status_code=403, detail="forbidden")
        att = conn.execute(
            select(
                request_attachments.c.id,
                request_attachments.c.file_path,
                request_attachments.c.original_filename,
                request_attachments.c.content_type,
            ).where(
                request_attachments.c.tenant_id == scope.tenant_id,
                request_attachments.c.id == attachment_id,
                request_attachments.c.request_id == request_id,
            )
        ).first()
        if att is None:
            raise HTTPException(status_code=404, detail="attachment not found")
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request.attachment.downloaded",
            entity_type="request",
            entity_id=str(request_id),
            after={"attachment_id": int(att.id)},
        )

    try:
        plain = attachment_io.read_decrypted(str(att.file_path))
    except (FileNotFoundError, RuntimeError) as exc:
        logger.warning(
            "attachment read failed for id=%s: %s", attachment_id, exc
        )
        raise HTTPException(
            status_code=500, detail="could not read attachment"
        ) from exc

    safe_filename = (
        str(att.original_filename).replace("\r", "").replace("\n", "")
    )
    return Response(
        content=plain,
        media_type=str(att.content_type) or "application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{safe_filename}"'
            )
        },
    )


@router.delete(
    "/{request_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_attachment(
    request_id: int,
    attachment_id: int,
    user: Annotated[CurrentUser, USER],
    response: Response,
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_request(conn, scope, request_id)
        if row is None:
            raise HTTPException(status_code=404, detail="request not found")
        if not _attachment_can_modify(user, row):
            raise HTTPException(
                status_code=403,
                detail=(
                    "you can only remove attachments while the request "
                    "is still in submitted"
                ),
            )
        att = conn.execute(
            select(
                request_attachments.c.id,
                request_attachments.c.file_path,
                request_attachments.c.original_filename,
            ).where(
                request_attachments.c.tenant_id == scope.tenant_id,
                request_attachments.c.id == attachment_id,
                request_attachments.c.request_id == request_id,
            )
        ).first()
        if att is None:
            raise HTTPException(status_code=404, detail="attachment not found")
        conn.execute(
            delete(request_attachments).where(
                request_attachments.c.id == attachment_id
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request.attachment.deleted",
            entity_type="request",
            entity_id=str(request_id),
            before={
                "attachment_id": int(att.id),
                "original_filename": str(att.original_filename),
            },
        )

    attachment_io.drop_attachment_file(str(att.file_path))
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# ---------------------------------------------------------------------------
# Reason categories (P14, Admin-only writes)
# ---------------------------------------------------------------------------
# Read access is open to authenticated users — every role needs to see
# the dropdown when filing a request or rendering an existing one.

def _category_to_response(row: cat_repo.CategoryRow) -> ReasonCategoryResponse:
    return ReasonCategoryResponse(
        id=row.id,
        tenant_id=row.tenant_id,
        request_type=row.request_type,  # type: ignore[arg-type]
        code=row.code,
        name=row.name,
        display_order=row.display_order,
        active=row.active,
    )


@reason_categories_router.get(
    "", response_model=list[ReasonCategoryResponse]
)
def list_reason_categories(
    user: Annotated[CurrentUser, USER],
    request_type: Optional[str] = None,
    include_inactive: bool = False,
) -> list[ReasonCategoryResponse]:
    if request_type is not None and request_type not in ("exception", "leave"):
        raise HTTPException(
            status_code=400,
            detail="request_type must be 'exception' or 'leave'",
        )
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = cat_repo.list_categories(
            conn,
            scope,
            request_type=request_type,
            include_inactive=include_inactive,
        )
    return [_category_to_response(r) for r in rows]


@reason_categories_router.post(
    "",
    response_model=ReasonCategoryResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_reason_category(
    payload: ReasonCategoryCreate,
    user: Annotated[CurrentUser, ADMIN],
) -> ReasonCategoryResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = cat_repo.get_category_by_code(
            conn, scope, request_type=payload.request_type, code=payload.code
        )
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"reason category {payload.code!r} already exists "
                    f"for type {payload.request_type!r}"
                ),
            )
        new_id = cat_repo.create_category(
            conn,
            scope,
            request_type=payload.request_type,
            code=payload.code,
            name=payload.name,
        )
        created = cat_repo.get_category(conn, scope, new_id)
        assert created is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request_reason_category.created",
            entity_type="request_reason_category",
            entity_id=str(new_id),
            after={
                "request_type": created.request_type,
                "code": created.code,
                "name": created.name,
                "display_order": created.display_order,
            },
        )
    return _category_to_response(created)


@reason_categories_router.patch(
    "/{category_id}", response_model=ReasonCategoryResponse
)
def patch_reason_category(
    category_id: int,
    payload: ReasonCategoryPatch,
    user: Annotated[CurrentUser, ADMIN],
) -> ReasonCategoryResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)
    with get_engine().begin() as conn:
        before = cat_repo.get_category(conn, scope, category_id)
        if before is None:
            raise HTTPException(status_code=404, detail="category not found")
        cat_repo.update_category(conn, scope, category_id, values=provided)
        after = cat_repo.get_category(conn, scope, category_id)
        assert after is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request_reason_category.updated",
            entity_type="request_reason_category",
            entity_id=str(category_id),
            before={
                "name": before.name,
                "display_order": before.display_order,
                "active": before.active,
            },
            after={
                "name": after.name,
                "display_order": after.display_order,
                "active": after.active,
            },
        )
    return _category_to_response(after)


@reason_categories_router.delete(
    "/{category_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_reason_category(
    category_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = cat_repo.get_category(conn, scope, category_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="category not found")
        cat_repo.delete_category(conn, scope, category_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="request_reason_category.deleted",
            entity_type="request_reason_category",
            entity_id=str(category_id),
            before={
                "request_type": existing.request_type,
                "code": existing.code,
                "name": existing.name,
            },
        )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
