"""Append-only audit writer.

Every row is an INSERT. The ``hadir_app`` Postgres role has no UPDATE,
DELETE, or TRUNCATE privileges on ``main.audit_log``, so any attempt to
rewrite history through the app path is rejected by the database. Keep it
that way — if a future refactor ever issues a mutation against the audit
log through this module, the tests should fail with ``permission denied``
before anyone reviews the PR.
"""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import insert
from sqlalchemy.engine import Connection

from hadir.db import audit_log


def write_audit(
    conn: Connection,
    *,
    tenant_id: int,
    action: str,
    entity_type: str,
    entity_id: Optional[str] = None,
    actor_user_id: Optional[int] = None,
    after: Optional[dict[str, Any]] = None,
    before: Optional[dict[str, Any]] = None,
) -> None:
    """Insert one row into ``main.audit_log``.

    Caller holds the connection (and therefore the transaction) so the
    audit write commits atomically with the event it describes. Passing
    ``before`` is pointless for INSERT-only events (login, logout, expiry)
    but the column exists for v1.0 "exception request approved" style
    entries.
    """

    conn.execute(
        insert(audit_log).values(
            tenant_id=tenant_id,
            actor_user_id=actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=after,
        )
    )
