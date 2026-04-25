"""TenantScopeMiddleware — sets the per-request tenant search_path.

Runs on every HTTP request. The pilot's single-tenant DB stays on
``main``; the v1.0 multi-tenant flow drives this off the
``user_sessions.data`` JSONB claim that login wrote.

Design choice (per pilot-plan §"Document the choice in
backend/CLAUDE.md"): we use **SQLAlchemy events** (``checkout``) to
apply ``SET search_path`` rather than a per-route DI dependency. The
middleware here only sets a ContextVar; the event listener consumes
it transparently for every connection borrowed from the pool. That
keeps existing route handlers untouched (they just call
``with engine.begin() as conn`` as before) and removes the risk of a
new endpoint forgetting a tenant-scope dep.

Resolution order:

1. ``user_sessions.data.impersonated_tenant_id`` — Super-Admin
   impersonation hook (UI lands in v1.0 P3). If present, the schema
   resolves from *that* tenant id, not the user's home tenant.
2. ``user_sessions.data.tenant_schema`` — claim written at login.
3. Single-tenant fallback (``main``).
4. Multi-tenant + no claim → leave the ContextVar unset; the
   connection checkout will fail-closed on the next DB call.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from hadir.config import get_settings
from hadir.db import (
    DEFAULT_SCHEMA,
    get_engine,
    set_tenant_schema,
    tenant_context,
    user_sessions,
)
from hadir.tenants.scope import resolve_tenant_schema

logger = logging.getLogger(__name__)


class TenantScopeMiddleware(BaseHTTPMiddleware):
    """ASGI middleware that resolves tenant_schema for the request scope."""

    def __init__(self, app: ASGIApp, *, cookie_name: Optional[str] = None) -> None:
        super().__init__(app)
        # Resolved lazily on first dispatch so settings overrides in
        # tests propagate correctly.
        self._cookie_name = cookie_name

    async def dispatch(self, request, call_next):  # type: ignore[no-untyped-def]
        cookie_name = self._cookie_name or get_settings().session_cookie_name
        session_id = request.cookies.get(cookie_name)
        resolved_schema, resolved_tenant_id = self._resolve(session_id)

        token = set_tenant_schema(resolved_schema)
        # Surface on request.state so existing deps (get_tenant_scope)
        # find them where the pilot already looks.
        if resolved_tenant_id is not None:
            request.state.tenant_id = resolved_tenant_id
        if resolved_schema is not None:
            request.state.tenant_schema = resolved_schema
        try:
            return await call_next(request)
        finally:
            # Always reset, even on exceptions, so a worker thread that
            # serviced the request doesn't carry the schema into the
            # next one.
            from hadir.db import reset_tenant_schema  # noqa: PLC0415

            reset_tenant_schema(token)

    # ------------------------------------------------------------------

    def _resolve(self, session_id: Optional[str]) -> tuple[Optional[str], Optional[int]]:
        """Return ``(tenant_schema, tenant_id)`` for the request.

        ``tenant_schema`` of ``None`` means "let the connection-checkout
        event apply the single-mode default or fail-closed in multi
        mode" — we never short-circuit that decision here.
        """

        settings = get_settings()
        if not session_id:
            # Anonymous request (login form, /health, /docs).
            # Single mode: connection checkout will default to ``main``.
            # Multi mode: any DB-touching anonymous endpoint is broken
            # by design until we have a tenant claim — fail-closed.
            return (DEFAULT_SCHEMA if settings.tenant_mode == "single" else None, None)

        engine = get_engine()
        # Read the session row under a known-good schema (``main``) —
        # in multi mode P2 will move ``user_sessions`` to a global
        # ``public`` schema; for P1 the session table lives where the
        # pilot put it.
        with tenant_context("main"):
            try:
                with engine.begin() as conn:
                    row = conn.execute(
                        select(
                            user_sessions.c.user_id,
                            user_sessions.c.tenant_id,
                            user_sessions.c.data,
                        ).where(user_sessions.c.id == session_id)
                    ).first()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TenantScopeMiddleware: session lookup failed: %s",
                    type(exc).__name__,
                )
                return (
                    DEFAULT_SCHEMA if settings.tenant_mode == "single" else None,
                    None,
                )

        if row is None:
            return (
                DEFAULT_SCHEMA if settings.tenant_mode == "single" else None,
                None,
            )

        data = row.data or {}
        impersonated = data.get("impersonated_tenant_id")
        # Super-Admin impersonation overrides the home tenant. The UI
        # for setting this lands in v1.0 P3; the hook is here so we
        # don't have to revisit middleware code then.
        if impersonated is not None:
            try:
                impersonated_id = int(impersonated)
            except (TypeError, ValueError):
                impersonated_id = None
            if impersonated_id is not None:
                # Resolve the impersonated tenant's schema. Done under
                # ``main`` because the tenants registry lives there.
                with tenant_context("main"):
                    with engine.begin() as conn:
                        impersonated_schema = resolve_tenant_schema(
                            conn, impersonated_id
                        )
                return (impersonated_schema, impersonated_id)

        # Normal path: trust the claim written at login.
        claim_schema = data.get("tenant_schema")
        if isinstance(claim_schema, str) and claim_schema:
            return (claim_schema, int(row.tenant_id))

        # Old session predating the claim (or test-seeded). Resolve
        # from the registry once; login refresh will populate the claim
        # next time around.
        with tenant_context("main"):
            with engine.begin() as conn:
                schema = resolve_tenant_schema(conn, int(row.tenant_id))
        return (schema, int(row.tenant_id))
