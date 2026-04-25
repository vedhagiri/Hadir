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
    """Per-request user snapshot loaded via ``current_user``.

    P7: ``roles`` carries ONLY the active role for this request — the
    one the user picked via the role switcher (or their highest role
    at login). ``available_roles`` carries the full set the user
    actually holds. Existing role guards (``require_role`` etc.) check
    membership in ``roles`` and therefore re-evaluate against the
    ACTIVE role per request, not against everything the user could
    ever do. Backend authorisation never trusts the frontend's idea
    of which role is active.
    """

    id: int
    tenant_id: int
    email: str
    full_name: str
    roles: tuple[str, ...]
    available_roles: tuple[str, ...]
    active_role: str
    departments: tuple[int, ...]
    session_id: str
    # P21: explicit per-user UI language. ``None`` means
    # "follow Accept-Language" — the i18n resolver consumes this.
    preferred_language: str | None = None
    # P22: theme + density. ``None`` on theme = "follow system";
    # ``None`` on density = "comfortable" (design default). The
    # frontend ThemeProvider applies both at sign-in.
    preferred_theme: str | None = None
    preferred_density: str | None = None


# Highest-first ranking. Used at login + on a no-stored-active-role
# fallback to pick a sensible default.
_ROLE_PRIORITY: dict[str, int] = {
    "Admin": 4,
    "HR": 3,
    "Manager": 2,
    "Employee": 1,
}


def primary_role(roles: Iterable[str]) -> str:
    """Return the highest-ranked role from ``roles``.

    Falls back to ``Employee`` for the (edge) case of an empty role
    set; the API surface elsewhere keeps users with no roles out of
    every guarded route.
    """

    best = "Employee"
    best_rank = 0
    for role in roles:
        rank = _ROLE_PRIORITY.get(role, 0)
        if rank > best_rank:
            best = role
            best_rank = rank
    return best


def _load_current_user_bundle(conn, *, user_id: int, tenant_id: int) -> CurrentUser | None:
    """Return the user + roles + departments, or None if inactive/missing."""

    user_row = conn.execute(
        select(
            users.c.id,
            users.c.tenant_id,
            users.c.email,
            users.c.full_name,
            users.c.is_active,
            users.c.preferred_language,
            users.c.preferred_theme,
            users.c.preferred_density,
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
    # ``roles`` here is the FULL set; the caller (``current_user``)
    # narrows it to the active role before returning.
    return CurrentUser(
        id=int(user_row.id),
        tenant_id=int(user_row.tenant_id),
        email=str(user_row.email),
        full_name=str(user_row.full_name),
        roles=role_codes,
        available_roles=role_codes,
        active_role=primary_role(role_codes),
        departments=department_ids,
        session_id="",  # filled in by the caller
        preferred_language=(
            str(user_row.preferred_language)
            if user_row.preferred_language is not None
            else None
        ),
        preferred_theme=(
            str(user_row.preferred_theme)
            if user_row.preferred_theme is not None
            else None
        ),
        preferred_density=(
            str(user_row.preferred_density)
            if user_row.preferred_density is not None
            else None
        ),
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

    P3: when a Super-Admin is impersonating a tenant, the tenant cookie
    won't exist (the operator is logged in via ``hadir_super_session``),
    but the middleware has already populated ``request.state`` with
    ``is_super_admin``, ``super_admin_user_id``, and ``tenant_id``. We
    return a synthetic ``CurrentUser`` with all four roles so existing
    role guards permit the request. Every audit row written under this
    user threads ``actor_user_id=None`` and is dual-logged via
    ``hadir.super_admin.audit.write_audit_dual`` (the per-tenant
    handlers detect impersonation on ``request.state``).
    """

    if not hadir_session:
        # Super-Admin impersonation path: the middleware already
        # resolved a tenant schema for this request and flagged
        # is_super_admin. Construct a synthetic operator-user so the
        # existing role guards pass.
        if (
            getattr(request.state, "is_super_admin", False)
            and getattr(request.state, "tenant_id", None) is not None
        ):
            # P7: synthetic operator acts as Admin. Listing every role
            # in ``available_roles`` keeps the topbar dropdown happy
            # even though the switch endpoint refuses for the
            # synthetic (no real session row to update).
            return CurrentUser(
                id=0,  # not a real users.id; persisted audit rows use actor_user_id=None
                tenant_id=int(request.state.tenant_id),
                email=f"super-admin#{getattr(request.state, 'super_admin_user_id', 0)}",
                full_name="Super-Admin (impersonating)",
                roles=("Admin",),
                available_roles=("Admin", "HR", "Manager", "Employee"),
                active_role="Admin",
                departments=tuple(),
                session_id=str(getattr(request.state, "super_admin_session_id", "")),
            )
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

    # P7: pick the effective active role. Stored claim wins as long as
    # the user still actually holds it; otherwise fall back to their
    # highest role. ``current_user.roles`` is then narrowed to that
    # single value so existing ``require_role`` guards re-evaluate
    # against the active role per request.
    available = bundle.roles
    stored = session_row.data.get("active_role") if session_row.data else None
    if isinstance(stored, str) and stored in available:
        active = stored
    else:
        active = primary_role(available)

    return CurrentUser(
        id=bundle.id,
        tenant_id=bundle.tenant_id,
        email=bundle.email,
        full_name=bundle.full_name,
        roles=(active,),
        available_roles=available,
        active_role=active,
        departments=bundle.departments,
        session_id=session_row.id,
        preferred_language=bundle.preferred_language,
        preferred_theme=bundle.preferred_theme,
        preferred_density=bundle.preferred_density,
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
