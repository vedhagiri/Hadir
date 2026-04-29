"""Append-only audit writer.

Every row is an INSERT. The ``maugood_app`` Postgres role has no UPDATE,
DELETE, or TRUNCATE privileges on ``main.audit_log`` (or any tenant
schema's audit_log) so any attempt to rewrite history through the app
path is rejected by the database. Keep it that way — if a future
refactor ever issues a mutation against the audit log through this
module, the tests should fail with ``permission denied`` before anyone
reviews the PR.

P3 dual-write: when a Super-Admin is impersonating a tenant
(``TenantScopeMiddleware`` sets ``_super_admin_context`` for the
request), every per-tenant audit row also writes a paired row to
``public.super_admin_audit``. The duplication is by design — tenant
Admins reading their own audit log can see ``MTS touched our data``
without needing cross-tenant read access to the operator log, and the
operator log holds the full cross-tenant history independently.
"""

from __future__ import annotations

import contextvars
from typing import Any, Optional

from sqlalchemy import insert
from sqlalchemy.engine import Connection

from maugood.db import audit_log, super_admin_audit


# Per-request context describing the active Super-Admin operator.
# ``TenantScopeMiddleware`` populates this when it resolves a request
# whose ``maugood_super_session`` cookie carries an
# ``impersonated_tenant_id``; ``write_audit`` reads it to decide
# whether to dual-log. Plain tenant requests leave it None.
_super_admin_context: contextvars.ContextVar[Optional[dict[str, Any]]] = (
    contextvars.ContextVar("maugood_super_admin_audit_ctx", default=None)
)


def set_super_admin_audit_context(
    *, super_admin_user_id: int, ip: Optional[str] = None
) -> contextvars.Token:
    """Mark the current request as Super-Admin impersonation.

    Returns a reset token. The middleware's ``finally`` block calls
    ``reset_super_admin_audit_context(token)`` so the contextvar
    doesn't leak into the next request handled on the same worker.
    """

    return _super_admin_context.set(
        {"super_admin_user_id": int(super_admin_user_id), "ip": ip}
    )


def reset_super_admin_audit_context(token: contextvars.Token) -> None:
    _super_admin_context.reset(token)


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
    """Insert one row into the active tenant's ``audit_log``.

    Caller holds the connection (and therefore the transaction) so the
    audit write commits atomically with the event it describes. Passing
    ``before`` is pointless for INSERT-only events (login, logout,
    expiry) but the column exists for v1.0 "exception request approved"
    style entries.

    P3 dual-write: if the request is in a Super-Admin impersonation
    context (set by ``TenantScopeMiddleware``), also INSERT a row into
    ``public.super_admin_audit``. The tenant row's ``after`` is
    augmented with ``impersonated_by_super_admin_user_id`` so a tenant
    Admin reading their own log can see the touch came from MTS.
    """

    sa_ctx = _super_admin_context.get()
    tenant_after: Optional[dict[str, Any]] = after
    # Synthetic Super-Admin user: ``current_user`` returns id=0 when
    # the operator is impersonating. There is no users.id=0, so storing
    # it as actor_user_id would FK-violate against ``users``. Translate
    # to NULL — the impersonation marker on ``after`` carries the
    # operator's identity for the tenant log, and the dual-write row in
    # ``public.super_admin_audit`` carries it for the operator log.
    persisted_actor: Optional[int] = (
        actor_user_id if actor_user_id is not None and actor_user_id > 0 else None
    )
    if sa_ctx is not None:
        tenant_after = dict(after or {})
        tenant_after["impersonated_by_super_admin_user_id"] = (
            sa_ctx["super_admin_user_id"]
        )

    conn.execute(
        insert(audit_log).values(
            tenant_id=tenant_id,
            actor_user_id=persisted_actor,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=tenant_after,
        )
    )

    if sa_ctx is not None:
        conn.execute(
            insert(super_admin_audit).values(
                super_admin_user_id=sa_ctx["super_admin_user_id"],
                tenant_id=tenant_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                before=before,
                # Keep the operator-log ``after`` as the original
                # caller-provided dict (without the impersonation
                # marker — that marker only matters in the tenant
                # log so tenant Admins can spot MTS-touched rows).
                after=after,
                ip=sa_ctx.get("ip"),
            )
        )
