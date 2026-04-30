"""Tenant-scoped sections management (P29 #3).

Sections are the finest-grained tier of the org hierarchy: division
→ department → section. Each section belongs to exactly one
department; the same code can be reused under different departments
(``OPS/QA`` and ``ENG/QA`` are distinct rows).

Section managers (users assigned via ``user_sections``) see only
employees in that specific section. The scope helper unions
section-tier visibility with the department + division tiers, so a
manager assigned at multiple tiers gets the union, not a stacked
filter.

Read access is open to every authenticated role. Mutation is gated
to Admin or HR. Hard-delete refuses when at least one employee row
references the section.
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
    employees,
    get_engine,
    roles,
    sections,
    user_roles,
    user_sections,
    users,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sections", tags=["sections"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
AUTH = Depends(current_user)

_CODE_RE = re.compile(r"^[A-Z0-9_]{1,16}$")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SectionOut(BaseModel):
    id: int
    code: str
    name: str
    department_id: int
    department_code: str
    department_name: str
    employee_count: int


class SectionListOut(BaseModel):
    items: list[SectionOut]


class SectionCreateIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=2, max_length=120)
    department_id: int

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


class SectionPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=120)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v is not None else None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _select_sections(scope: TenantScope, department_id: Optional[int]):
    """Shared SELECT with department join + per-section employee count."""
    employee_count = (
        select(func.count(employees.c.id))
        .where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.section_id == sections.c.id,
            employees.c.status != "deleted",
        )
        .correlate(sections)
        .scalar_subquery()
    )
    stmt = (
        select(
            sections.c.id,
            sections.c.code,
            sections.c.name,
            sections.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
            employee_count.label("employee_count"),
        )
        .select_from(
            sections.join(
                departments,
                (departments.c.id == sections.c.department_id)
                & (departments.c.tenant_id == sections.c.tenant_id),
            )
        )
        .where(sections.c.tenant_id == scope.tenant_id)
        .order_by(departments.c.code.asc(), sections.c.code.asc())
    )
    if department_id is not None:
        stmt = stmt.where(sections.c.department_id == department_id)
    return stmt


@router.get("", response_model=SectionListOut)
def list_sections(
    user: Annotated[CurrentUser, AUTH],
    department_id: Annotated[Optional[int], Query()] = None,
) -> SectionListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(_select_sections(scope, department_id)).all()
    return SectionListOut(
        items=[
            SectionOut(
                id=int(r.id),
                code=str(r.code),
                name=str(r.name),
                department_id=int(r.department_id),
                department_code=str(r.department_code),
                department_name=str(r.department_name),
                employee_count=int(r.employee_count or 0),
            )
            for r in rows
        ]
    )


def _ensure_department(conn, scope: TenantScope, department_id: int) -> str:
    row = conn.execute(
        select(departments.c.code).where(
            departments.c.tenant_id == scope.tenant_id,
            departments.c.id == department_id,
        )
    ).first()
    if row is None:
        raise HTTPException(
            status_code=404, detail="department not found"
        )
    return str(row.code)


@router.post(
    "", response_model=SectionOut, status_code=status.HTTP_201_CREATED
)
def create_section(
    payload: SectionCreateIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> SectionOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        dept_code = _ensure_department(conn, scope, payload.department_id)
        existing = conn.execute(
            select(sections.c.id).where(
                sections.c.tenant_id == scope.tenant_id,
                sections.c.department_id == payload.department_id,
                sections.c.code == payload.code,
            )
        ).first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "code",
                    "message": "code already exists in this department",
                },
            )
        new_id = conn.execute(
            insert(sections)
            .values(
                tenant_id=scope.tenant_id,
                department_id=payload.department_id,
                code=payload.code,
                name=payload.name,
            )
            .returning(sections.c.id)
        ).scalar_one()
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="section.created",
            entity_type="section",
            entity_id=str(new_id),
            after={
                "code": payload.code,
                "name": payload.name,
                "department_id": payload.department_id,
                "department_code": dept_code,
            },
        )
    logger.info(
        "section created: id=%s code=%s dept=%s by_user=%s",
        new_id,
        payload.code,
        dept_code,
        user.id,
    )
    return SectionOut(
        id=int(new_id),
        code=payload.code,
        name=payload.name,
        department_id=payload.department_id,
        department_code=dept_code,
        department_name="",  # caller can refetch the list to refresh.
        employee_count=0,
    )


@router.patch("/{section_id}", response_model=SectionOut)
def patch_section(
    section_id: int,
    payload: SectionPatchIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> SectionOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            _select_sections(scope, None).where(sections.c.id == section_id)
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="section not found")
        values: dict = {}
        if payload.name is not None:
            values["name"] = payload.name
        if values:
            conn.execute(
                update(sections)
                .where(
                    sections.c.tenant_id == scope.tenant_id,
                    sections.c.id == section_id,
                )
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="section.updated",
                entity_type="section",
                entity_id=str(section_id),
                before={
                    "code": str(before.code),
                    "name": str(before.name),
                },
                after={
                    "code": str(before.code),
                    "name": values.get("name", str(before.name)),
                },
            )
        after = conn.execute(
            _select_sections(scope, None).where(sections.c.id == section_id)
        ).first()
    assert after is not None
    return SectionOut(
        id=int(after.id),
        code=str(after.code),
        name=str(after.name),
        department_id=int(after.department_id),
        department_code=str(after.department_code),
        department_name=str(after.department_name),
        employee_count=int(after.employee_count or 0),
    )


@router.delete(
    "/{section_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_section(
    section_id: int, user: Annotated[CurrentUser, ADMIN_OR_HR]
) -> None:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(sections.c.code, sections.c.name).where(
                sections.c.tenant_id == scope.tenant_id,
                sections.c.id == section_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="section not found")
        in_use = conn.execute(
            select(func.count())
            .select_from(employees)
            .where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.section_id == section_id,
                employees.c.status != "deleted",
            )
        ).scalar_one()
        if int(in_use) > 0:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "section_id",
                    "message": (
                        f"{in_use} employee(s) still reference this "
                        "section; reassign them first"
                    ),
                },
            )
        conn.execute(
            sql_delete(sections).where(
                sections.c.tenant_id == scope.tenant_id,
                sections.c.id == section_id,
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="section.deleted",
            entity_type="section",
            entity_id=str(section_id),
            before={"code": str(before.code), "name": str(before.name)},
        )


# ---------------------------------------------------------------------------
# Manager assignment (user_sections)
# ---------------------------------------------------------------------------


class SectionManagerOut(BaseModel):
    user_id: int
    full_name: str
    email: str


class SectionManagerListOut(BaseModel):
    items: list[SectionManagerOut]


class SectionManagerAddIn(BaseModel):
    user_id: int


def _ensure_section(conn, scope: TenantScope, section_id: int) -> str:
    row = conn.execute(
        select(sections.c.code).where(
            sections.c.tenant_id == scope.tenant_id,
            sections.c.id == section_id,
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="section not found")
    return str(row.code)


@router.get(
    "/{section_id}/managers", response_model=SectionManagerListOut
)
def list_section_managers(
    section_id: int, user: Annotated[CurrentUser, AUTH]
) -> SectionManagerListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        _ensure_section(conn, scope, section_id)
        rows = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email)
            .select_from(
                user_sections.join(
                    users,
                    (users.c.id == user_sections.c.user_id)
                    & (users.c.tenant_id == user_sections.c.tenant_id),
                )
            )
            .where(
                user_sections.c.tenant_id == scope.tenant_id,
                user_sections.c.section_id == section_id,
            )
            .order_by(users.c.full_name.asc())
        ).all()
    return SectionManagerListOut(
        items=[
            SectionManagerOut(
                user_id=int(r.id),
                full_name=str(r.full_name),
                email=str(r.email),
            )
            for r in rows
        ]
    )


@router.post(
    "/{section_id}/managers",
    response_model=SectionManagerOut,
    status_code=status.HTTP_201_CREATED,
)
def assign_section_manager(
    section_id: int,
    payload: SectionManagerAddIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> SectionManagerOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        sec_code = _ensure_section(conn, scope, section_id)
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
                        "to a section"
                    ),
                },
            )
        existing = conn.execute(
            select(user_sections.c.user_id).where(
                user_sections.c.tenant_id == scope.tenant_id,
                user_sections.c.user_id == payload.user_id,
                user_sections.c.section_id == section_id,
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(user_sections).values(
                    tenant_id=scope.tenant_id,
                    user_id=payload.user_id,
                    section_id=section_id,
                )
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="section.manager_assigned",
                entity_type="section",
                entity_id=str(section_id),
                after={
                    "section_code": sec_code,
                    "manager_user_id": payload.user_id,
                    "manager_email": str(target.email),
                },
            )
            logger.info(
                "section manager assigned: section=%s user=%s by=%s",
                sec_code,
                payload.user_id,
                user.id,
            )
    return SectionManagerOut(
        user_id=int(target.id),
        full_name=str(target.full_name),
        email=str(target.email),
    )


@router.delete(
    "/{section_id}/managers/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_section_manager(
    section_id: int,
    user_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> None:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        sec_code = _ensure_section(conn, scope, section_id)
        result = conn.execute(
            sql_delete(user_sections).where(
                user_sections.c.tenant_id == scope.tenant_id,
                user_sections.c.user_id == user_id,
                user_sections.c.section_id == section_id,
            )
        )
        if result.rowcount > 0:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="section.manager_removed",
                entity_type="section",
                entity_id=str(section_id),
                after={
                    "section_code": sec_code,
                    "manager_user_id": user_id,
                },
            )
            logger.info(
                "section manager removed: section=%s user=%s by=%s",
                sec_code,
                user_id,
                user.id,
            )
