"""FastAPI app factory for Hadir.

P1 exposes only `GET /api/health`. Subsequent pilot prompts (P2+) attach
auth, employees, cameras, capture, attendance, etc. under the same `/api`
prefix.
"""

from __future__ import annotations

import logging
import sys

from fastapi import FastAPI

from hadir import __version__
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


def create_app() -> FastAPI:
    """Build the FastAPI application instance."""

    _configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="Hadir API",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        """Liveness probe used by docker-compose, the frontend, and ops checks."""

        return {"status": "ok"}

    logging.getLogger(__name__).info(
        "Hadir backend started (env=%s, tenant_mode=%s)", settings.env, settings.tenant_mode
    )
    return app


app = create_app()
