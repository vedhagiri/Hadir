"""TenantScopeMiddleware — sets the per-request tenant search_path.

Runs on every HTTP request. Resolution priority:

1. **Super-Admin session with active impersonation** (P3): the
   ``hadir_super_session`` cookie maps to a row in
   ``public.super_admin_sessions`` whose ``data.impersonated_tenant_id``
   is set. The schema resolves from ``public.tenants`` for that
   tenant and the request runs under it. ``request.state`` carries
   ``is_super_admin=True`` and ``super_admin_user_id`` so the
   per-tenant audit writes can dual-log the action.
2. **Super-Admin session without impersonation** (P3): cookie present
   but no impersonation claim. Schema is set to ``public`` so the
   console's tenants-list / detail queries land. The request cannot
   write to any per-tenant table — there is no tenant in scope, and
   the per-tenant writes always go through ``current_user`` which
   is a synthetic super-admin only when impersonating.
3. **Tenant session** (P1): ``hadir_session`` cookie maps to
   ``user_sessions``. We read it under the user's home tenant schema
   (carried on the session's ``data.tenant_schema`` claim).
4. **Anonymous** (login form, ``/health``): single mode defaults to
   ``main``, multi mode fails closed at connection checkout.

Design choice: SQLAlchemy ``checkout`` event applies the
``SET search_path`` per-pool-checkout based on a Python ContextVar.
The middleware's only job is to set that ContextVar — every
``engine.begin()`` borrowed inside the request inherits the schema
without per-route DI. Background workers + lifespan tasks set the
ContextVar themselves via ``hadir.db.tenant_context``.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from hadir.auth.audit import (
    reset_super_admin_audit_context,
    set_super_admin_audit_context,
)
from hadir.config import get_settings
from hadir.db import (
    DEFAULT_SCHEMA,
    get_engine,
    set_tenant_schema,
    super_admin_sessions,
    tenant_context,
    user_sessions,
)
from hadir.tenants.scope import resolve_tenant_schema

logger = logging.getLogger(__name__)


class TenantScopeMiddleware(BaseHTTPMiddleware):
    """ASGI middleware that resolves tenant_schema for the request scope."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        cookie_name: Optional[str] = None,
        super_cookie_name: str = "hadir_super_session",
    ) -> None:
        super().__init__(app)
        self._cookie_name = cookie_name
        self._super_cookie_name = super_cookie_name

    async def dispatch(self, request, call_next):  # type: ignore[no-untyped-def]
        cookie_name = self._cookie_name or get_settings().session_cookie_name
        tenant_session_id = request.cookies.get(cookie_name)
        super_session_id = request.cookies.get(self._super_cookie_name)

        resolved = self._resolve(
            super_session_id=super_session_id,
            tenant_session_id=tenant_session_id,
            request=request,
        )
        resolved_schema = resolved["schema"]
        resolved_tenant_id = resolved["tenant_id"]

        token = set_tenant_schema(resolved_schema)
        # Stash the client IP so audit dual-write can carry it on the
        # operator-log row.
        client = request.client
        request.state.client_ip = client.host if client is not None else None
        if resolved_tenant_id is not None:
            request.state.tenant_id = resolved_tenant_id
        if resolved_schema is not None:
            request.state.tenant_schema = resolved_schema
        if resolved.get("is_super_admin"):
            request.state.is_super_admin = True
        if resolved.get("super_admin_user_id") is not None:
            request.state.super_admin_user_id = resolved["super_admin_user_id"]
        if resolved.get("impersonated_tenant_id") is not None:
            request.state.impersonated_tenant_id = resolved["impersonated_tenant_id"]

        # P3 dual-audit: only when a Super-Admin is *actively
        # impersonating* — bare console reads/writes (no impersonation)
        # don't dual-log because they don't touch tenant data.
        audit_token = None
        if resolved.get("impersonated_tenant_id") is not None:
            audit_token = set_super_admin_audit_context(
                super_admin_user_id=resolved["super_admin_user_id"],
                ip=request.state.client_ip,
            )

        try:
            return await call_next(request)
        finally:
            from hadir.db import reset_tenant_schema  # noqa: PLC0415

            reset_tenant_schema(token)
            if audit_token is not None:
                reset_super_admin_audit_context(audit_token)

    # ------------------------------------------------------------------

    def _resolve(
        self,
        *,
        super_session_id: Optional[str],
        tenant_session_id: Optional[str],
        request,
    ) -> dict:
        """Return resolution dict — see class docstring for priority."""

        # 1. Super-Admin session takes priority. If present, the tenant
        #    cookie is ignored for this request — operators never act
        #    as their personal tenant user while holding the super
        #    cookie.
        if super_session_id:
            super_resolution = self._resolve_super(super_session_id)
            if super_resolution is not None:
                return super_resolution
            # Super cookie present but invalid: fall through to the
            # tenant cookie (the operator might also have a tenant
            # session for testing). Stale super cookies otherwise lock
            # the user out.

        # 2. Tenant session.
        return self._resolve_tenant(tenant_session_id)

    def _resolve_super(self, super_session_id: str) -> Optional[dict]:
        engine = get_engine()
        # Super-admin tables live in public — pin search_path there.
        with tenant_context("public"):
            try:
                with engine.begin() as conn:
                    row = conn.execute(
                        select(
                            super_admin_sessions.c.id,
                            super_admin_sessions.c.mts_staff_id,
                            super_admin_sessions.c.expires_at,
                            super_admin_sessions.c.data,
                        ).where(super_admin_sessions.c.id == super_session_id)
                    ).first()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "TenantScopeMiddleware: super-session lookup failed: %s",
                    type(exc).__name__,
                )
                return None
        if row is None:
            return None

        data = dict(row.data or {})
        impersonated = data.get("impersonated_tenant_id")
        impersonated_id: Optional[int] = None
        if impersonated is not None:
            try:
                impersonated_id = int(impersonated)
            except (TypeError, ValueError):
                impersonated_id = None

        if impersonated_id is not None:
            # Resolve the impersonated tenant's schema and apply it.
            with tenant_context("public"):
                with engine.begin() as conn:
                    schema = resolve_tenant_schema(conn, impersonated_id)
            return {
                "schema": schema,
                "tenant_id": impersonated_id,
                "is_super_admin": True,
                "super_admin_user_id": int(row.mts_staff_id),
                "impersonated_tenant_id": impersonated_id,
            }

        # Super-admin without impersonation: console-only requests.
        # Schema = "public" so the super-admin endpoints (which read
        # public.tenants, public.super_admin_audit) work; per-tenant
        # endpoints will not have a tenant_id available, so any
        # tenant-scoped DI (current_user) will reject them.
        return {
            "schema": "public",
            "tenant_id": None,
            "is_super_admin": True,
            "super_admin_user_id": int(row.mts_staff_id),
            "impersonated_tenant_id": None,
        }

    def _resolve_tenant(self, session_id: Optional[str]) -> dict:
        settings = get_settings()
        if not session_id:
            return {
                "schema": (
                    DEFAULT_SCHEMA if settings.tenant_mode == "single" else None
                ),
                "tenant_id": None,
            }

        engine = get_engine()
        # The pilot's user_sessions table still lives per-tenant; the
        # one we need (to bootstrap routing) is on ``main`` for the
        # legacy tenant. v1.0 multi-mode session-to-tenant resolution
        # for non-pilot tenants needs a token-with-prefix or a separate
        # cookie carrying the tenant — deferred to a follow-up phase.
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
                return {
                    "schema": (
                        DEFAULT_SCHEMA if settings.tenant_mode == "single" else None
                    ),
                    "tenant_id": None,
                }
        if row is None:
            return {
                "schema": (
                    DEFAULT_SCHEMA if settings.tenant_mode == "single" else None
                ),
                "tenant_id": None,
            }

        data = row.data or {}
        # Note: ``data.impersonated_tenant_id`` on a tenant session
        # remains an optional override hook (for future DBA-style
        # tenant-side impersonation), but the Super-Admin flow now
        # uses the dedicated super cookie + super_admin_sessions table.
        impersonated = data.get("impersonated_tenant_id")
        if impersonated is not None:
            try:
                impersonated_id = int(impersonated)
            except (TypeError, ValueError):
                impersonated_id = None
            if impersonated_id is not None:
                with tenant_context("public"):
                    with engine.begin() as conn:
                        impersonated_schema = resolve_tenant_schema(
                            conn, impersonated_id
                        )
                return {
                    "schema": impersonated_schema,
                    "tenant_id": impersonated_id,
                }

        claim_schema = data.get("tenant_schema")
        if isinstance(claim_schema, str) and claim_schema:
            return {"schema": claim_schema, "tenant_id": int(row.tenant_id)}

        with tenant_context("public"):
            with engine.begin() as conn:
                schema = resolve_tenant_schema(conn, int(row.tenant_id))
        return {"schema": schema, "tenant_id": int(row.tenant_id)}
