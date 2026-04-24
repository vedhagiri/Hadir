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
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from hadir.db import user_sessions

# 48 bytes = 64 url-safe characters. Plenty of entropy.
_TOKEN_BYTES = 48


@dataclass(frozen=True, slots=True)
class SessionRow:
    """Minimal view of a session row loaded for a request."""

    id: str
    tenant_id: int
    user_id: int
    expires_at: datetime


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def create_session(
    conn: Connection,
    *,
    tenant_id: int,
    user_id: int,
    idle_minutes: int,
) -> SessionRow:
    """Insert a fresh session and return it."""

    token = secrets.token_urlsafe(_TOKEN_BYTES)
    now = _now()
    expires = now + timedelta(minutes=idle_minutes)

    conn.execute(
        insert(user_sessions).values(
            id=token,
            tenant_id=tenant_id,
            user_id=user_id,
            expires_at=expires,
            data={},
            created_at=now,
            last_seen_at=now,
        )
    )
    return SessionRow(id=token, tenant_id=tenant_id, user_id=user_id, expires_at=expires)


def load_session(conn: Connection, session_id: str) -> Optional[SessionRow]:
    """Return the session row for ``session_id`` or ``None`` if unknown."""

    row = conn.execute(
        select(
            user_sessions.c.id,
            user_sessions.c.tenant_id,
            user_sessions.c.user_id,
            user_sessions.c.expires_at,
        ).where(user_sessions.c.id == session_id)
    ).first()
    if row is None:
        return None
    return SessionRow(
        id=row.id,
        tenant_id=int(row.tenant_id),
        user_id=int(row.user_id),
        expires_at=row.expires_at,
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


def delete_session(conn: Connection, session_id: str) -> None:
    """Remove a session row. Used by logout and expiry handling."""

    conn.execute(delete(user_sessions).where(user_sessions.c.id == session_id))


def is_expired(row: SessionRow) -> bool:
    """Return True if the session's ``expires_at`` is in the past."""

    return row.expires_at <= _now()
