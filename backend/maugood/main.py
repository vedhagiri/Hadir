"""FastAPI app factory for Maugood.

P1 exposed ``GET /api/health``. P2 added the schema. P3 adds the auth
router (``/api/auth/*``), server-side sessions, role guards, and the
login rate limiter (started as a background job on app startup).

Subsequent pilot prompts (P5+) attach employees, cameras, capture,
attendance, etc. under the same ``/api`` prefix.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from maugood import __version__
from maugood.attendance import attendance_scheduler
from maugood.attendance.router import router as attendance_router
from maugood.audit_log.router import router as audit_log_router
from maugood.auth import get_rate_limiter
from maugood.auth import router as auth_router
from maugood.auth.oidc import router as oidc_router
from maugood.branding.router import (
    router as branding_router,
    super_admin_router as branding_super_admin_router,
)
from maugood.attendance_calendar import router as attendance_calendar_router
from maugood.cameras.router import router as cameras_router
from maugood.capture import capture_manager
from maugood.config import get_settings
from maugood.custom_fields import router as custom_fields_router
from maugood.detection_events.router import router as detection_events_router
from maugood.employees import router as employees_router
from maugood.employees.delete_requests import router as delete_requests_router
from maugood.employees.lifecycle_cron import lifecycle_scheduler
from maugood.identification.router import router as identification_router
from maugood.leave_calendar import router as leave_calendar_router
from maugood.live_capture import router as live_capture_router
from maugood.manager_assignments import router as manager_assignments_router
from maugood.policies import router as policies_router
from maugood.reporting.former_employees import router as former_employees_router
from maugood.reporting.router import router as reporting_router
from maugood.requests import (
    reason_categories_router as request_reason_categories_router,
    router as requests_router,
)
from maugood.erp_export import router as erp_export_router
from maugood.notifications import (
    notification_worker,
    router as notifications_router,
)
from maugood.operations import router as operations_router
from maugood.face_crops import router as face_crops_router
from maugood.person_clips import router as person_clips_router
from maugood.clip_pipeline.router import router as clip_pipeline_router
from maugood.pipeline_monitor import router as pipeline_monitor_router
from maugood.retention import retention_scheduler
from maugood.scheduled_reports import (
    report_runner,
    router as scheduled_reports_router,
)
from maugood.super_admin import router as super_admin_router
from maugood.super_admin.system import router as super_admin_system_router
from maugood.system.router import router as system_router
from maugood.departments_router import router as departments_router
from maugood.divisions_router import router as divisions_router
from maugood.sections_router import router as sections_router
from maugood.users_lookup import router as users_lookup_router


def _configure_logging() -> None:
    """Configure root + audit loggers per ``maugood.logging_config``.

    The implementation moved to ``maugood.logging_config`` in P25 so
    log rotation + the dedicated audit file have a single owner.
    Docker captures stdout regardless; the file handlers ship to
    ``backend/logs/{app,audit}.log`` for off-container retention.
    Sensitive fields (passwords, RTSP URLs) never reach any of
    these handlers — see PROJECT_CONTEXT §12.
    """

    from maugood.logging_config import configure_logging  # noqa: PLC0415

    configure_logging()


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

    from maugood.db import make_engine as _make_engine
    from maugood.identification import enrollment as _enrollment
    from maugood.tenants.scope import TenantScope as _TenantScope

    def _run_backfill() -> None:
        from maugood.db import tenant_context as _tenant_context  # noqa: PLC0415

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
    notification_worker.start()
    retention_scheduler.start()
    lifecycle_scheduler.start()
    # Queue-based clip-processing pipeline (cropping + matching
    # workers). Side-by-side with the legacy ReprocessFaceMatchWorker
    # path — operators submit batches via /api/clip-pipeline/submit.
    from maugood.clip_pipeline import clip_pipeline  # noqa: PLC0415
    clip_pipeline.start()
    try:
        yield
    finally:
        # Stop capture first so workers don't try to write after the
        # engine pool starts draining.
        capture_manager.stop()
        attendance_scheduler.stop()
        report_runner.stop()
        notification_worker.stop()
        retention_scheduler.stop()
        lifecycle_scheduler.stop()
        clip_pipeline.stop()
        limiter.stop()


def create_app() -> FastAPI:
    """Build the FastAPI application instance."""

    _configure_logging()
    settings = get_settings()

    # P23 red line: refuse to boot in production unless every TLS
    # prerequisite is in place. ``ProductionConfigError`` takes the
    # process down before a single request is served.
    from maugood.security import (  # noqa: PLC0415
        HttpsEnforceMiddleware,
        SecurityHeadersMiddleware,
        check_production_config,
    )

    check_production_config(settings)

    app = FastAPI(
        title="Maugood API",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    # Middleware order in Starlette is "last added, first run".
    # Outermost (proxy headers) → HTTPS gate → CORS → security
    # headers → tenant scope → handler.
    from maugood.tenants.middleware import TenantScopeMiddleware  # noqa: PLC0415

    app.add_middleware(TenantScopeMiddleware)

    # P26: Prometheus instrumentation. The instrumentator
    # auto-wraps every handler with a request-duration histogram
    # plus a status-code counter. ``/metrics`` is exposed on the
    # same FastAPI app, but ``ops/nginx/maugood.conf.template`` does
    # NOT proxy ``/metrics`` to the public internet — Prometheus
    # scrapes it over the private ``maugood-internal`` docker
    # network. Internal-only is the load-bearing red line.
    try:
        from prometheus_fastapi_instrumentator import (  # noqa: PLC0415
            Instrumentator,
        )

        instrumentator = Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            should_respect_env_var=False,
            excluded_handlers=["/metrics"],
        )
        instrumentator.instrument(app).expose(
            app,
            endpoint="/metrics",
            include_in_schema=False,
            tags=["internal"],
        )
    except ImportError:
        logging.getLogger(__name__).warning(
            "prometheus-fastapi-instrumentator not installed; /metrics off"
        )

    # Security headers stamp on every response (defence in depth —
    # nginx adds the same headers, but the backend stays safe even
    # if a future deployment fronts it differently).
    if settings.env != "dev":
        app.add_middleware(
            SecurityHeadersMiddleware,
            hsts_max_age=settings.hsts_max_age_seconds,
        )

    # P23: CORS. Empty allowlist = no headers added (which is what
    # nginx fronting + the Vite dev proxy both want). Operators
    # who serve the API from a different origin in production set
    # ``MAUGOOD_ALLOWED_ORIGINS`` to a comma-separated list.
    if settings.allowed_origins:
        from fastapi.middleware.cors import CORSMiddleware  # noqa: PLC0415

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.allowed_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type", "Authorization"],
            max_age=600,
        )

    # P23 red line, in-band: refuse plain-HTTP in production. The
    # gate trusts ``request.url.scheme`` which Starlette resolves
    # via ``ProxyHeadersMiddleware`` below.
    if settings.env == "production":
        app.add_middleware(HttpsEnforceMiddleware)

    # ProxyHeadersMiddleware must run as the outermost layer so
    # every downstream middleware sees the rewritten scheme/host.
    if settings.behind_proxy:
        from uvicorn.middleware.proxy_headers import (  # noqa: PLC0415
            ProxyHeadersMiddleware,
        )

        app.add_middleware(
            ProxyHeadersMiddleware,
            trusted_hosts=settings.forwarded_allow_ips,
        )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        """Liveness probe used by docker-compose, the frontend, and ops checks."""

        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(employees_router)
    app.include_router(delete_requests_router)
    app.include_router(cameras_router)
    app.include_router(identification_router)
    app.include_router(attendance_router)
    app.include_router(attendance_calendar_router)
    app.include_router(detection_events_router)
    app.include_router(system_router)
    app.include_router(users_lookup_router)
    app.include_router(departments_router)
    app.include_router(divisions_router)
    app.include_router(sections_router)
    app.include_router(audit_log_router)
    app.include_router(reporting_router)
    app.include_router(former_employees_router)
    app.include_router(super_admin_router)
    app.include_router(super_admin_system_router)
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
    app.include_router(notifications_router)
    app.include_router(live_capture_router)
    app.include_router(operations_router)
    app.include_router(person_clips_router)
    app.include_router(clip_pipeline_router)
    app.include_router(pipeline_monitor_router)
    app.include_router(face_crops_router)

    # Dev-only test endpoints — used by the Playwright smoke test in
    # frontend/tests/. Mounted ONLY when MAUGOOD_ENV=dev so a production
    # build can never serve these paths even by accident.
    if settings.env == "dev":
        from maugood._test_endpoints.router import (  # noqa: PLC0415
            router as _test_router,
        )

        app.include_router(_test_router)
        logging.getLogger(__name__).info(
            "DEV-ONLY /api/_test endpoints mounted (MAUGOOD_ENV=dev)"
        )

    logging.getLogger(__name__).info(
        "Maugood backend started (env=%s, tenant_mode=%s)", settings.env, settings.tenant_mode
    )
    return app


app = create_app()
