"""Tenant-scoped divisions management (P29 #3).

Divisions are the top tier of the org hierarchy: division →
department → section. A division contains multiple departments;
a division manager (a user assigned via ``user_divisions``) sees
every employee in every department under that division.

Read access is open to every authenticated role (the Add Employee
drawer's division picker depends on it). Mutation is gated to
Admin or HR; an HR-flipped division change still lands in the
audit trail.

Hard-delete refuses when at least one ``departments`` row references
the division. The operator must reassign the affected departments
first; this is the safer default than ON DELETE CASCADE (which
would cascade into employees + attendance + photos).

Manager assignment endpoints mirror ``departments_router``'s
``/managers`` family — symmetric semantics, different table.
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete as sql_delete, func, insert, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    current_user,
    require_any_role,
)
from maugood.db import (
    departments,
    divisions,
    get_engine,
    roles,
    user_divisions,
    user_roles,
    users,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/divisions", tags=["divisions"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
AUTH = Depends(current_user)

# Same shape as departments to keep import flows interchangeable.
_CODE_RE = re.compile(r"^[A-Z0-9_]{1,16}$")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DivisionOut(BaseModel):
    id: int
    code: str
    name: str
    department_count: int


class DivisionListOut(BaseModel):
    items: list[DivisionOut]


class DivisionCreateIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=2, max_length=120)

    @field_validator("code")
    @classmethod
    def _validate_code(cls, v: str) -> str:
        upper = v.strip().upper()
        if not _CODE_RE.match(upper):
            raise ValueError(
                "code must be 1-16 chars of A-Z, 0-9, underscore"
            )
        return upper

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return v.strip()


class DivisionPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=120)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v is not None else None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _list_with_counts(scope: TenantScope) -> list[DivisionOut]:
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                divisions.c.id,
                divisions.c.code,
                divisions.c.name,
                func.count(departments.c.id).label("department_count"),
            )
            .select_from(
                divisions.outerjoin(
                    departments,
                    (departments.c.division_id == divisions.c.id)
                    & (departments.c.tenant_id == divisions.c.tenant_id),
                )
            )
            .where(divisions.c.tenant_id == scope.tenant_id)
            .group_by(divisions.c.id, divisions.c.code, divisions.c.name)
            .order_by(divisions.c.code.asc())
        ).all()
    return [
        DivisionOut(
            id=int(r.id),
            code=str(r.code),
            name=str(r.name),
            department_count=int(r.department_count or 0),
        )
        for r in rows
    ]


@router.get("", response_model=DivisionListOut)
def list_divisions(user: Annotated[CurrentUser, AUTH]) -> DivisionListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    return DivisionListOut(items=_list_with_counts(scope))


@router.post(
    "", response_model=DivisionOut, status_code=status.HTTP_201_CREATED
)
def create_division(
    payload: DivisionCreateIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DivisionOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            select(divisions.c.id).where(
                divisions.c.tenant_id == scope.tenant_id,
                divisions.c.code == payload.code,
            )
        ).first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"field": "code", "message": "code already exists"},
            )
        new_id = conn.execute(
            insert(divisions)
            .values(
                tenant_id=scope.tenant_id,
                code=payload.code,
                name=payload.name,
            )
            .returning(divisions.c.id)
        ).scalar_one()
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="division.created",
            entity_type="division",
            entity_id=str(new_id),
            after={"code": payload.code, "name": payload.name},
        )
    logger.info(
        "division created: id=%s code=%s by_user=%s",
        new_id,
        payload.code,
        user.id,
    )
    return DivisionOut(
        id=int(new_id),
        code=payload.code,
        name=payload.name,
        department_count=0,
    )


@router.patch("/{division_id}", response_model=DivisionOut)
def patch_division(
    division_id: int,
    payload: DivisionPatchIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DivisionOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(
                divisions.c.id, divisions.c.code, divisions.c.name
            ).where(
                divisions.c.tenant_id == scope.tenant_id,
                divisions.c.id == division_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="division not found")
        values: dict = {}
        if payload.name is not None:
            values["name"] = payload.name
        if values:
            conn.execute(
                update(divisions)
                .where(
                    divisions.c.tenant_id == scope.tenant_id,
                    divisions.c.id == division_id,
                )
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="division.updated",
                entity_type="division",
                entity_id=str(division_id),
                before={"code": str(before.code), "name": str(before.name)},
                after={
                    "code": str(before.code),
                    "name": values.get("name", str(before.name)),
                },
            )
        # Re-count departments for the response shape.
        n_dept = conn.execute(
            select(func.count())
            .select_from(departments)
            .where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.division_id == division_id,
            )
        ).scalar_one()
    return DivisionOut(
        id=int(before.id),
        code=str(before.code),
        name=values.get("name", str(before.name)),
        department_count=int(n_dept or 0),
    )


@router.delete(
    "/{division_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_division(
    division_id: int, user: Annotated[CurrentUser, ADMIN_OR_HR]
) -> None:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(divisions.c.code, divisions.c.name).where(
                divisions.c.tenant_id == scope.tenant_id,
                divisions.c.id == division_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="division not found")
        in_use = conn.execute(
            select(func.count())
            .select_from(departments)
            .where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.division_id == division_id,
            )
        ).scalar_one()
        if int(in_use) > 0:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "division_id",
                    "message": (
                        f"{in_use} department(s) still belong to this "
                        "division; reassign them first"
                    ),
                },
            )
        conn.execute(
            sql_delete(divisions).where(
                divisions.c.tenant_id == scope.tenant_id,
                divisions.c.id == division_id,
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="division.deleted",
            entity_type="division",
            entity_id=str(division_id),
            before={"code": str(before.code), "name": str(before.name)},
        )


# ---------------------------------------------------------------------------
# Manager assignment (user_divisions)
# ---------------------------------------------------------------------------


class DivisionManagerOut(BaseModel):
    user_id: int
    full_name: str
    email: str


class DivisionManagerListOut(BaseModel):
    items: list[DivisionManagerOut]


class DivisionManagerAddIn(BaseModel):
    user_id: int


def _ensure_division(conn, scope: TenantScope, division_id: int) -> str:
    row = conn.execute(
        select(divisions.c.code).where(
            divisions.c.tenant_id == scope.tenant_id,
            divisions.c.id == division_id,
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="division not found")
    return str(row.code)


@router.get(
    "/{division_id}/managers", response_model=DivisionManagerListOut
)
def list_division_managers(
    division_id: int, user: Annotated[CurrentUser, AUTH]
) -> DivisionManagerListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        _ensure_division(conn, scope, division_id)
        rows = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email)
            .select_from(
                user_divisions.join(
                    users,
                    (users.c.id == user_divisions.c.user_id)
                    & (users.c.tenant_id == user_divisions.c.tenant_id),
                )
            )
            .where(
                user_divisions.c.tenant_id == scope.tenant_id,
                user_divisions.c.division_id == division_id,
            )
            .order_by(users.c.full_name.asc())
        ).all()
    return DivisionManagerListOut(
        items=[
            DivisionManagerOut(
                user_id=int(r.id),
                full_name=str(r.full_name),
                email=str(r.email),
            )
            for r in rows
        ]
    )


@router.post(
    "/{division_id}/managers",
    response_model=DivisionManagerOut,
    status_code=status.HTTP_201_CREATED,
)
def assign_division_manager(
    division_id: int,
    payload: DivisionManagerAddIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DivisionManagerOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        div_code = _ensure_division(conn, scope, division_id)
        target = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email).where(
                users.c.tenant_id == scope.tenant_id,
                users.c.id == payload.user_id,
                users.c.is_active.is_(True),
            )
        ).first()
        if target is None:
            raise HTTPException(
                status_code=404, detail="user not found or inactive"
            )
        has_manager = conn.execute(
            select(roles.c.code)
            .select_from(
                user_roles.join(roles, roles.c.id == user_roles.c.role_id)
            )
            .where(
                user_roles.c.tenant_id == scope.tenant_id,
                user_roles.c.user_id == payload.user_id,
                roles.c.code == "Manager",
            )
            .limit(1)
        ).first()
        if has_manager is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "field": "user_id",
                    "message": (
                        "user must hold the Manager role to be assigned "
                        "to a division"
                    ),
                },
            )
        existing = conn.execute(
            select(user_divisions.c.user_id).where(
                user_divisions.c.tenant_id == scope.tenant_id,
                user_divisions.c.user_id == payload.user_id,
                user_divisions.c.division_id == division_id,
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(user_divisions).values(
                    tenant_id=scope.tenant_id,
                    user_id=payload.user_id,
                    division_id=division_id,
                )
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="division.manager_assigned",
                entity_type="division",
                entity_id=str(division_id),
                after={
                    "division_code": div_code,
                    "manager_user_id": payload.user_id,
                    "manager_email": str(target.email),
                },
            )
            logger.info(
                "division manager assigned: division=%s user=%s by=%s",
                div_code,
                payload.user_id,
                user.id,
            )
    return DivisionManagerOut(
        user_id=int(target.id),
        full_name=str(target.full_name),
        email=str(target.email),
    )


@router.delete(
    "/{division_id}/managers/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_division_manager(
    division_id: int,
    user_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> None:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        div_code = _ensure_division(conn, scope, division_id)
        result = conn.execute(
            sql_delete(user_divisions).where(
                user_divisions.c.tenant_id == scope.tenant_id,
                user_divisions.c.user_id == user_id,
                user_divisions.c.division_id == division_id,
            )
        )
        if result.rowcount > 0:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="division.manager_removed",
                entity_type="division",
                entity_id=str(division_id),
                after={
                    "division_code": div_code,
                    "manager_user_id": user_id,
                },
            )
            logger.info(
                "division manager removed: division=%s user=%s by=%s",
                div_code,
                user_id,
                user.id,
            )
