"""Record a successful login on the ``users`` row.

Bumps ``last_login_at`` / ``login_count`` and stamps the ``auth_provider``
that was used (``password`` | ``microsoft`` | ``google``). Called from
every login success path inside the same transaction that creates the
session, so the AD Users "Login Activity" tab has fresh per-user data
without scanning the audit log.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.engine import Connection

from maugood.db import users


def record_login(
    conn: Connection, *, tenant_id: int, user_id: int, provider: str
) -> None:
    conn.execute(
        update(users)
        .where(users.c.tenant_id == tenant_id, users.c.id == user_id)
        .values(
            last_login_at=datetime.now(tz=timezone.utc),
            login_count=users.c.login_count + 1,
            auth_provider=provider,
        )
    )
