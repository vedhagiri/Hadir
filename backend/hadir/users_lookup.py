"""Tenant-scoped user lookup — supports the P28.7 "Reports to" picker.

Returns a thin shape (id + full_name + email) for the Edit drawer's
manager dropdown. Admin/HR only — same gate as the rest of the
employees surface.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_, select

from hadir.auth.dependencies import CurrentUser, require_any_role
from hadir.db import get_engine, roles, user_roles, users
from hadir.tenants.scope import TenantScope


router = APIRouter(prefix="/api/users", tags=["users"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


class TenantUserOut(BaseModel):
    id: int
    full_name: str
    email: str
    is_active: bool


class TenantUserListOut(BaseModel):
    items: list[TenantUserOut]


@router.get("", response_model=TenantUserListOut)
def list_tenant_users(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    q: Annotated[Optional[str], Query()] = None,
    role: Annotated[Optional[str], Query()] = None,
    active_only: Annotated[bool, Query()] = True,
) -> TenantUserListOut:
    """List users in this tenant, optionally filtered by role + text search."""

    scope = TenantScope(tenant_id=user.tenant_id)
    stmt = select(
        users.c.id, users.c.full_name, users.c.email, users.c.is_active
    ).where(users.c.tenant_id == scope.tenant_id)

    if active_only:
        stmt = stmt.where(users.c.is_active.is_(True))

    if q:
        needle = f"%{q.strip().lower()}%"
        from sqlalchemy import func as sa_func  # noqa: PLC0415

        stmt = stmt.where(
            or_(
                sa_func.lower(users.c.full_name).like(needle),
                sa_func.lower(users.c.email).like(needle),
            )
        )

    if role:
        stmt = (
            stmt.select_from(
                users.join(user_roles, user_roles.c.user_id == users.c.id).join(
                    roles, roles.c.id == user_roles.c.role_id
                )
            )
            .where(roles.c.code == role)
            .distinct()
        )

    stmt = stmt.order_by(users.c.full_name.asc()).limit(200)

    with get_engine().begin() as conn:
        rows = conn.execute(stmt).all()

    return TenantUserListOut(
        items=[
            TenantUserOut(
                id=int(r.id),
                full_name=str(r.full_name),
                email=str(r.email),
                is_active=bool(r.is_active),
            )
            for r in rows
        ]
    )
