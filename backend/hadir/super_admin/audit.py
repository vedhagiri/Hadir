"""Append-only audit writer for Super-Admin actions.

Two write paths:

1. ``write_super_admin_audit`` — direct INSERT into
   ``public.super_admin_audit`` for actions that don't touch tenant
   data (login, logout, tenant viewed in the console, "Access as"
   start/end). Always called.
2. ``write_audit_dual`` — used by tenant-context handlers when the
   request's caller is a Super-Admin in impersonation mode. Writes
   one row to the tenant's own ``audit_log`` (so tenants can see they
   were accessed) AND a paired row to ``public.super_admin_audit`` so
   the operator log carries every cross-tenant touch.

The ``hadir_app`` Postgres role has INSERT + SELECT only on
``public.super_admin_audit`` — UPDATE/DELETE/TRUNCATE are rejected by
the database, mirroring the per-tenant ``audit_log`` contract.
"""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import insert
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.db import super_admin_audit


def write_super_admin_audit(
    conn: Connection,
    *,
    super_admin_user_id: int,
    action: str,
    entity_type: str,
    tenant_id: Optional[int] = None,
    entity_id: Optional[str] = None,
    after: Optional[dict[str, Any]] = None,
    before: Optional[dict[str, Any]] = None,
    ip: Optional[str] = None,
) -> None:
    """Insert one row into ``public.super_admin_audit``."""

    conn.execute(
        insert(super_admin_audit).values(
            super_admin_user_id=super_admin_user_id,
            tenant_id=tenant_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=after,
            ip=ip,
        )
    )


def write_audit_dual(
    conn: Connection,
    *,
    tenant_id: int,
    super_admin_user_id: int,
    action: str,
    entity_type: str,
    entity_id: Optional[str] = None,
    actor_user_id: Optional[int] = None,
    after: Optional[dict[str, Any]] = None,
    before: Optional[dict[str, Any]] = None,
    ip: Optional[str] = None,
) -> None:
    """Write one row to both the tenant log AND ``super_admin_audit``.

    Used when a Super-Admin in impersonation mode performs a
    tenant-context write. The two rows are mirror images modulo the
    ``super_admin_user_id`` field, which only makes sense in the
    operator log. The tenant row's ``after`` carries an
    ``impersonated_by_super_admin_user_id`` claim so a tenant Admin
    reading their own audit log can tell the action came from MTS.
    """

    tenant_after = dict(after or {})
    tenant_after["impersonated_by_super_admin_user_id"] = super_admin_user_id

    write_audit(
        conn,
        tenant_id=tenant_id,
        actor_user_id=actor_user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        after=tenant_after,
        before=before,
    )
    write_super_admin_audit(
        conn,
        super_admin_user_id=super_admin_user_id,
        tenant_id=tenant_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        after=after,
        before=before,
        ip=ip,
    )
