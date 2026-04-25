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
from hadir.cameras.router import router as cameras_router
from hadir.capture import capture_manager
from hadir.config import get_settings
from hadir.detection_events.router import router as detection_events_router
from hadir.employees import router as employees_router
from hadir.identification.router import router as identification_router
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
        try:
            scope = _TenantScope(tenant_id=get_settings().default_tenant_id)
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
    try:
        yield
    finally:
        # Stop capture first so workers don't try to write after the
        # engine pool starts draining.
        capture_manager.stop()
        attendance_scheduler.stop()
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

    logging.getLogger(__name__).info(
        "Hadir backend started (env=%s, tenant_mode=%s)", settings.env, settings.tenant_mode
    )
    return app


app = create_app()
