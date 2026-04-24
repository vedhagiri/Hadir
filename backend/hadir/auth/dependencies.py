"""FastAPI dependencies for authenticated endpoints.

``current_user`` is the only dependency that actually talks to the
database. Everything else (``require_role``, ``require_any_role``,
``require_department``) composes on top of it and returns the same
``CurrentUser`` value so route handlers can accept a single annotated
parameter rather than juggling user + guard.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from fastapi import Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from hadir.auth.audit import write_audit
from hadir.auth.sessions import (
    SessionRow,
    delete_session,
    is_expired,
    load_session,
    touch_session,
)
from hadir.config import get_settings
from hadir.db import departments, get_engine, roles, user_departments, user_roles, users

COOKIE_NAME = "hadir_session"  # settings.session_cookie_name default — see set_cookie()


@dataclass(frozen=True, slots=True)
class CurrentUser:
    """Per-request user snapshot loaded via ``current_user``."""

    id: int
    tenant_id: int
    email: str
    full_name: str
    roles: tuple[str, ...]
    departments: tuple[int, ...]
    session_id: str


def _load_current_user_bundle(conn, *, user_id: int, tenant_id: int) -> CurrentUser | None:
    """Return the user + roles + departments, or None if inactive/missing."""

    user_row = conn.execute(
        select(
            users.c.id,
            users.c.tenant_id,
            users.c.email,
            users.c.full_name,
            users.c.is_active,
        ).where(users.c.id == user_id, users.c.tenant_id == tenant_id)
    ).first()
    if user_row is None or not user_row.is_active:
        return None

    role_codes = tuple(
        row[0]
        for row in conn.execute(
            select(roles.c.code)
            .join(user_roles, user_roles.c.role_id == roles.c.id)
            .where(
                user_roles.c.user_id == user_id,
                user_roles.c.tenant_id == tenant_id,
            )
        ).all()
    )
    department_ids = tuple(
        int(row[0])
        for row in conn.execute(
            select(departments.c.id)
            .join(user_departments, user_departments.c.department_id == departments.c.id)
            .where(
                user_departments.c.user_id == user_id,
                user_departments.c.tenant_id == tenant_id,
            )
        ).all()
    )
    return CurrentUser(
        id=int(user_row.id),
        tenant_id=int(user_row.tenant_id),
        email=str(user_row.email),
        full_name=str(user_row.full_name),
        roles=role_codes,
        departments=department_ids,
        session_id="",  # filled in by the caller
    )


def current_user(
    request: Request,
    response: Response,
    hadir_session: str | None = Cookie(default=None, alias="hadir_session"),
) -> CurrentUser:
    """Resolve the logged-in user from the session cookie.

    Performs the sliding-expiry refresh as a side-effect: a valid session's
    ``expires_at`` and the cookie ``Max-Age`` are extended on every hit.
    Raises ``401`` if the cookie is missing, unknown, expired, or points at
    an inactive/deleted user.

    Also sets ``request.state.tenant_id`` so ``hadir.tenants.scope`` picks
    it up for composed dependencies — this is how the tenant plumbing
    threads through the request chain.
    """

    if not hadir_session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required"
        )

    settings = get_settings()
    engine = get_engine()

    # Each branch ends its own transaction before raising so audit rows and
    # session cleanup commit. Raising inside ``engine.begin()`` would roll
    # them back — and the audit log is the one place we can't afford that.
    with engine.begin() as conn:
        session_row: SessionRow | None = load_session(conn, hadir_session)

    if session_row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session"
        )

    if is_expired(session_row):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=session_row.tenant_id,
                actor_user_id=session_row.user_id,
                action="auth.session.expired",
                entity_type="session",
                entity_id=session_row.id,
                after={"reason": "idle_timeout"},
            )
            delete_session(conn, session_row.id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired"
        )

    with engine.begin() as conn:
        bundle = _load_current_user_bundle(
            conn, user_id=session_row.user_id, tenant_id=session_row.tenant_id
        )
        if bundle is None:
            # User deactivated or deleted after the session was issued.
            delete_session(conn, session_row.id)

    if bundle is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="user inactive"
        )

    with engine.begin() as conn:
        touch_session(
            conn, session_row.id, idle_minutes=settings.session_idle_minutes
        )

    # Refresh the cookie's Max-Age so the browser keeps the session alive
    # alongside the DB row. Same attributes as on login; Secure still off
    # in dev (PROJECT_CONTEXT §8 — HTTPS deferred).
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_row.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )

    # Make tenant resolvable by downstream deps (hadir.tenants.scope).
    request.state.tenant_id = session_row.tenant_id

    # Rebuild with the real session_id.
    return CurrentUser(
        id=bundle.id,
        tenant_id=bundle.tenant_id,
        email=bundle.email,
        full_name=bundle.full_name,
        roles=bundle.roles,
        departments=bundle.departments,
        session_id=session_row.id,
    )


# --- Role guards ------------------------------------------------------------


def require_role(required: str) -> Callable[..., CurrentUser]:
    """Return a dependency that allows users holding ``required``."""

    def _dep(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if required not in user.roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires role {required}",
            )
        return user

    return _dep


def require_any_role(*required: str) -> Callable[..., CurrentUser]:
    """Return a dependency that allows users holding at least one role."""

    required_set = set(required)

    def _dep(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if not required_set.intersection(user.roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires one of {sorted(required_set)}",
            )
        return user

    return _dep


def require_department(
    department_id: int,
    user: CurrentUser = Depends(current_user),
) -> CurrentUser:
    """Restrict access to members of a given department.

    Admin and HR bypass the check (they see all departments per
    PROJECT_CONTEXT §3). The department id is read from the path parameter
    named ``department_id`` — the caller's route must declare it.
    """

    if "Admin" in user.roles or "HR" in user.roles:
        return user
    if department_id not in user.departments:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="not a member of this department",
        )
    return user


def _ensure_roles_are_known(codes: Iterable[str]) -> None:
    """Defensive double-check so a typo in a guard fails loudly, not silently.

    The ``roles.code`` CHECK constraint (P2) already limits what the DB
    will store, but a Python-level typo in ``require_role("Admun")`` would
    otherwise pass tests and silently deny everyone. We don't call this
    at import time (to keep the module dependency-free) — tests exercise
    it explicitly where it matters.
    """

    allowed = {"Admin", "HR", "Manager", "Employee"}
    unknown = set(codes) - allowed
    if unknown:
        raise ValueError(f"unknown role code(s): {sorted(unknown)}")
