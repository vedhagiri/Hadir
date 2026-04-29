"""Server-side sessions for MTS staff (Super-Admin console).

Modelled on ``maugood.auth.sessions`` but stored in
``public.super_admin_sessions`` rather than per-tenant ``user_sessions``
— a Super-Admin session has no home tenant. The ``data`` JSONB carries
``impersonated_tenant_id`` once the operator has hit "Access as".

The cookie used by the request middleware is ``maugood_super_session``
(distinct from the tenant cookie ``maugood_session``) so a single browser
can hold both at once — the operator might have a normal tenant
session for testing while logged in to the console as Super-Admin.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from maugood.db import super_admin_sessions

# Same entropy as tenant sessions.
_TOKEN_BYTES = 48

# Cookie name used by the Super-Admin login flow + the request
# middleware. Kept distinct from ``maugood_session`` so both can coexist
# in one browser without collision.
SUPER_SESSION_COOKIE = "maugood_super_session"


@dataclass(frozen=True, slots=True)
class SuperSessionRow:
    """Minimal view of a super-admin session loaded for a request."""

    id: str
    mts_staff_id: int
    expires_at: datetime
    impersonated_tenant_id: Optional[int]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def create_session(
    conn: Connection,
    *,
    mts_staff_id: int,
    idle_minutes: int,
) -> SuperSessionRow:
    """Insert a fresh Super-Admin session and return it."""

    token = secrets.token_urlsafe(_TOKEN_BYTES)
    now = _now()
    expires = now + timedelta(minutes=idle_minutes)

    conn.execute(
        insert(super_admin_sessions).values(
            id=token,
            mts_staff_id=mts_staff_id,
            expires_at=expires,
            data={},
            created_at=now,
            last_seen_at=now,
        )
    )
    return SuperSessionRow(
        id=token,
        mts_staff_id=mts_staff_id,
        expires_at=expires,
        impersonated_tenant_id=None,
    )


def load_session(conn: Connection, session_id: str) -> Optional[SuperSessionRow]:
    """Return the session row for ``session_id`` or ``None`` if unknown."""

    row = conn.execute(
        select(
            super_admin_sessions.c.id,
            super_admin_sessions.c.mts_staff_id,
            super_admin_sessions.c.expires_at,
            super_admin_sessions.c.data,
        ).where(super_admin_sessions.c.id == session_id)
    ).first()
    if row is None:
        return None
    data: dict[str, Any] = dict(row.data or {})
    impersonated = data.get("impersonated_tenant_id")
    impersonated_id: Optional[int] = None
    if impersonated is not None:
        try:
            impersonated_id = int(impersonated)
        except (TypeError, ValueError):
            impersonated_id = None
    return SuperSessionRow(
        id=row.id,
        mts_staff_id=int(row.mts_staff_id),
        expires_at=row.expires_at,
        impersonated_tenant_id=impersonated_id,
    )


def touch_session(
    conn: Connection,
    session_id: str,
    *,
    idle_minutes: int,
) -> datetime:
    """Slide ``expires_at`` and ``last_seen_at`` forward."""

    now = _now()
    new_expiry = now + timedelta(minutes=idle_minutes)
    conn.execute(
        update(super_admin_sessions)
        .where(super_admin_sessions.c.id == session_id)
        .values(expires_at=new_expiry, last_seen_at=now)
    )
    return new_expiry


def set_impersonation(
    conn: Connection, session_id: str, *, tenant_id: Optional[int]
) -> None:
    """Set or clear ``data.impersonated_tenant_id`` for a session.

    Pass ``tenant_id=None`` to drop the impersonation (the Super-Admin
    "exit impersonation" flow). The JSONB merge syntax keeps any
    other claims that future phases might add.
    """

    # Read-modify-write rather than ``jsonb_set`` so we can tolerate a
    # missing ``data`` key (the column has a default, but this avoids
    # surprises if a row was inserted by a hand-written script).
    row = conn.execute(
        select(super_admin_sessions.c.data).where(
            super_admin_sessions.c.id == session_id
        )
    ).first()
    data: dict[str, Any] = dict(row.data or {}) if row is not None else {}
    if tenant_id is None:
        data.pop("impersonated_tenant_id", None)
    else:
        data["impersonated_tenant_id"] = int(tenant_id)
    conn.execute(
        update(super_admin_sessions)
        .where(super_admin_sessions.c.id == session_id)
        .values(data=data)
    )


def delete_session(conn: Connection, session_id: str) -> None:
    conn.execute(
        delete(super_admin_sessions).where(super_admin_sessions.c.id == session_id)
    )


def is_expired(row: SuperSessionRow) -> bool:
    return row.expires_at <= _now()
