"""Server-side session storage.

Pilot choice (PROJECT_CONTEXT §5): sessions live in Postgres, not JWTs. The
cookie carries only an opaque random ID; all session state is loaded from
``main.user_sessions`` on every authenticated request. That makes
revocation immediate — delete the row and the cookie stops working.

Sliding expiry: every ``touch_session`` bumps ``expires_at`` forward by
``session_idle_minutes``. The absolute session lifetime is therefore
unbounded for an active user; that trade-off is intentional for the pilot,
where convenience trumps defence-in-depth. v1.0 introduces an absolute
cap alongside the idle timeout.

P7: ``data.active_role`` is set at login (defaults to the user's
highest role) and updated by ``POST /api/auth/switch-role``. The
request-time ``current_user`` dependency reads it to narrow
``CurrentUser.roles`` to a single tuple, so existing
``require_role`` guards re-evaluate per request without changes.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from maugood.db import user_sessions

# 48 bytes = 64 url-safe characters. Plenty of entropy.
_TOKEN_BYTES = 48


@dataclass(frozen=True, slots=True)
class SessionRow:
    """Minimal view of a session row loaded for a request."""

    id: str
    tenant_id: int
    user_id: int
    expires_at: datetime
    data: dict[str, Any] = field(default_factory=dict)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def create_session(
    conn: Connection,
    *,
    tenant_id: int,
    user_id: int,
    idle_minutes: int,
    tenant_schema: str = "main",
    active_role: Optional[str] = None,
) -> SessionRow:
    """Insert a fresh session and return it.

    ``tenant_schema`` is persisted in ``data`` so the per-request
    ``TenantScopeMiddleware`` can apply ``SET search_path`` without a
    second registry lookup. v1.0 multi-tenant relies on this claim.

    ``active_role`` (P7) is the role the user is currently acting as.
    Defaults to the user's highest role at login; users with multiple
    roles flip it via ``POST /api/auth/switch-role``.
    """

    token = secrets.token_urlsafe(_TOKEN_BYTES)
    now = _now()
    expires = now + timedelta(minutes=idle_minutes)
    data: dict[str, Any] = {
        "tenant_id": tenant_id,
        "tenant_schema": tenant_schema,
    }
    if active_role is not None:
        data["active_role"] = active_role

    conn.execute(
        insert(user_sessions).values(
            id=token,
            tenant_id=tenant_id,
            user_id=user_id,
            expires_at=expires,
            data=data,
            created_at=now,
            last_seen_at=now,
        )
    )
    return SessionRow(
        id=token,
        tenant_id=tenant_id,
        user_id=user_id,
        expires_at=expires,
        data=data,
    )


def load_session(conn: Connection, session_id: str) -> Optional[SessionRow]:
    """Return the session row for ``session_id`` or ``None`` if unknown."""

    row = conn.execute(
        select(
            user_sessions.c.id,
            user_sessions.c.tenant_id,
            user_sessions.c.user_id,
            user_sessions.c.expires_at,
            user_sessions.c.data,
        ).where(user_sessions.c.id == session_id)
    ).first()
    if row is None:
        return None
    return SessionRow(
        id=row.id,
        tenant_id=int(row.tenant_id),
        user_id=int(row.user_id),
        expires_at=row.expires_at,
        data=dict(row.data or {}),
    )


def touch_session(
    conn: Connection,
    session_id: str,
    *,
    idle_minutes: int,
) -> datetime:
    """Bump ``expires_at`` and ``last_seen_at`` for a valid session.

    Returns the new ``expires_at`` so callers can mirror it in the cookie
    ``Max-Age``.
    """

    now = _now()
    new_expiry = now + timedelta(minutes=idle_minutes)
    conn.execute(
        update(user_sessions)
        .where(user_sessions.c.id == session_id)
        .values(expires_at=new_expiry, last_seen_at=now)
    )
    return new_expiry


def update_active_role(
    conn: Connection, session_id: str, *, active_role: str
) -> None:
    """Patch ``data.active_role`` on an existing session row.

    Read-modify-write rather than ``jsonb_set`` so we tolerate a
    missing or malformed ``data`` field — same defensive pattern the
    Super-Admin impersonation update uses.
    """

    row = conn.execute(
        select(user_sessions.c.data).where(user_sessions.c.id == session_id)
    ).first()
    if row is None:
        return
    data: dict[str, Any] = dict(row.data or {})
    data["active_role"] = active_role
    conn.execute(
        update(user_sessions)
        .where(user_sessions.c.id == session_id)
        .values(data=data)
    )


def delete_session(conn: Connection, session_id: str) -> None:
    """Remove a session row. Used by logout and expiry handling."""

    conn.execute(delete(user_sessions).where(user_sessions.c.id == session_id))


def is_expired(row: SessionRow) -> bool:
    """Return True if the session's ``expires_at`` is in the past."""

    return row.expires_at <= _now()
