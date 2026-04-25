"""FastAPI router for ``/api/auth/*`` endpoints.

Three routes make up the pilot's login surface:

* ``POST /api/auth/login``   — email+password → session cookie
* ``POST /api/auth/logout``  — clear the session and cookie
* ``GET  /api/auth/me``      — describe the caller

Every outcome (success, wrong password, unknown email, rate-limited,
logout, expiry) writes an append-only row to ``main.audit_log``. Plain
passwords never appear in those rows — we only ever record the attempted
email and a short reason string.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import (
    CurrentUser,
    _load_current_user_bundle,
    current_user,
    primary_role,
)
from hadir.auth.passwords import verify_password
from hadir.auth.ratelimit import LoginRateLimiter, get_rate_limiter
from hadir.auth.sessions import (
    create_session,
    delete_session,
    update_active_role,
)
from hadir.config import get_settings
from hadir.db import _TENANT_SCHEMA_RE, get_engine, tenant_context, tenants, users
from hadir.tenants import TenantScope, get_tenant_scope

# Cookie that carries the tenant the session belongs to. Set alongside
# ``hadir_session`` at login, read by ``TenantScopeMiddleware`` to
# resolve which schema's ``user_sessions`` to look the cookie up in.
TENANT_COOKIE_NAME = "hadir_tenant"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    """Body of ``POST /api/auth/login``.

    ``EmailStr`` validates the format; we lowercase the stored value so
    CITEXT's case-insensitive comparison matches every time.

    ``tenant_slug`` (v1.0 P5) is the schema name of the tenant the
    caller belongs to. Optional for backward compatibility with the
    pilot's single-tenant flow — when omitted, login defaults to the
    pilot's ``main`` schema. Required for any non-pilot tenant.
    """

    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)
    tenant_slug: str | None = Field(default=None, max_length=63)


class MeResponse(BaseModel):
    id: int
    email: str
    full_name: str
    # P7: ``roles`` carries only the active role (preserves the pilot
    # contract — older clients that don't know about the switcher
    # treat the user as if they hold exactly that role). ``active_role``
    # makes that explicit for new clients; ``available_roles`` is the
    # full set the user holds and drives the topbar dropdown.
    roles: list[str]
    available_roles: list[str]
    active_role: str
    departments: list[int]
    # P3: True when ``current_user`` resolved a synthetic Super-Admin
    # in impersonation mode. The tenant shell uses this to render the
    # "Viewing as SuperAdmin" red banner.
    is_super_admin_impersonation: bool = False
    super_admin_user_id: int | None = None
    # P21: explicit per-user UI language (``en`` / ``ar``). ``None``
    # means "follow browser" — the frontend's i18next detector reads
    # ``navigator.language`` in that case.
    preferred_language: str | None = None
    # P22: theme + density. ``None`` on theme = "follow system";
    # ``None`` on density = "comfortable" (the design's default).
    preferred_theme: str | None = None
    preferred_density: str | None = None


class PreferredLanguageRequest(BaseModel):
    # ``None`` clears the preference and lets the browser drive.
    preferred_language: str | None = Field(default=None, max_length=8)


class PreferredThemeRequest(BaseModel):
    # ``None`` clears the preference and falls back to "system".
    preferred_theme: str | None = Field(default=None, max_length=16)


class PreferredDensityRequest(BaseModel):
    # ``None`` clears the preference and falls back to "comfortable".
    preferred_density: str | None = Field(default=None, max_length=16)


class SwitchRoleRequest(BaseModel):
    role: str = Field(min_length=1, max_length=64)


def _client_ip(request: Request) -> str:
    """Best-effort client IP. ``request.client.host`` is enough for pilot."""

    client = request.client
    return client.host if client is not None else "unknown"


def _resolve_login_target(
    *,
    tenant_slug: str | None,
    settings,
    engine,
) -> tuple[int, str]:
    """Return ``(tenant_id, tenant_schema)`` the login should run under.

    Path A — explicit ``tenant_slug`` (v1.0 multi-tenant): validate the
    slug against the same regex Postgres CHECK enforces, then look up
    the row in the global registry. Refuse suspended tenants. Refuse
    unknown slugs.

    Path B — no slug (pilot single-tenant compatibility): use the
    configured default tenant id and the conventional ``main`` schema.
    """

    if tenant_slug is not None:
        if not _TENANT_SCHEMA_RE.match(tenant_slug):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid tenant_slug",
            )
        with tenant_context("public"):
            with engine.begin() as conn:
                row = conn.execute(
                    select(
                        tenants.c.id,
                        tenants.c.schema_name,
                        tenants.c.status,
                    ).where(tenants.c.schema_name == tenant_slug)
                ).first()
        if row is None:
            # Don't 404 — that leaks tenant existence by oracle. Treat
            # as bad credentials so attackers can't enumerate tenants.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid credentials",
            )
        if str(row.status) == "suspended":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="tenant suspended",
            )
        return int(row.id), str(row.schema_name)

    return settings.default_tenant_id, "main"


@router.post("/login", status_code=status.HTTP_200_OK)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
    limiter: Annotated[LoginRateLimiter, Depends(get_rate_limiter)],
) -> MeResponse:
    """Verify credentials, start a session, set the cookie."""

    email = payload.email.lower()
    ip = _client_ip(request)
    settings = get_settings()
    engine = get_engine()

    target_tenant_id, target_schema = _resolve_login_target(
        tenant_slug=payload.tenant_slug, settings=settings, engine=engine
    )

    # All DB ops below run under the resolved tenant's schema. The
    # checkout listener applies SET search_path on every borrowed
    # connection. Login pre-dates the middleware setting any schema
    # (the request was anonymous on entry), so this context is what
    # makes multi-tenant login work.
    with tenant_context(target_schema):
        if limiter.is_blocked(email, ip):
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=target_tenant_id,
                    action="auth.login.rate_limited",
                    entity_type="user",
                    entity_id=None,
                    after={"email_attempted": email, "ip": ip},
                )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="too many login attempts",
            )

        # Load the user in a short read-only transaction. We end it before
        # any branch that might ``raise HTTPException`` — raising inside
        # ``engine.begin()`` would roll back the audit write that follows.
        with engine.begin() as conn:
            user_row = conn.execute(
                select(
                    users.c.id,
                    users.c.tenant_id,
                    users.c.email,
                    users.c.full_name,
                    users.c.password_hash,
                    users.c.is_active,
                ).where(
                    users.c.tenant_id == target_tenant_id,
                    users.c.email == email,
                )
            ).first()

        # Single "invalid credentials" path for (a) unknown email, (b)
        # wrong password, and (c) inactive user. We still audit each case
        # with a distinct ``reason`` so operators can tell them apart in
        # the log, but the client sees one generic 401.
        failure_reason: str | None = None
        if user_row is None:
            failure_reason = "unknown_email"
        elif not user_row.is_active:
            failure_reason = "inactive_user"
        elif not verify_password(user_row.password_hash, payload.password):
            failure_reason = "wrong_password"

        if failure_reason is not None:
            attempts = limiter.register_failure(email, ip)
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=target_tenant_id,
                    actor_user_id=int(user_row.id) if user_row is not None else None,
                    action="auth.login.failure",
                    entity_type="user",
                    entity_id=str(user_row.id) if user_row is not None else None,
                    after={
                        "email_attempted": email,
                        "ip": ip,
                        "reason": failure_reason,
                        "attempts": attempts,
                    },
                )
            # Do not reveal which case fired — PROJECT_CONTEXT §12 red line.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid credentials",
            )

        assert user_row is not None  # narrowed by the failure_reason branch.

        # Success — reset the counter, create the session, audit, load bundle.
        limiter.reset_key(email, ip)
        with engine.begin() as conn:
            # P7: prime ``active_role`` with the user's highest role
            # so a fresh session lands on the most-capable nav by
            # default. We have to load the bundle once up front to
            # know which roles they hold.
            initial_bundle = _load_current_user_bundle(
                conn,
                user_id=int(user_row.id),
                tenant_id=target_tenant_id,
            )
            initial_active = primary_role(
                initial_bundle.roles if initial_bundle is not None else ()
            )
            session = create_session(
                conn,
                tenant_id=target_tenant_id,
                user_id=int(user_row.id),
                idle_minutes=settings.session_idle_minutes,
                tenant_schema=target_schema,
                active_role=initial_active,
            )
            write_audit(
                conn,
                tenant_id=target_tenant_id,
                actor_user_id=int(user_row.id),
                action="auth.login.success",
                entity_type="user",
                entity_id=str(user_row.id),
                after={
                    "ip": ip,
                    "session_id": session.id,
                    "tenant_schema": target_schema,
                },
            )
            bundle = _load_current_user_bundle(
                conn,
                user_id=int(user_row.id),
                tenant_id=target_tenant_id,
            )

    # bundle can't be None here — we just authenticated the row.
    assert bundle is not None

    response.set_cookie(
        key=settings.session_cookie_name,
        value=session.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    # P5: pin the session to its tenant. The middleware reads this on
    # every subsequent request to know which ``user_sessions`` table to
    # look the opaque ``hadir_session`` token up in.
    response.set_cookie(
        key=TENANT_COOKIE_NAME,
        value=target_schema,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )

    return MeResponse(
        id=bundle.id,
        email=bundle.email,
        full_name=bundle.full_name,
        roles=[initial_active],
        available_roles=list(bundle.roles),
        active_role=initial_active,
        departments=list(bundle.departments),
        preferred_language=bundle.preferred_language,
        preferred_theme=bundle.preferred_theme,
        preferred_density=bundle.preferred_density,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> Response:
    """Drop the session row and clear the cookie."""

    settings = get_settings()
    engine = get_engine()
    ip = _client_ip(request)

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.logout",
            entity_type="session",
            entity_id=user.session_id,
            after={"ip": ip},
        )
        delete_session(conn, user.session_id)

    response.delete_cookie(key=settings.session_cookie_name, path="/")
    response.delete_cookie(key=TENANT_COOKIE_NAME, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
def me(
    request: Request,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """Describe the caller."""

    is_imp = bool(getattr(request.state, "is_super_admin", False)) and user.id == 0
    sa_user_id: int | None = (
        int(getattr(request.state, "super_admin_user_id", 0)) if is_imp else None
    )
    return _to_me_response(user, is_imp=is_imp, sa_user_id=sa_user_id)


def _to_me_response(
    user: CurrentUser,
    *,
    is_imp: bool = False,
    sa_user_id: int | None = None,
) -> MeResponse:
    return MeResponse(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        roles=list(user.roles),
        available_roles=list(user.available_roles),
        active_role=user.active_role,
        departments=list(user.departments),
        is_super_admin_impersonation=is_imp,
        super_admin_user_id=sa_user_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
    )


@router.patch("/preferred-language")
def set_preferred_language(
    payload: PreferredLanguageRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P21: persist the operator's UI language preference.

    Pass ``preferred_language=null`` to clear the choice and let the
    browser drive again. The DB CHECK on ``users.preferred_language``
    rejects anything other than ``en`` / ``ar`` / NULL.
    """

    from hadir.i18n import SUPPORTED_LANGUAGES  # noqa: PLC0415

    new_value = payload.preferred_language
    if new_value is not None and new_value not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_language must be null or one of: "
                + ", ".join(SUPPORTED_LANGUAGES)
            ),
        )

    if user.id == 0:
        # Synthetic Super-Admin — no real users row to update.
        # Return as-is so the topbar switcher in the impersonation
        # banner doesn't crash.
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(
                users.c.id == user.id, users.c.tenant_id == user.tenant_id
            )
            .values(preferred_language=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_language.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_language": user.preferred_language},
            after={"preferred_language": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=new_value,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)


# Allowed values mirror the DB CHECK constraints (migration 0023).
_THEME_OPTIONS = ("system", "light", "dark")
_DENSITY_OPTIONS = ("compact", "comfortable")


@router.patch("/preferred-theme")
def set_preferred_theme(
    payload: PreferredThemeRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P22: persist the operator's theme preference (system/light/dark).

    ``preferred_theme=null`` clears the explicit choice — the
    frontend's ThemeProvider then falls back to the OS preference
    via ``prefers-color-scheme``. The DB CHECK constraint rejects
    anything outside the documented enum.
    """

    new_value = payload.preferred_theme
    if new_value is not None and new_value not in _THEME_OPTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_theme must be null or one of: "
                + ", ".join(_THEME_OPTIONS)
            ),
        )

    if user.id == 0:
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(users.c.id == user.id, users.c.tenant_id == user.tenant_id)
            .values(preferred_theme=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_theme.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_theme": user.preferred_theme},
            after={"preferred_theme": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=new_value,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)


@router.patch("/preferred-density")
def set_preferred_density(
    payload: PreferredDensityRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P22: persist the operator's density preference (compact/comfortable)."""

    new_value = payload.preferred_density
    if new_value is not None and new_value not in _DENSITY_OPTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_density must be null or one of: "
                + ", ".join(_DENSITY_OPTIONS)
            ),
        )

    if user.id == 0:
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(users.c.id == user.id, users.c.tenant_id == user.tenant_id)
            .values(preferred_density=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_density.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_density": user.preferred_density},
            after={"preferred_density": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=new_value,
    )
    return _to_me_response(refreshed)


@router.post("/switch-role")
def switch_role(
    payload: SwitchRoleRequest,
    request: Request,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """Flip the session's active role (P7).

    Validates the user actually holds the role, persists the new
    ``active_role`` claim on ``user_sessions.data``, audits the
    transition, and returns the refreshed ``/me`` payload. Refuses
    for the synthetic Super-Admin (no real session row to update —
    operators QA non-Admin flows by signing in as a real test user).
    """

    if user.id == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot switch role for super-admin impersonation",
        )

    if payload.role not in user.available_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"user does not hold role {payload.role!r}",
        )
    if payload.role == user.active_role:
        # No-op — return current state without an audit row.
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        update_active_role(conn, user.session_id, active_role=payload.role)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.role.switched",
            entity_type="session",
            entity_id=user.session_id,
            before={"active_role": user.active_role},
            after={"active_role": payload.role},
        )
        bundle = _load_current_user_bundle(
            conn, user_id=user.id, tenant_id=user.tenant_id
        )
    assert bundle is not None

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=(payload.role,),
        available_roles=bundle.roles,
        active_role=payload.role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)
