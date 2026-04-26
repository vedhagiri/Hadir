"""Read helpers for the Super-Admin console.

Tenants list with stats (admin count, employee count, etc.) and recent
audit events for a tenant. The Super-Admin console has read access
across every tenant schema for these summary views — the
``tenant_context`` shifts per-query so each schema's data is reached
under its own search_path.

Writes never live here. Cross-tenant writes only happen during
impersonation, and they go through the per-tenant routers (which
write to both audit logs via ``write_audit_dual``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import func, select, text
from sqlalchemy.engine import Engine

from hadir.db import (
    audit_log,
    employees,
    roles,
    super_admin_audit,
    tenant_context,
    tenants,
    user_roles,
    users,
)


@dataclass(frozen=True, slots=True)
class TenantSummary:
    id: int
    name: str
    # Friendly identifier — what an operator types into login.
    slug: str
    # Internal Postgres schema. Operators see it for ops/troubleshooting
    # but never need to type it.
    schema_name: str
    status: str
    created_at: str
    admin_count: int
    employee_count: int


@dataclass(frozen=True, slots=True)
class TenantDetail:
    id: int
    name: str
    slug: str
    schema_name: str
    status: str
    created_at: str
    admin_count: int
    employee_count: int
    admin_users: list[dict]
    recent_super_admin_audit: list[dict]


def _list_tenant_rows(engine: Engine) -> list[dict]:
    """Read every row from ``public.tenants``, sorted by id."""

    # Operate under the public schema so the unqualified ``tenants``
    # selector lands in public — it's also explicitly schema-baked but
    # keeping search_path on public avoids any extension surprises.
    with tenant_context("public"):
        with engine.begin() as conn:
            rows = conn.execute(
                select(
                    tenants.c.id,
                    tenants.c.name,
                    tenants.c.slug,
                    tenants.c.schema_name,
                    tenants.c.status,
                    tenants.c.created_at,
                ).order_by(tenants.c.id)
            ).all()
    return [
        {
            "id": int(r.id),
            "name": str(r.name),
            "slug": str(r.slug),
            "schema_name": str(r.schema_name),
            "status": str(r.status),
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


def _admin_and_employee_counts(
    engine: Engine, *, tenant_id: int, schema_name: str
) -> tuple[int, int]:
    """Run two count queries inside the tenant's schema."""

    with tenant_context(schema_name):
        with engine.begin() as conn:
            admin_count = conn.execute(
                select(func.count())
                .select_from(user_roles.join(roles, user_roles.c.role_id == roles.c.id))
                .where(
                    user_roles.c.tenant_id == tenant_id,
                    roles.c.tenant_id == tenant_id,
                    roles.c.code == "Admin",
                )
            ).scalar_one()
            employee_count = conn.execute(
                select(func.count())
                .select_from(employees)
                .where(
                    employees.c.tenant_id == tenant_id,
                    employees.c.status == "active",
                )
            ).scalar_one()
    return int(admin_count), int(employee_count)


def list_tenants(engine: Engine) -> list[TenantSummary]:
    """Return tenants + per-tenant counts. One query per tenant — fine for pilot scale."""

    summaries: list[TenantSummary] = []
    for row in _list_tenant_rows(engine):
        try:
            admin_count, employee_count = _admin_and_employee_counts(
                engine, tenant_id=row["id"], schema_name=row["schema_name"]
            )
        except Exception:
            # Don't let one broken tenant schema poison the whole
            # console list — surface zeros and let the operator open
            # the detail page to see the real error.
            admin_count = 0
            employee_count = 0
        summaries.append(
            TenantSummary(
                id=row["id"],
                name=row["name"],
                slug=row["slug"],
                schema_name=row["schema_name"],
                status=row["status"],
                created_at=row["created_at"],
                admin_count=admin_count,
                employee_count=employee_count,
            )
        )
    return summaries


def get_tenant_detail(engine: Engine, *, tenant_id: int) -> Optional[TenantDetail]:
    """Return the same fields as the list view plus admin users + recent audit."""

    with tenant_context("public"):
        with engine.begin() as conn:
            row = conn.execute(
                select(
                    tenants.c.id,
                    tenants.c.name,
                    tenants.c.slug,
                    tenants.c.schema_name,
                    tenants.c.status,
                    tenants.c.created_at,
                ).where(tenants.c.id == tenant_id)
            ).first()
    if row is None:
        return None

    schema_name = str(row.schema_name)

    admin_count, employee_count = _admin_and_employee_counts(
        engine, tenant_id=tenant_id, schema_name=schema_name
    )

    # Admin users: every active user with the Admin role.
    with tenant_context(schema_name):
        with engine.begin() as conn:
            admin_rows = conn.execute(
                select(
                    users.c.id,
                    users.c.email,
                    users.c.full_name,
                    users.c.is_active,
                )
                .select_from(
                    users.join(user_roles, user_roles.c.user_id == users.c.id).join(
                        roles, user_roles.c.role_id == roles.c.id
                    )
                )
                .where(
                    users.c.tenant_id == tenant_id,
                    user_roles.c.tenant_id == tenant_id,
                    roles.c.tenant_id == tenant_id,
                    roles.c.code == "Admin",
                )
                .order_by(users.c.id)
            ).all()
            admin_users = [
                {
                    "id": int(u.id),
                    "email": str(u.email),
                    "full_name": str(u.full_name),
                    "is_active": bool(u.is_active),
                }
                for u in admin_rows
            ]

    # Recent super-admin audit rows for this tenant.
    with tenant_context("public"):
        with engine.begin() as conn:
            audit_rows = conn.execute(
                select(
                    super_admin_audit.c.id,
                    super_admin_audit.c.super_admin_user_id,
                    super_admin_audit.c.action,
                    super_admin_audit.c.entity_type,
                    super_admin_audit.c.entity_id,
                    super_admin_audit.c.after,
                    super_admin_audit.c.created_at,
                )
                .where(super_admin_audit.c.tenant_id == tenant_id)
                .order_by(super_admin_audit.c.created_at.desc())
                .limit(20)
            ).all()
            recent_audit = [
                {
                    "id": int(a.id),
                    "super_admin_user_id": int(a.super_admin_user_id),
                    "action": str(a.action),
                    "entity_type": str(a.entity_type),
                    "entity_id": a.entity_id,
                    "after": a.after,
                    "created_at": a.created_at.isoformat(),
                }
                for a in audit_rows
            ]

    return TenantDetail(
        id=int(row.id),
        name=str(row.name),
        slug=str(row.slug),
        schema_name=schema_name,
        status=str(row.status),
        created_at=row.created_at.isoformat(),
        admin_count=admin_count,
        employee_count=employee_count,
        admin_users=admin_users,
        recent_super_admin_audit=recent_audit,
    )


def update_tenant_status(
    engine: Engine, *, tenant_id: int, new_status: str
) -> Optional[dict]:
    """Toggle ``public.tenants.status``. Returns the updated row or None.

    Caller is responsible for the audit write (we keep the DB write
    isolated here so dual-audit failures don't poison the status flip).
    """

    if new_status not in ("active", "suspended"):
        raise ValueError(f"invalid status {new_status!r}")
    with tenant_context("public"):
        with engine.begin() as conn:
            row = conn.execute(
                select(tenants.c.id, tenants.c.status).where(tenants.c.id == tenant_id)
            ).first()
            if row is None:
                return None
            old_status = str(row.status)
            conn.execute(
                tenants.update()
                .where(tenants.c.id == tenant_id)
                .values(status=new_status)
            )
    return {"id": tenant_id, "old_status": old_status, "new_status": new_status}
