"""TenantScope dependency.

Every tenant-scoped repository function accepts a ``TenantScope`` argument
and uses ``scope.tenant_id`` in its ``WHERE`` clause. The scope is resolved
by a FastAPI dependency that reads the current session (populated by the
``TenantScopeMiddleware`` from v1.0 P1) and falls back to the pilot
default (``MAUGOOD_DEFAULT_TENANT_ID``, ``1``) in single-tenant mode.

This split — scope resolution vs. scope use — is deliberate. v1.0
multi-tenant resolves the scope from the session's ``tenant_id`` /
``tenant_schema`` claims; the repositories it feeds don't change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.engine import Connection, Engine

from maugood.config import get_settings


@dataclass(frozen=True, slots=True)
class TenantScope:
    """Active tenant for the current request or background job.

    Repositories MUST filter every query on ``self.tenant_id``; there is no
    "cross-tenant" access path in the application code, even for admins.
    Cross-tenant support for Super-Admins (PROJECT_CONTEXT §4) lands in
    v1.0 P3 and will introduce an explicit elevated scope type — until
    then, the only field is ``tenant_id`` plus the resolved Postgres
    schema this tenant's data lives in.
    """

    tenant_id: int
    tenant_schema: str = "main"


def resolve_tenant_schema(
    conn: Connection, tenant_id: int, *, default: str = "main"
) -> str:
    """Look up ``tenants.schema_name`` for ``tenant_id``.

    Returns ``default`` if the tenant row doesn't carry a schema_name
    (shouldn't happen post-migration 0007, but tolerated for safety).
    """

    # Local import to avoid a circular dependency at module load time.
    from maugood.db import tenants  # noqa: PLC0415

    row = conn.execute(
        select(tenants.c.schema_name).where(tenants.c.id == tenant_id)
    ).first()
    if row is None or row.schema_name is None:
        return default
    return str(row.schema_name)


def resolve_tenant_schema_via_engine(engine: Engine, tenant_id: int) -> str:
    """Convenience wrapper for the (rare) call sites without a Connection.

    Used by the lifespan startup tasks and the workers — they don't have
    a request-scoped connection to hand and just want the tenant's
    schema name once at construction time.
    """

    # The lookup itself happens under the *previous* search_path. In
    # single mode that's ``main`` (the pilot default); in multi mode the
    # caller must already have a tenant context set, which is what the
    # workers do. We fall back to ``main`` if no row matches because the
    # alternative — silently returning a wrong schema — is worse.
    from maugood.db import tenant_context  # noqa: PLC0415

    with tenant_context("main"):
        with engine.begin() as conn:
            return resolve_tenant_schema(conn, tenant_id)


def get_tenant_scope(request: Request) -> TenantScope:
    """FastAPI dependency producing the ``TenantScope`` for this request.

    Resolution order:

    1. ``request.state.tenant_id`` / ``request.state.tenant_schema`` — set
       by the ``TenantScopeMiddleware`` from the session claim in v1.0 P1.
    2. ``MAUGOOD_DEFAULT_TENANT_ID`` from settings (pilot default is ``1``)
       and the configured default schema (``main``) for single-tenant
       fallback.

    The default-lookup branch is the pilot-compatibility path. In v1.0
    multi-mode the middleware always sets ``tenant_id`` / ``tenant_schema``
    on ``request.state`` for authenticated requests, and the connection
    checkout event fails closed on missing tenant context.
    """

    tenant_id: Optional[int] = getattr(request.state, "tenant_id", None)
    tenant_schema: Optional[str] = getattr(request.state, "tenant_schema", None)

    if tenant_id is None:
        tenant_id = get_settings().default_tenant_id
    if tenant_schema is None:
        tenant_schema = "main"

    return TenantScope(tenant_id=int(tenant_id), tenant_schema=str(tenant_schema))
