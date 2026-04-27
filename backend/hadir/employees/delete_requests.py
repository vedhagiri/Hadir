"""P28.7 — Employee delete-request workflow + hard-delete.

Three actor flows feed into one terminal action:

* **Admin submits**          → row created with ``status='pending'``.
* **HR submits**             → auto-approve on insert + immediate hard-delete.
* **HR decides**             → approve/reject a pending request.
* **Admin overrides**        → another Admin can override another Admin's
  pending request (not their own) with a mandatory comment, then
  trigger hard-delete on approve.

Hard-delete is **irreversible**. It removes:

1. Every face crop file under ``/data/faces/captures/{tenant_id}/`` that
   ``detection_events`` rows pointed at for this employee.
2. Every encrypted reference photo under
   ``/data/faces/{tenant_id}/{employee_code}/`` from P6.
3. The ``employees`` row itself. Postgres ``ON DELETE CASCADE`` cleans
   up ``employee_photos``, ``custom_field_values``,
   ``manager_assignments``, ``attendance_records``, ``requests``,
   ``approved_leaves`` (employee_id FK is CASCADE),
   ``detection_events.employee_id`` is SET NULL (capture history
   stays — the row exists but is anonymised),
   ``delete_requests.employee_id`` is CASCADE (the surviving audit
   row is the one in ``audit_log``).
4. Matcher cache invalidated for the affected tenant so the next
   detection no longer hits the deleted embeddings.

The single ``audit_log`` row written with action
``employee.hard_deleted`` is the verifiable record after the row is
gone — it carries ``employee_code``, ``full_name``, ``employee_id``,
the actor (HR or override Admin), reason, and original requester.
PDPL right-to-erasure compliance.
"""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import (
    CurrentUser,
    require_any_role,
    require_role,
)
from hadir.config import get_settings
from hadir.db import (
    delete_requests as t_delete_requests,
    detection_events,
    employees as t_employees,
    employee_photos,
    get_engine,
    roles,
    user_roles,
    users,
)
from hadir.employees import repository as repo
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["employees", "delete-requests"])
# This module mounts two prefixes:
# - /api/employees/{employee_id}/delete-request[...]   — submit / decide / override / get
# - /api/delete-requests                                — top-level listing
# We use one APIRouter and decorate each route with the full path so
# the listing doesn't get shadowed by the employees router's
# ``/{employee_id}`` dynamic segment.

ADMIN = Depends(require_role("Admin"))
HR_ONLY = Depends(require_role("HR"))
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DeleteRequestSubmitIn(BaseModel):
    reason: str = Field(min_length=10, max_length=500)


class DeleteRequestDecideIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: Optional[str] = Field(default=None, max_length=500)


class DeleteRequestOverrideIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = Field(min_length=10, max_length=500)


class DeleteRequestOut(BaseModel):
    id: int
    employee_id: int
    employee_code: str
    employee_full_name: str
    requested_by: Optional[int]
    requested_by_full_name: Optional[str]
    reason: str
    status: str
    hr_decided_by: Optional[int]
    hr_decided_at: Optional[datetime]
    hr_comment: Optional[str]
    admin_override_by: Optional[int]
    admin_override_at: Optional[datetime]
    admin_override_comment: Optional[str]
    created_at: datetime


class DeleteRequestListOut(BaseModel):
    items: list[DeleteRequestOut]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _user_has_role(conn: Connection, *, user_id: int, role_code: str) -> bool:
    """``True`` if ``user_id`` holds the named role in their tenant."""

    row = conn.execute(
        select(user_roles.c.user_id)
        .select_from(
            user_roles.join(roles, roles.c.id == user_roles.c.role_id)
        )
        .where(
            user_roles.c.user_id == user_id,
            roles.c.code == role_code,
        )
    ).first()
    return row is not None


def _list_hr_user_ids(conn: Connection, scope: TenantScope) -> list[int]:
    """Every user holding the HR role in this tenant."""

    rows = conn.execute(
        select(user_roles.c.user_id)
        .select_from(
            user_roles.join(roles, roles.c.id == user_roles.c.role_id)
        )
        .where(
            user_roles.c.tenant_id == scope.tenant_id,
            roles.c.tenant_id == scope.tenant_id,
            roles.c.code == "HR",
        )
    ).all()
    return [int(r.user_id) for r in rows]


def _hydrate_request(conn: Connection, scope: TenantScope, req_id: int) -> Optional[DeleteRequestOut]:
    """Build a ``DeleteRequestOut`` joined to employee + requester."""

    requester = users.alias("requester")
    row = conn.execute(
        select(
            t_delete_requests.c.id,
            t_delete_requests.c.employee_id,
            t_employees.c.employee_code,
            t_employees.c.full_name.label("employee_full_name"),
            t_delete_requests.c.requested_by,
            requester.c.full_name.label("requested_by_full_name"),
            t_delete_requests.c.reason,
            t_delete_requests.c.status,
            t_delete_requests.c.hr_decided_by,
            t_delete_requests.c.hr_decided_at,
            t_delete_requests.c.hr_comment,
            t_delete_requests.c.admin_override_by,
            t_delete_requests.c.admin_override_at,
            t_delete_requests.c.admin_override_comment,
            t_delete_requests.c.created_at,
        )
        .select_from(
            t_delete_requests.join(
                t_employees, t_employees.c.id == t_delete_requests.c.employee_id
            ).outerjoin(requester, requester.c.id == t_delete_requests.c.requested_by)
        )
        .where(
            t_delete_requests.c.tenant_id == scope.tenant_id,
            t_delete_requests.c.id == req_id,
        )
    ).first()
    if row is None:
        return None
    return DeleteRequestOut(
        id=int(row.id),
        employee_id=int(row.employee_id),
        employee_code=str(row.employee_code),
        employee_full_name=str(row.employee_full_name),
        requested_by=int(row.requested_by) if row.requested_by is not None else None,
        requested_by_full_name=row.requested_by_full_name,
        reason=str(row.reason),
        status=str(row.status),
        hr_decided_by=int(row.hr_decided_by) if row.hr_decided_by is not None else None,
        hr_decided_at=row.hr_decided_at,
        hr_comment=row.hr_comment,
        admin_override_by=int(row.admin_override_by) if row.admin_override_by is not None else None,
        admin_override_at=row.admin_override_at,
        admin_override_comment=row.admin_override_comment,
        created_at=row.created_at,
    )


def _delete_face_files(scope: TenantScope, employee_code: str, conn: Connection, employee_id: int) -> int:
    """Drop every face-crop file referenced by detection_events for this
    employee, plus the per-employee reference-photo directory under
    ``/data/faces/{tenant_id}/{employee_code}/``.

    Returns the count of files removed (best-effort — missing files are
    skipped silently). Crop *paths* in detection_events are not cleared
    here — the row stays + the FK transitions to NULL via the SET NULL
    cascade once the employees row is dropped.
    """

    settings = get_settings()
    base = Path(settings.faces_storage_path)
    removed = 0

    # 1. Per-detection-event face crops. These live under
    #    /data/faces/captures/{tenant_id}/{camera_id}/{date}/{uuid}.jpg.
    crop_paths = conn.execute(
        select(detection_events.c.face_crop_path).where(
            detection_events.c.tenant_id == scope.tenant_id,
            detection_events.c.employee_id == employee_id,
            detection_events.c.face_crop_path.is_not(None),
        )
    ).all()
    for r in crop_paths:
        path = Path(r.face_crop_path)
        # Defence in depth — refuse to delete anything outside the
        # configured faces directory.
        try:
            path.resolve().relative_to(base.resolve())
        except ValueError:
            logger.warning(
                "refusing to delete file outside faces tree: %s", path
            )
            continue
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError as exc:
            logger.warning("could not delete crop %s: %s", path, exc)

    # 2. Reference photo directory for this employee_code (P6 layout).
    ref_dir = base / str(scope.tenant_id) / employee_code
    if ref_dir.exists() and ref_dir.is_dir():
        try:
            shutil.rmtree(ref_dir, ignore_errors=False)
            removed += 1
        except OSError as exc:
            logger.warning("could not remove ref dir %s: %s", ref_dir, exc)

    return removed


def _execute_hard_delete(
    *,
    engine: Engine,
    scope: TenantScope,
    employee_id: int,
    actor_user_id: int,
    reason: str,
    requester_user_id: Optional[int],
    via: Literal["hr_approve", "hr_self", "admin_override"],
    delete_request_id: Optional[int],
) -> None:
    """The shared hard-delete helper. Writes the surviving audit row,
    drops the on-disk crops + reference photos, runs the row delete (which
    cascades), and reloads the matcher cache.
    """

    with engine.begin() as conn:
        emp = repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")

        # Snapshot the identity so the audit row carries it after the
        # delete cascade. The audit row is the verifiable record that
        # this employee existed.
        employee_code = emp.employee_code
        full_name = emp.full_name
        email = emp.email

        # Photo file deletion happens BEFORE the row delete so the
        # employee_id query still resolves. Failures here are logged
        # but do not abort the row delete — orphan files are reclaimed
        # by future sweeps.
        files_removed = _delete_face_files(
            scope, employee_code, conn, employee_id
        )

        # Cascade-aware single DELETE. Postgres handles every per-tenant
        # FK in turn (employee_photos, custom_field_values,
        # manager_assignments, attendance_records, requests,
        # approved_leaves, ``delete_requests`` itself — all CASCADE
        # off ``employees.id``; detection_events.employee_id +
        # detection_events.former_match_employee_id are SET NULL — the
        # detection rows survive but anonymise).
        #
        # The hadir_app role has SELECT/INSERT/UPDATE on
        # ``delete_requests`` but NOT DELETE — by design, the table is
        # append-only. The cascade from ``employees`` is the only path
        # to delete a row, and Postgres is allowed to fire the cascade
        # on hadir_app's behalf because the cascade is part of the
        # employees DELETE statement, not a separate operation.
        conn.execute(
            t_employees.delete().where(
                t_employees.c.tenant_id == scope.tenant_id,
                t_employees.c.id == employee_id,
            )
        )

        # The single audit row that survives the delete.
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=actor_user_id,
            action="employee.hard_deleted",
            entity_type="employee",
            entity_id=str(employee_id),
            after={
                "employee_id": employee_id,
                "employee_code": employee_code,
                "full_name": full_name,
                "email": email,
                "reason": reason,
                "via": via,
                "delete_request_id": delete_request_id,
                "requester_user_id": requester_user_id,
                "files_removed": files_removed,
            },
        )

    # Cache reload AFTER commit so a rollback can't leave the matcher
    # mid-state. ``invalidate_employee`` only touches in-memory state;
    # safe to call on a deleted id (it just clears the entry).
    matcher_cache.invalidate_employee(employee_id)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/api/employees/{employee_id}/delete-request",
    response_model=DeleteRequestOut,
    status_code=status.HTTP_201_CREATED,
)
def submit_delete_request(
    employee_id: int,
    payload: DeleteRequestSubmitIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DeleteRequestOut:
    """Admin or HR submits a delete request.

    HR self-submit auto-approves on insert and triggers the hard-delete
    immediately. Admin submit creates a pending row and notifies HR.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    is_hr = "HR" in user.roles

    with engine.begin() as conn:
        # Cross-tenant 404 — same red line as the rest of the API.
        emp = repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")

        # 409 if a pending row already exists. The DB partial unique
        # index would also reject this; the explicit check gives a
        # clean error message.
        existing = conn.execute(
            select(t_delete_requests.c.id).where(
                t_delete_requests.c.tenant_id == scope.tenant_id,
                t_delete_requests.c.employee_id == employee_id,
                t_delete_requests.c.status == "pending",
            )
        ).first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail=f"a pending delete request already exists (id={existing.id})",
            )

        now = datetime.now(tz=timezone.utc)
        if is_hr:
            # HR self-submit → row inserted as approved + immediate delete.
            new_id = conn.execute(
                insert(t_delete_requests)
                .values(
                    tenant_id=scope.tenant_id,
                    employee_id=employee_id,
                    requested_by=user.id,
                    reason=payload.reason,
                    status="approved",
                    hr_decided_by=user.id,
                    hr_decided_at=now,
                )
                .returning(t_delete_requests.c.id)
            ).scalar_one()
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="delete_request.hr_self_approved",
                entity_type="delete_request",
                entity_id=str(new_id),
                after={
                    "employee_id": employee_id,
                    "employee_code": emp.employee_code,
                    "reason": payload.reason,
                },
            )
        else:
            # Admin submit → pending. Notify HR.
            new_id = conn.execute(
                insert(t_delete_requests)
                .values(
                    tenant_id=scope.tenant_id,
                    employee_id=employee_id,
                    requested_by=user.id,
                    reason=payload.reason,
                    status="pending",
                )
                .returning(t_delete_requests.c.id)
            ).scalar_one()
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="delete_request.submitted",
                entity_type="delete_request",
                entity_id=str(new_id),
                after={
                    "employee_id": employee_id,
                    "employee_code": emp.employee_code,
                    "reason": payload.reason,
                },
            )

    # If HR self-approved, fire the hard-delete out-of-transaction so
    # the audit insert lands first regardless of disk-IO time.
    if is_hr:
        _execute_hard_delete(
            engine=engine,
            scope=scope,
            employee_id=employee_id,
            actor_user_id=user.id,
            reason=payload.reason,
            requester_user_id=user.id,
            via="hr_self",
            delete_request_id=int(new_id),
        )

    with engine.begin() as conn:
        # After hard-delete the row's gone — return a synthetic shape so
        # the UI knows the action completed.
        if is_hr:
            return DeleteRequestOut(
                id=int(new_id),
                employee_id=employee_id,
                employee_code=emp.employee_code,
                employee_full_name=emp.full_name,
                requested_by=user.id,
                requested_by_full_name=None,
                reason=payload.reason,
                status="approved",
                hr_decided_by=user.id,
                hr_decided_at=datetime.now(tz=timezone.utc),
                hr_comment=None,
                admin_override_by=None,
                admin_override_at=None,
                admin_override_comment=None,
                created_at=datetime.now(tz=timezone.utc),
            )
        out = _hydrate_request(conn, scope, int(new_id))
    assert out is not None
    return out


@router.get(
    "/api/employees/{employee_id}/delete-request",
    response_model=Optional[DeleteRequestOut],
)
def get_pending_delete_request(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> Optional[DeleteRequestOut]:
    """Return the open (pending) delete request for the employee, or
    null if none. Used by the Edit drawer to show the yellow banner."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        emp = repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")
        row = conn.execute(
            select(t_delete_requests.c.id).where(
                t_delete_requests.c.tenant_id == scope.tenant_id,
                t_delete_requests.c.employee_id == employee_id,
                t_delete_requests.c.status == "pending",
            )
        ).first()
        if row is None:
            return None
        return _hydrate_request(conn, scope, int(row.id))


@router.get("/api/delete-requests", response_model=DeleteRequestListOut)
def list_delete_requests(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DeleteRequestListOut:
    """Pending delete requests in this tenant. Approvals page consumes this."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(t_delete_requests.c.id)
            .where(
                t_delete_requests.c.tenant_id == scope.tenant_id,
                t_delete_requests.c.status == "pending",
            )
            .order_by(t_delete_requests.c.created_at.desc())
        ).all()
        items: list[DeleteRequestOut] = []
        for r in rows:
            hyd = _hydrate_request(conn, scope, int(r.id))
            if hyd is not None:
                items.append(hyd)
    return DeleteRequestListOut(items=items)


@router.post(
    "/api/employees/{employee_id}/delete-request/{req_id}/decide",
    response_model=DeleteRequestOut,
)
def hr_decide_delete_request(
    employee_id: int,
    req_id: int,
    payload: DeleteRequestDecideIn,
    user: Annotated[CurrentUser, HR_ONLY],
) -> DeleteRequestOut:
    """HR approves or rejects a pending delete request."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    now = datetime.now(tz=timezone.utc)

    if payload.decision == "reject":
        comment = (payload.comment or "").strip()
        if len(comment) < 5:
            raise HTTPException(
                status_code=400,
                detail="comment is required (min 5 chars) when rejecting",
            )

    with engine.begin() as conn:
        # Cross-tenant 404 by tenant filter.
        row = conn.execute(
            select(
                t_delete_requests.c.id,
                t_delete_requests.c.status,
                t_delete_requests.c.employee_id,
                t_delete_requests.c.requested_by,
                t_delete_requests.c.reason,
            ).where(
                t_delete_requests.c.tenant_id == scope.tenant_id,
                t_delete_requests.c.id == req_id,
                t_delete_requests.c.employee_id == employee_id,
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="delete request not found")
        if row.status != "pending":
            raise HTTPException(
                status_code=409,
                detail=f"delete request is in status '{row.status}', cannot decide",
            )

        if payload.decision == "approve":
            conn.execute(
                update(t_delete_requests)
                .where(t_delete_requests.c.id == req_id)
                .values(
                    status="approved",
                    hr_decided_by=user.id,
                    hr_decided_at=now,
                    hr_comment=payload.comment,
                )
            )
            audit_action = "delete_request.approved"
        else:
            conn.execute(
                update(t_delete_requests)
                .where(t_delete_requests.c.id == req_id)
                .values(
                    status="rejected",
                    hr_decided_by=user.id,
                    hr_decided_at=now,
                    hr_comment=payload.comment,
                )
            )
            audit_action = "delete_request.rejected"

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=audit_action,
            entity_type="delete_request",
            entity_id=str(req_id),
            after={
                "employee_id": employee_id,
                "comment": payload.comment,
            },
        )

    if payload.decision == "approve":
        _execute_hard_delete(
            engine=engine,
            scope=scope,
            employee_id=employee_id,
            actor_user_id=user.id,
            reason=str(row.reason),
            requester_user_id=int(row.requested_by) if row.requested_by else None,
            via="hr_approve",
            delete_request_id=req_id,
        )
        # Synthetic post-delete shape — same as the HR self-submit path.
        return DeleteRequestOut(
            id=req_id,
            employee_id=employee_id,
            employee_code="",  # row's gone; UI can ignore.
            employee_full_name="",
            requested_by=int(row.requested_by) if row.requested_by else None,
            requested_by_full_name=None,
            reason=str(row.reason),
            status="approved",
            hr_decided_by=user.id,
            hr_decided_at=now,
            hr_comment=payload.comment,
            admin_override_by=None,
            admin_override_at=None,
            admin_override_comment=None,
            created_at=now,
        )

    with engine.begin() as conn:
        out = _hydrate_request(conn, scope, req_id)
    assert out is not None
    return out


@router.post(
    "/api/employees/{employee_id}/delete-request/{req_id}/admin-override",
    response_model=DeleteRequestOut,
)
def admin_override_delete_request(
    employee_id: int,
    req_id: int,
    payload: DeleteRequestOverrideIn,
    user: Annotated[CurrentUser, ADMIN],
) -> DeleteRequestOut:
    """Another Admin (not the original requester) overrides + decides.

    Mandatory 10-char comment enforced server-side. Self-override is
    rejected — the override exists for cases where one Admin needs to
    act on another's pending request, not for self-approval.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    now = datetime.now(tz=timezone.utc)

    with engine.begin() as conn:
        row = conn.execute(
            select(
                t_delete_requests.c.id,
                t_delete_requests.c.status,
                t_delete_requests.c.requested_by,
                t_delete_requests.c.reason,
                t_delete_requests.c.employee_id,
            ).where(
                t_delete_requests.c.tenant_id == scope.tenant_id,
                t_delete_requests.c.id == req_id,
                t_delete_requests.c.employee_id == employee_id,
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="delete request not found")
        if row.status != "pending":
            raise HTTPException(
                status_code=409,
                detail=f"delete request is in status '{row.status}', cannot override",
            )
        if row.requested_by is not None and int(row.requested_by) == user.id:
            raise HTTPException(
                status_code=403,
                detail="cannot override your own delete request",
            )

        conn.execute(
            update(t_delete_requests)
            .where(t_delete_requests.c.id == req_id)
            .values(
                status="admin_override",
                admin_override_by=user.id,
                admin_override_at=now,
                admin_override_comment=payload.comment,
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=(
                "delete_request.admin_override_approve"
                if payload.decision == "approve"
                else "delete_request.admin_override_reject"
            ),
            entity_type="delete_request",
            entity_id=str(req_id),
            after={
                "employee_id": employee_id,
                "previous_requester": int(row.requested_by) if row.requested_by else None,
                "comment": payload.comment,
                "decision": payload.decision,
            },
        )

    if payload.decision == "approve":
        _execute_hard_delete(
            engine=engine,
            scope=scope,
            employee_id=employee_id,
            actor_user_id=user.id,
            reason=str(row.reason),
            requester_user_id=int(row.requested_by) if row.requested_by else None,
            via="admin_override",
            delete_request_id=req_id,
        )
        return DeleteRequestOut(
            id=req_id,
            employee_id=employee_id,
            employee_code="",
            employee_full_name="",
            requested_by=int(row.requested_by) if row.requested_by else None,
            requested_by_full_name=None,
            reason=str(row.reason),
            status="admin_override",
            hr_decided_by=None,
            hr_decided_at=None,
            hr_comment=None,
            admin_override_by=user.id,
            admin_override_at=now,
            admin_override_comment=payload.comment,
            created_at=now,
        )

    with engine.begin() as conn:
        out = _hydrate_request(conn, scope, req_id)
    assert out is not None
    return out
