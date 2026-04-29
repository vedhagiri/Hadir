"""Tenant-scoped user lookup — supports the P28.7 "Reports to" picker.

Returns a thin shape (id + full_name + email) for the Edit drawer's
manager dropdown. Admin/HR only — same gate as the rest of the
employees surface.

Operator-add path (POST + roles list): Admin-only. Creates a user with
an Argon2id-hashed password and the requested role assignments — the
same shape ``scripts/seed_admin.py`` uses. Surfaced from the Add
Employee drawer so an HR/Admin can grant platform access in the same
flow they use to enrol the person on the cameras.
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import insert, or_, select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role, require_role
from maugood.auth.passwords import hash_password
from maugood.db import get_engine, roles, user_roles, users
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/users", tags=["users"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
ADMIN = Depends(require_role("Admin"))


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


# ---------------------------------------------------------------------------
# Roles list (for the Add Employee drawer's role picker)
# ---------------------------------------------------------------------------


class RoleOut(BaseModel):
    id: int
    code: str
    name: str


class RoleListOut(BaseModel):
    items: list[RoleOut]


@router.get("/roles", response_model=RoleListOut)
def list_roles(user: Annotated[CurrentUser, ADMIN_OR_HR]) -> RoleListOut:
    """List the tenant's roles. Seeded per-tenant on provisioning so
    the four canonical role codes (Admin / HR / Manager / Employee)
    are always present; the response shape leaves room for tenant-
    specific roles in v1.x.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(roles.c.id, roles.c.code, roles.c.name)
            .where(roles.c.tenant_id == scope.tenant_id)
            .order_by(roles.c.id.asc())
        ).all()
    return RoleListOut(
        items=[
            RoleOut(id=int(r.id), code=str(r.code), name=str(r.name))
            for r in rows
        ]
    )


# ---------------------------------------------------------------------------
# Create user (Admin only) — creates a platform login + role assignments
# ---------------------------------------------------------------------------


# Mirrors scripts/provision_tenant.py / seed_admin.py: 12 chars min so
# we don't ship operator-set passwords below the minimum the security-
# review pass settled on. The hash itself uses the library default
# Argon2id parameters from auth/passwords.py.
_PASSWORD_MIN_LEN = 12


class UserCreateIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=_PASSWORD_MIN_LEN, max_length=256)
    role_codes: list[str] = Field(min_length=1, max_length=8)

    @field_validator("role_codes")
    @classmethod
    def _strip_dedupe_role_codes(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for code in v:
            stripped = code.strip()
            if not stripped:
                continue
            if stripped in seen:
                continue
            seen.add(stripped)
            out.append(stripped)
        if not out:
            raise ValueError("at least one role_code is required")
        return out


class UserCreateOut(BaseModel):
    id: int
    email: str
    full_name: str
    is_active: bool
    role_codes: list[str]


@router.post("", response_model=UserCreateOut, status_code=201)
def create_user(
    payload: UserCreateIn,
    user: Annotated[CurrentUser, ADMIN],
) -> UserCreateOut:
    """Create a platform user + assign roles.

    Admin-only — creating a login with role grants is sensitive. The
    plain password is hashed via Argon2id (``hash_password``) before
    persistence; it never appears in the request log, the audit row,
    or the response body. 409 on duplicate email; 422 on unknown role
    code (raised manually so the operator sees the offending field).
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    email_lower = payload.email.lower()
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == scope.tenant_id,
                users.c.email == email_lower,
            )
        ).first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"field": "email", "message": "email already exists"},
            )

        # Resolve every requested role code → row id. Reject the whole
        # request on the first unknown code rather than silently dropping
        # — the operator should know if they typed a typo.
        role_rows = conn.execute(
            select(roles.c.id, roles.c.code).where(
                roles.c.tenant_id == scope.tenant_id,
                roles.c.code.in_(payload.role_codes),
            )
        ).all()
        found_codes = {str(r.code) for r in role_rows}
        missing = [c for c in payload.role_codes if c not in found_codes]
        if missing:
            raise HTTPException(
                status_code=422,
                detail={
                    "field": "role_codes",
                    "message": f"unknown role code(s): {', '.join(missing)}",
                },
            )

        password_hash = hash_password(payload.password)
        new_id = conn.execute(
            insert(users)
            .values(
                tenant_id=scope.tenant_id,
                email=email_lower,
                password_hash=password_hash,
                full_name=payload.full_name.strip(),
                is_active=True,
            )
            .returning(users.c.id)
        ).scalar_one()

        for r in role_rows:
            conn.execute(
                insert(user_roles).values(
                    tenant_id=scope.tenant_id,
                    user_id=int(new_id),
                    role_id=int(r.id),
                )
            )

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="user.created",
            entity_type="user",
            entity_id=str(new_id),
            after={
                "email": email_lower,
                "full_name": payload.full_name.strip(),
                "role_codes": sorted(found_codes),
            },
        )

    logger.info(
        "user created: id=%s email=%s roles=%s by_admin=%s",
        new_id,
        email_lower,
        sorted(found_codes),
        user.id,
    )
    return UserCreateOut(
        id=int(new_id),
        email=email_lower,
        full_name=payload.full_name.strip(),
        is_active=True,
        role_codes=sorted(found_codes),
    )


# ---------------------------------------------------------------------------
# Lookup by email + role/password edit (for the Edit Employee drawer)
# ---------------------------------------------------------------------------


class UserDetailOut(BaseModel):
    id: int
    email: str
    full_name: str
    is_active: bool
    role_codes: list[str]


def _load_user_with_roles(conn, scope: TenantScope, user_id: int):
    user_row = conn.execute(
        select(
            users.c.id,
            users.c.email,
            users.c.full_name,
            users.c.is_active,
        ).where(
            users.c.tenant_id == scope.tenant_id, users.c.id == user_id
        )
    ).first()
    if user_row is None:
        return None
    role_rows = conn.execute(
        select(roles.c.code)
        .select_from(user_roles.join(roles, roles.c.id == user_roles.c.role_id))
        .where(
            user_roles.c.tenant_id == scope.tenant_id,
            user_roles.c.user_id == user_id,
        )
    ).all()
    return UserDetailOut(
        id=int(user_row.id),
        email=str(user_row.email),
        full_name=str(user_row.full_name),
        is_active=bool(user_row.is_active),
        role_codes=sorted(str(r.code) for r in role_rows),
    )


@router.get("/by-email/{email}", response_model=UserDetailOut)
def get_user_by_email(
    email: str, user: Annotated[CurrentUser, ADMIN_OR_HR]
) -> UserDetailOut:
    """Lookup a user by email (case-insensitive). Used by the Edit
    Employee drawer to display login state + current roles. 404 when
    the email has no linked user — the drawer renders that as
    "no platform login" with an option to create one."""

    scope = TenantScope(tenant_id=user.tenant_id)
    email_lower = email.strip().lower()
    with get_engine().begin() as conn:
        row = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == scope.tenant_id,
                users.c.email == email_lower,
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        detail = _load_user_with_roles(conn, scope, int(row.id))
    if detail is None:
        raise HTTPException(status_code=404, detail="user not found")
    return detail


class UserPatchIn(BaseModel):
    role_codes: Optional[list[str]] = None
    is_active: Optional[bool] = None

    @field_validator("role_codes")
    @classmethod
    def _normalise(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return None
        out: list[str] = []
        seen: set[str] = set()
        for code in v:
            stripped = code.strip()
            if stripped and stripped not in seen:
                seen.add(stripped)
                out.append(stripped)
        if not out:
            raise ValueError("at least one role_code is required")
        return out


@router.patch("/{user_id}", response_model=UserDetailOut)
def patch_user(
    user_id: int,
    payload: UserPatchIn,
    user: Annotated[CurrentUser, ADMIN],
) -> UserDetailOut:
    """Update a user's roles and/or active flag. Admin-only. Audits
    before/after with role_codes + is_active so the operator's role
    grants are queryable. The plain password is never touched here —
    use the password-reset endpoint."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = _load_user_with_roles(conn, scope, user_id)
        if before is None:
            raise HTTPException(status_code=404, detail="user not found")

        if payload.role_codes is not None:
            role_rows = conn.execute(
                select(roles.c.id, roles.c.code).where(
                    roles.c.tenant_id == scope.tenant_id,
                    roles.c.code.in_(payload.role_codes),
                )
            ).all()
            found_codes = {str(r.code) for r in role_rows}
            missing = [c for c in payload.role_codes if c not in found_codes]
            if missing:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "field": "role_codes",
                        "message": f"unknown role code(s): {', '.join(missing)}",
                    },
                )
            # Replace semantics: drop + re-insert.
            from sqlalchemy import delete as sql_delete  # noqa: PLC0415

            conn.execute(
                sql_delete(user_roles).where(
                    user_roles.c.tenant_id == scope.tenant_id,
                    user_roles.c.user_id == user_id,
                )
            )
            for r in role_rows:
                conn.execute(
                    insert(user_roles).values(
                        tenant_id=scope.tenant_id,
                        user_id=user_id,
                        role_id=int(r.id),
                    )
                )

        if payload.is_active is not None:
            conn.execute(
                users.update()
                .where(
                    users.c.tenant_id == scope.tenant_id,
                    users.c.id == user_id,
                )
                .values(is_active=bool(payload.is_active))
            )

        after = _load_user_with_roles(conn, scope, user_id)
        assert after is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="user.updated",
            entity_type="user",
            entity_id=str(user_id),
            before={
                "role_codes": before.role_codes,
                "is_active": before.is_active,
            },
            after={
                "role_codes": after.role_codes,
                "is_active": after.is_active,
            },
        )
    return after


class PasswordResetIn(BaseModel):
    password: str = Field(min_length=_PASSWORD_MIN_LEN, max_length=256)


@router.post("/{user_id}/password-reset", status_code=204)
def reset_password(
    user_id: int,
    payload: PasswordResetIn,
    user: Annotated[CurrentUser, ADMIN],
) -> None:
    """Admin-set password reset. Argon2id-hashes the new password,
    audits as ``user.password_reset`` (no password in the row), and
    returns 204. Self-serve change-password lives elsewhere; this is
    the operator path."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            select(users.c.email).where(
                users.c.tenant_id == scope.tenant_id, users.c.id == user_id
            )
        ).first()
        if existing is None:
            raise HTTPException(status_code=404, detail="user not found")
        password_hash = hash_password(payload.password)
        conn.execute(
            users.update()
            .where(
                users.c.tenant_id == scope.tenant_id, users.c.id == user_id
            )
            .values(password_hash=password_hash)
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="user.password_reset",
            entity_type="user",
            entity_id=str(user_id),
            after={"email": str(existing.email)},
        )
    logger.info(
        "user password reset: id=%s by_admin=%s",
        user_id,
        user.id,
    )
