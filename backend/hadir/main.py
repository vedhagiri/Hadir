"""FastAPI app factory for Hadir.

P1 exposed ``GET /api/health``. P2 added the schema. P3 adds the auth
router (``/api/auth/*``), server-side sessions, role guards, and the
login rate limiter (started as a background job on app startup).

Subsequent pilot prompts (P5+) attach employees, cameras, capture,
attendance, etc. under the same ``/api`` prefix.
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from hadir import __version__
from hadir.attendance import attendance_scheduler
from hadir.attendance.router import router as attendance_router
from hadir.audit_log.router import router as audit_log_router
from hadir.auth import get_rate_limiter
from hadir.auth import router as auth_router
from hadir.auth.oidc import router as oidc_router
from hadir.branding.router import (
    router as branding_router,
    super_admin_router as branding_super_admin_router,
)
from hadir.cameras.router import router as cameras_router
from hadir.capture import capture_manager
from hadir.config import get_settings
from hadir.custom_fields import router as custom_fields_router
from hadir.detection_events.router import router as detection_events_router
from hadir.employees import router as employees_router
from hadir.identification.router import router as identification_router
from hadir.leave_calendar import router as leave_calendar_router
from hadir.manager_assignments import router as manager_assignments_router
from hadir.policies import router as policies_router
from hadir.reporting.router import router as reporting_router
from hadir.requests import (
    reason_categories_router as request_reason_categories_router,
    router as requests_router,
)
from hadir.erp_export import router as erp_export_router
from hadir.scheduled_reports import (
    report_runner,
    router as scheduled_reports_router,
)
from hadir.super_admin import router as super_admin_router
from hadir.system.router import router as system_router


def _configure_logging() -> None:
    """Send all logs to stdout in a uniform format.

    Docker captures stdout, so structured shipping (Loki/Cloud Logging) works
    out of the box. We avoid logging sensitive fields (passwords, RTSP URLs)
    anywhere in the codebase — see PROJECT_CONTEXT §12.
    """

    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root.addHandler(handler)
    root.setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Start the background rate-limit reset job; stop it on shutdown."""

    limiter = get_rate_limiter()
    limiter.start()

    # Kick off enrollment backfill in a daemon thread so the HTTP server
    # comes up immediately even when there are many photos to embed.
    # Failures here (no InsightFace, no photos) log and die silently —
    # the matcher cache loads lazily on first use either way.
    import threading as _threading

    from hadir.db import make_engine as _make_engine
    from hadir.identification import enrollment as _enrollment
    from hadir.tenants.scope import TenantScope as _TenantScope

    def _run_backfill() -> None:
        from hadir.db import tenant_context as _tenant_context  # noqa: PLC0415

        try:
            scope = _TenantScope(tenant_id=get_settings().default_tenant_id)
            with _tenant_context(scope.tenant_schema):
                _enrollment.enroll_missing(_make_engine(), scope)
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).warning(
                "identification backfill failed: %s", type(exc).__name__
            )

    _threading.Thread(
        target=_run_backfill, name="enroll-backfill", daemon=True
    ).start()

    capture_manager.start()
    attendance_scheduler.start()
    report_runner.start()
    try:
        yield
    finally:
        # Stop capture first so workers don't try to write after the
        # engine pool starts draining.
        capture_manager.stop()
        attendance_scheduler.stop()
        report_runner.stop()
        limiter.stop()


def create_app() -> FastAPI:
    """Build the FastAPI application instance."""

    _configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="Hadir API",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    # Tenant routing — must run before any handler that touches the DB.
    # Middleware order in Starlette is "last added, first run", so this
    # add_middleware call wraps everything attached afterward.
    from hadir.tenants.middleware import TenantScopeMiddleware  # noqa: PLC0415

    app.add_middleware(TenantScopeMiddleware)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        """Liveness probe used by docker-compose, the frontend, and ops checks."""

        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(employees_router)
    app.include_router(cameras_router)
    app.include_router(identification_router)
    app.include_router(attendance_router)
    app.include_router(detection_events_router)
    app.include_router(system_router)
    app.include_router(audit_log_router)
    app.include_router(reporting_router)
    app.include_router(super_admin_router)
    app.include_router(branding_router)
    app.include_router(branding_super_admin_router)
    app.include_router(oidc_router)
    app.include_router(manager_assignments_router)
    app.include_router(policies_router)
    app.include_router(leave_calendar_router)
    app.include_router(custom_fields_router)
    app.include_router(requests_router)
    app.include_router(request_reason_categories_router)
    app.include_router(scheduled_reports_router)
    app.include_router(erp_export_router)

    # Dev-only test endpoints — used by the Playwright smoke test in
    # frontend/tests/. Mounted ONLY when HADIR_ENV=dev so a production
    # build can never serve these paths even by accident.
    if settings.env == "dev":
        from hadir._test_endpoints.router import (  # noqa: PLC0415
            router as _test_router,
        )

        app.include_router(_test_router)
        logging.getLogger(__name__).info(
            "DEV-ONLY /api/_test endpoints mounted (HADIR_ENV=dev)"
        )

    logging.getLogger(__name__).info(
        "Hadir backend started (env=%s, tenant_mode=%s)", settings.env, settings.tenant_mode
    )
    return app


app = create_app()
