"""Tenant scoping.

Pilot runs single-tenant (``tenant_id=1``), but every query against
tenant-scoped tables threads a ``TenantScope`` through the call chain so
the v1.0 multi-tenant migration is additive: the default changes from
``1`` to "pull from session / request host", and the queries don't change.
"""

from hadir.tenants.scope import TenantScope, get_tenant_scope

__all__ = ["TenantScope", "get_tenant_scope"]
