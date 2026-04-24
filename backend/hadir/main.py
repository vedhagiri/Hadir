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
from hadir.auth import get_rate_limiter
from hadir.auth import router as auth_router
from hadir.config import get_settings


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
    try:
        yield
    finally:
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

    logging.getLogger(__name__).info(
        "Hadir backend started (env=%s, tenant_mode=%s)", settings.env, settings.tenant_mode
    )
    return app


app = create_app()
