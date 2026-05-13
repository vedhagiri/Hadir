"""FastAPI router for ``/api/manager-assignments/*`` (Admin only).

Three endpoints back the drag-drop UI from the design system:

* ``GET    /api/manager-assignments`` — grouped {managers, unassigned}
* ``POST   /api/manager-assignments`` — assign or refresh primary
* ``DELETE /api/manager-assignments/{id}`` — drop an assignment

Every change emits an audit row. The partial unique index on the
table guarantees that a buggy POST trying to create two primaries
for the same employee is rejected by Postgres regardless of the
caller's logic.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import and_, select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role, require_role
from maugood.db import (
    departments,
    employees,
    get_engine,
    manager_assignments,
    roles,
    user_roles,
    users,
)
from maugood.manager_assignments import repository as repo
from maugood.manager_assignments.schemas import (
    AssignmentCreateRequest,
    AssignmentResponse,
    AssignmentsListResponse,
    EmployeeChip,
    ManagerGroup,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/manager-assignments", tags=["manager-assignments"])

ADMIN = Depends(require_role("Admin"))
# BUG-057 — HR opens this page too; read should be allowed for HR
# while mutations stay Admin-only.
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


def _to_chip(d: dict) -> EmployeeChip:
    return EmployeeChip(
        employee_id=d["employee_id"],
        employee_code=d["employee_code"],
        full_name=d["full_name"],
        department_id=d["department_id"],
        department_code=d["department_code"],
        department_name=d["department_name"],
        is_primary=d.get("is_primary", False),
        assignment_id=d.get("assignment_id"),
    )


@router.get("", response_model=AssignmentsListResponse)
def list_assignments(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> AssignmentsListResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        managers = repo.list_managers_with_employees(conn, scope)
        unassigned = repo.list_unassigned_employees(conn, scope)
    return AssignmentsListResponse(
        managers=[
            ManagerGroup(
                manager_user_id=m["manager_user_id"],
                full_name=m["full_name"],
                email=m["email"],
                department_codes=m["department_codes"],
                employees=[_to_chip(c) for c in m["employees"]],
            )
            for m in managers
        ],
        unassigned=[_to_chip(c) for c in unassigned],
    )


def _validate_manager_and_employee(
    conn,
    scope: TenantScope,
    *,
    manager_user_id: int,
    employee_id: int,
) -> None:
    # Manager must be an active user in this tenant carrying the
    # Manager role. Employee must be an active row in this tenant.
    manager_ok = conn.execute(
        select(users.c.id)
        .select_from(
            users.join(
                user_roles,
                and_(
                    user_roles.c.user_id == users.c.id,
                    user_roles.c.tenant_id == users.c.tenant_id,
                ),
            ).join(
                roles,
                and_(
                    roles.c.id == user_roles.c.role_id,
                    roles.c.tenant_id == users.c.tenant_id,
                ),
            )
        )
        .where(
            users.c.id == manager_user_id,
            users.c.tenant_id == scope.tenant_id,
            users.c.is_active.is_(True),
            roles.c.code == "Manager",
        )
        .limit(1)
    ).first()
    if manager_ok is None:
        raise HTTPException(
            status_code=400,
            detail="manager_user_id is not an active Manager in this tenant",
        )

    employee_ok = conn.execute(
        select(employees.c.id).where(
            employees.c.id == employee_id,
            employees.c.tenant_id == scope.tenant_id,
            employees.c.status == "active",
        )
    ).first()
    if employee_ok is None:
        raise HTTPException(
            status_code=400,
            detail="employee_id is not an active employee in this tenant",
        )


@router.post(
    "",
    response_model=AssignmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_assignment(
    payload: AssignmentCreateRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> AssignmentResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        _validate_manager_and_employee(
            conn,
            scope,
            manager_user_id=payload.manager_user_id,
            employee_id=payload.employee_id,
        )
        # Capture prior primary so we can audit the swap (rare but
        # informative; without this an operator reading the log can't
        # tell which row got demoted).
        prior_primary_id: int | None = None
        if payload.is_primary:
            prior = conn.execute(
                select(manager_assignments.c.id).where(
                    manager_assignments.c.tenant_id == scope.tenant_id,
                    manager_assignments.c.employee_id == payload.employee_id,
                    manager_assignments.c.is_primary.is_(True),
                )
            ).first()
            if prior is not None:
                prior_primary_id = int(prior.id)

        result = repo.set_assignment(
            conn,
            scope,
            employee_id=payload.employee_id,
            manager_user_id=payload.manager_user_id,
            is_primary=payload.is_primary,
        )

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action=(
                "manager_assignment.primary_set"
                if payload.is_primary
                else "manager_assignment.created"
            ),
            entity_type="manager_assignment",
            entity_id=str(result.id),
            after={
                "manager_user_id": result.manager_user_id,
                "employee_id": result.employee_id,
                "is_primary": result.is_primary,
                "prior_primary_assignment_id": prior_primary_id,
            },
        )
    return AssignmentResponse(
        id=result.id,
        tenant_id=result.tenant_id,
        manager_user_id=result.manager_user_id,
        employee_id=result.employee_id,
        is_primary=result.is_primary,
    )


@router.delete("/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assignment_endpoint(
    assignment_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        existing = repo.get_assignment(conn, scope, assignment_id=assignment_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="assignment not found")
        removed = repo.delete_assignment(
            conn, scope, assignment_id=assignment_id
        )
        if not removed:
            raise HTTPException(status_code=404, detail="assignment not found")
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="manager_assignment.deleted",
            entity_type="manager_assignment",
            entity_id=str(assignment_id),
            before={
                "manager_user_id": existing.manager_user_id,
                "employee_id": existing.employee_id,
                "is_primary": existing.is_primary,
            },
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
