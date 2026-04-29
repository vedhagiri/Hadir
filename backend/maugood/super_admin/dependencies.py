"""FastAPI dependency for the Super-Admin console.

``current_super_admin`` validates the ``maugood_super_session`` cookie,
loads the MTS staff row, refreshes session expiry, and exposes the
result as a ``CurrentSuperAdmin`` value object. Used by every endpoint
under ``/api/super-admin/*``.

Distinct from ``maugood.auth.dependencies.current_user`` — Super-Admins
are *operators*, not tenant users, and never appear in any tenant's
``users`` table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import Cookie, HTTPException, Request, Response, status
from sqlalchemy import select

from maugood.config import get_settings
from maugood.db import get_engine, mts_staff
from maugood.super_admin.sessions import (
    SUPER_SESSION_COOKIE,
    SuperSessionRow,
    delete_session,
    is_expired,
    load_session,
    touch_session,
)


@dataclass(frozen=True, slots=True)
class CurrentSuperAdmin:
    """Per-request snapshot of the authenticated MTS staff user."""

    id: int
    email: str
    full_name: str
    session_id: str
    impersonated_tenant_id: Optional[int]


def _client_ip(request: Request) -> str:
    client = request.client
    return client.host if client is not None else "unknown"


def current_super_admin(
    request: Request,
    response: Response,
    maugood_super_session: str | None = Cookie(default=None, alias=SUPER_SESSION_COOKIE),
) -> CurrentSuperAdmin:
    """Resolve the logged-in MTS staff user from the super-session cookie.

    Sliding expiry: every authenticated hit refreshes ``expires_at``
    and the cookie ``Max-Age``. Raises 401 on missing / invalid /
    expired / inactive.
    """

    if not maugood_super_session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="super-admin authentication required",
        )

    settings = get_settings()
    engine = get_engine()

    with engine.begin() as conn:
        session_row: SuperSessionRow | None = load_session(conn, maugood_super_session)

    if session_row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session"
        )

    if is_expired(session_row):
        with engine.begin() as conn:
            delete_session(conn, session_row.id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired"
        )

    with engine.begin() as conn:
        staff_row = conn.execute(
            select(
                mts_staff.c.id,
                mts_staff.c.email,
                mts_staff.c.full_name,
                mts_staff.c.is_active,
            ).where(mts_staff.c.id == session_row.mts_staff_id)
        ).first()

    if staff_row is None or not staff_row.is_active:
        with engine.begin() as conn:
            delete_session(conn, session_row.id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="user inactive"
        )

    with engine.begin() as conn:
        touch_session(conn, session_row.id, idle_minutes=settings.session_idle_minutes)

    response.set_cookie(
        key=SUPER_SESSION_COOKIE,
        value=session_row.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )

    # Surface to other deps + the audit dual-write helper.
    request.state.is_super_admin = True
    request.state.super_admin_user_id = int(staff_row.id)
    request.state.super_admin_session_id = session_row.id
    request.state.client_ip = _client_ip(request)
    if session_row.impersonated_tenant_id is not None:
        request.state.impersonated_tenant_id = session_row.impersonated_tenant_id

    return CurrentSuperAdmin(
        id=int(staff_row.id),
        email=str(staff_row.email),
        full_name=str(staff_row.full_name),
        session_id=session_row.id,
        impersonated_tenant_id=session_row.impersonated_tenant_id,
    )
