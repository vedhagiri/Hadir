"""FastAPI router for ``/api/policies`` + ``/api/policy-assignments``.

Admin + HR can manage policies and assignments. Soft-delete by
setting ``active_until = today - 1`` (preserves history; the
attendance-records FK on ``shift_policies`` rejects a hard DELETE
anyway).

Audit:
* ``shift_policy.{created,updated,soft_deleted}``
* ``policy_assignment.{created,deleted}``
"""

from __future__ import annotations

import logging
from datetime import date as date_type, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import and_, delete, insert, select, update

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, require_any_role
from hadir.db import (
    departments,
    employees,
    get_engine,
    policy_assignments,
    shift_policies,
)
from hadir.policies.schemas import (
    AssignmentCreateRequest,
    AssignmentResponse,
    PolicyCreateRequest,
    PolicyPatchRequest,
    PolicyResponse,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["policies"])

# Admin + HR are both allowed; Manager / Employee are not.
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


# ---------------------------------------------------------------------------
# Policies
# ---------------------------------------------------------------------------


def _policy_to_response(row) -> PolicyResponse:  # type: ignore[no-untyped-def]
    return PolicyResponse(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        name=str(row.name),
        type=str(row.type),  # type: ignore[arg-type]
        config=dict(row.config or {}),
        active_from=row.active_from,
        active_until=row.active_until,
    )


@router.get("/api/policies", response_model=list[PolicyResponse])
def list_policies(user: Annotated[CurrentUser, ADMIN_OR_HR]) -> list[PolicyResponse]:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                shift_policies.c.id,
                shift_policies.c.tenant_id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
                shift_policies.c.active_from,
                shift_policies.c.active_until,
            )
            .where(shift_policies.c.tenant_id == scope.tenant_id)
            .order_by(shift_policies.c.id.asc())
        ).all()
    return [_policy_to_response(r) for r in rows]


@router.post(
    "/api/policies",
    response_model=PolicyResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_policy(
    payload: PolicyCreateRequest,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> PolicyResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        new_id = int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=scope.tenant_id,
                    name=payload.name,
                    type=payload.type,
                    config=payload.config.model_dump(exclude_none=True),
                    active_from=payload.active_from,
                    active_until=payload.active_until,
                )
                .returning(shift_policies.c.id)
            ).scalar_one()
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="shift_policy.created",
            entity_type="shift_policy",
            entity_id=str(new_id),
            after={
                "name": payload.name,
                "type": payload.type,
                "active_from": payload.active_from.isoformat(),
                "active_until": (
                    payload.active_until.isoformat()
                    if payload.active_until is not None
                    else None
                ),
            },
        )
        row = conn.execute(
            select(
                shift_policies.c.id,
                shift_policies.c.tenant_id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
                shift_policies.c.active_from,
                shift_policies.c.active_until,
            ).where(shift_policies.c.id == new_id)
        ).first()
    assert row is not None
    return _policy_to_response(row)


@router.patch("/api/policies/{policy_id}", response_model=PolicyResponse)
def patch_policy(
    policy_id: int,
    payload: PolicyPatchRequest,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> PolicyResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(
                shift_policies.c.id,
                shift_policies.c.tenant_id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
                shift_policies.c.active_from,
                shift_policies.c.active_until,
            ).where(
                shift_policies.c.id == policy_id,
                shift_policies.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="policy not found")

        values: dict[str, object] = {}
        if payload.name is not None:
            values["name"] = payload.name
        if payload.config is not None:
            values["config"] = payload.config.model_dump(exclude_none=True)
        if payload.active_from is not None:
            values["active_from"] = payload.active_from
        if "active_until" in payload.model_fields_set:
            values["active_until"] = payload.active_until

        if values:
            conn.execute(
                update(shift_policies)
                .where(
                    shift_policies.c.id == policy_id,
                    shift_policies.c.tenant_id == scope.tenant_id,
                )
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="shift_policy.updated",
                entity_type="shift_policy",
                entity_id=str(policy_id),
                before={
                    "name": str(before.name),
                    "active_from": before.active_from.isoformat(),
                    "active_until": (
                        before.active_until.isoformat()
                        if before.active_until is not None
                        else None
                    ),
                },
                after={
                    k: (v.isoformat() if hasattr(v, "isoformat") else v)
                    for k, v in values.items()
                },
            )
        row = conn.execute(
            select(
                shift_policies.c.id,
                shift_policies.c.tenant_id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
                shift_policies.c.active_from,
                shift_policies.c.active_until,
            ).where(shift_policies.c.id == policy_id)
        ).first()
    assert row is not None
    return _policy_to_response(row)


@router.delete(
    "/api/policies/{policy_id}", status_code=status.HTTP_204_NO_CONTENT
)
def soft_delete_policy(
    policy_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> Response:
    """Soft-delete: sets ``active_until = today - 1`` so resolution skips it.

    Hard delete is refused — ``attendance_records.policy_id`` has a
    RESTRICT FK to ``shift_policies`` so historical rows always tie
    back to their original policy. Operators rely on that for audits.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    yesterday = date_type.today() - timedelta(days=1)
    with engine.begin() as conn:
        before = conn.execute(
            select(
                shift_policies.c.active_until,
                shift_policies.c.name,
            ).where(
                shift_policies.c.id == policy_id,
                shift_policies.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="policy not found")
        conn.execute(
            update(shift_policies)
            .where(
                shift_policies.c.id == policy_id,
                shift_policies.c.tenant_id == scope.tenant_id,
            )
            .values(active_until=yesterday)
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="shift_policy.soft_deleted",
            entity_type="shift_policy",
            entity_id=str(policy_id),
            before={
                "name": str(before.name),
                "active_until": (
                    before.active_until.isoformat()
                    if before.active_until is not None
                    else None
                ),
            },
            after={"active_until": yesterday.isoformat()},
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Policy assignments
# ---------------------------------------------------------------------------


def _assignment_to_response(row) -> AssignmentResponse:  # type: ignore[no-untyped-def]
    return AssignmentResponse(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        policy_id=int(row.policy_id),
        scope_type=str(row.scope_type),  # type: ignore[arg-type]
        scope_id=int(row.scope_id) if row.scope_id is not None else None,
        active_from=row.active_from,
        active_until=row.active_until,
    )


@router.get(
    "/api/policy-assignments", response_model=list[AssignmentResponse]
)
def list_assignments(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> list[AssignmentResponse]:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                policy_assignments.c.id,
                policy_assignments.c.tenant_id,
                policy_assignments.c.policy_id,
                policy_assignments.c.scope_type,
                policy_assignments.c.scope_id,
                policy_assignments.c.active_from,
                policy_assignments.c.active_until,
            )
            .where(policy_assignments.c.tenant_id == scope.tenant_id)
            .order_by(
                policy_assignments.c.policy_id.asc(),
                policy_assignments.c.id.asc(),
            )
        ).all()
    return [_assignment_to_response(r) for r in rows]


def _validate_scope(
    conn,
    scope: TenantScope,
    *,
    scope_type: str,
    scope_id: int | None,
) -> None:
    if scope_type == "department":
        ok = conn.execute(
            select(departments.c.id).where(
                departments.c.id == scope_id,
                departments.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if ok is None:
            raise HTTPException(
                status_code=400,
                detail="scope_id is not a department in this tenant",
            )
    elif scope_type == "employee":
        ok = conn.execute(
            select(employees.c.id).where(
                employees.c.id == scope_id,
                employees.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if ok is None:
            raise HTTPException(
                status_code=400,
                detail="scope_id is not an employee in this tenant",
            )


@router.post(
    "/api/policy-assignments",
    response_model=AssignmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_assignment(
    payload: AssignmentCreateRequest,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> AssignmentResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        # Policy must exist in this tenant.
        ok = conn.execute(
            select(shift_policies.c.id).where(
                shift_policies.c.id == payload.policy_id,
                shift_policies.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if ok is None:
            raise HTTPException(
                status_code=400,
                detail="policy_id is not a policy in this tenant",
            )
        _validate_scope(
            conn,
            scope,
            scope_type=payload.scope_type,
            scope_id=payload.scope_id,
        )
        new_id = int(
            conn.execute(
                insert(policy_assignments)
                .values(
                    tenant_id=scope.tenant_id,
                    policy_id=payload.policy_id,
                    scope_type=payload.scope_type,
                    scope_id=payload.scope_id,
                    active_from=payload.active_from,
                    active_until=payload.active_until,
                )
                .returning(policy_assignments.c.id)
            ).scalar_one()
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="policy_assignment.created",
            entity_type="policy_assignment",
            entity_id=str(new_id),
            after={
                "policy_id": payload.policy_id,
                "scope_type": payload.scope_type,
                "scope_id": payload.scope_id,
                "active_from": payload.active_from.isoformat(),
                "active_until": (
                    payload.active_until.isoformat()
                    if payload.active_until is not None
                    else None
                ),
            },
        )
        row = conn.execute(
            select(
                policy_assignments.c.id,
                policy_assignments.c.tenant_id,
                policy_assignments.c.policy_id,
                policy_assignments.c.scope_type,
                policy_assignments.c.scope_id,
                policy_assignments.c.active_from,
                policy_assignments.c.active_until,
            ).where(policy_assignments.c.id == new_id)
        ).first()
    assert row is not None
    return _assignment_to_response(row)


@router.delete(
    "/api/policy-assignments/{assignment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_assignment(
    assignment_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(
                policy_assignments.c.policy_id,
                policy_assignments.c.scope_type,
                policy_assignments.c.scope_id,
            ).where(
                policy_assignments.c.id == assignment_id,
                policy_assignments.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        conn.execute(
            delete(policy_assignments).where(
                policy_assignments.c.id == assignment_id,
                policy_assignments.c.tenant_id == scope.tenant_id,
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="policy_assignment.deleted",
            entity_type="policy_assignment",
            entity_id=str(assignment_id),
            before={
                "policy_id": int(before.policy_id),
                "scope_type": str(before.scope_type),
                "scope_id": (
                    int(before.scope_id) if before.scope_id is not None else None
                ),
            },
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
