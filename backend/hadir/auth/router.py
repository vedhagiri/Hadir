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
from hadir.auth.dependencies import CurrentUser, _load_current_user_bundle, current_user
from hadir.auth.passwords import verify_password
from hadir.auth.ratelimit import LoginRateLimiter, get_rate_limiter
from hadir.auth.sessions import create_session, delete_session
from hadir.config import get_settings
from hadir.db import get_engine, users
from hadir.tenants import TenantScope, get_tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    """Body of ``POST /api/auth/login``.

    ``EmailStr`` validates the format; we lowercase the stored value so
    CITEXT's case-insensitive comparison matches every time.
    """

    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class MeResponse(BaseModel):
    id: int
    email: str
    full_name: str
    roles: list[str]
    departments: list[int]


def _client_ip(request: Request) -> str:
    """Best-effort client IP. ``request.client.host`` is enough for pilot."""

    client = request.client
    return client.host if client is not None else "unknown"


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

    if limiter.is_blocked(email, ip):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                action="auth.login.rate_limited",
                entity_type="user",
                entity_id=None,
                after={"email_attempted": email, "ip": ip},
            )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too many login attempts",
        )

    # Load the user in a short read-only transaction. We end it before any
    # branch that might ``raise HTTPException`` — raising inside
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
                users.c.tenant_id == scope.tenant_id,
                users.c.email == email,
            )
        ).first()

    # Single "invalid credentials" path for (a) unknown email, (b) wrong
    # password, and (c) inactive user. We still audit each case with a
    # distinct ``reason`` so operators can tell them apart in the log,
    # but the client sees one generic 401.
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
                tenant_id=scope.tenant_id,
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
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials"
        )

    assert user_row is not None  # narrowed by the failure_reason branch above.

    # Success — reset the counter, create the session, audit, load bundle.
    limiter.reset_key(email, ip)
    with engine.begin() as conn:
        # Resolve the user's home tenant schema once at login and stash
        # it on the session so the per-request middleware doesn't have
        # to round-trip the registry on every call.
        from hadir.tenants.scope import resolve_tenant_schema  # noqa: PLC0415

        tenant_schema = resolve_tenant_schema(conn, int(user_row.tenant_id))
        session = create_session(
            conn,
            tenant_id=int(user_row.tenant_id),
            user_id=int(user_row.id),
            idle_minutes=settings.session_idle_minutes,
            tenant_schema=tenant_schema,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=int(user_row.id),
            action="auth.login.success",
            entity_type="user",
            entity_id=str(user_row.id),
            after={
                "ip": ip,
                "session_id": session.id,
                "tenant_schema": tenant_schema,
            },
        )
        bundle = _load_current_user_bundle(
            conn, user_id=int(user_row.id), tenant_id=int(user_row.tenant_id)
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

    return MeResponse(
        id=bundle.id,
        email=bundle.email,
        full_name=bundle.full_name,
        roles=list(bundle.roles),
        departments=list(bundle.departments),
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
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
def me(user: Annotated[CurrentUser, Depends(current_user)]) -> MeResponse:
    """Describe the caller."""

    return MeResponse(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        roles=list(user.roles),
        departments=list(user.departments),
    )
