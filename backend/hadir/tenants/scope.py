"""TenantScope dependency.

Every tenant-scoped repository function accepts a ``TenantScope`` argument
and uses ``scope.tenant_id`` in its ``WHERE`` clause. The scope is resolved
by a FastAPI dependency that reads the current session (populated in P3)
and falls back to the pilot default (``HADIR_DEFAULT_TENANT_ID``, which is
``1``).

This split — scope resolution vs. scope use — is deliberate. In v1.0 the
resolver swaps to session-driven or host-driven lookup; the repositories
it feeds do not change.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from hadir.config import get_settings


@dataclass(frozen=True, slots=True)
class TenantScope:
    """Active tenant for the current request or background job.

    Repositories MUST filter every query on ``self.tenant_id``; there is no
    "cross-tenant" access path in the application code, even for admins.
    Cross-tenant support for Super-Admins (PROJECT_CONTEXT §4) is a v1.0
    concern and will introduce an explicit elevated scope type.
    """

    tenant_id: int


def get_tenant_scope(request: Request) -> TenantScope:
    """FastAPI dependency producing the ``TenantScope`` for this request.

    Resolution order:

    1. ``request.state.tenant_id`` — set by the session middleware in P3.
    2. ``HADIR_DEFAULT_TENANT_ID`` from settings (pilot default is ``1``).

    The default-lookup branch is **pilot-only**. v1.0 raises on a missing
    session-sourced tenant rather than silently defaulting.
    """

    tenant_id = getattr(request.state, "tenant_id", None)
    if tenant_id is None:
        tenant_id = get_settings().default_tenant_id
    return TenantScope(tenant_id=int(tenant_id))
