"""HTTPS + reverse-proxy hardening (v1.0 P23).

Three responsibilities:

1. ``check_production_config`` — fail-fast at app startup when
   ``HADIR_ENV=production`` and the config isn't HTTPS-ready
   (cookie-secure off, no proxy header trust, no allowed origins,
   placeholder secrets, plain-HTTP redirect base URL).
2. ``HttpsEnforceMiddleware`` — refuse plain-HTTP requests in
   production with HTTP 421 (Misdirected Request). Reads
   ``request.url.scheme`` which Starlette resolves from
   ``X-Forwarded-Proto`` once ``ProxyHeadersMiddleware`` is in
   place. Health check is exempt so an internal LB probing
   over HTTP doesn't get bounced.
3. ``SecurityHeadersMiddleware`` — adds HSTS, X-Frame-Options,
   X-Content-Type-Options, Referrer-Policy, and a minimal
   Permissions-Policy on every response. nginx in
   ``docker/nginx/hadir.conf`` ships the same headers — keeping
   them on the backend too means the API is safe even if
   somebody fronts it with a different proxy.

The middleware is mounted in ``hadir.main.create_app`` only when
``settings.env != "dev"`` — dev stays plain HTTP per the prompt.
"""

from __future__ import annotations

import logging
from typing import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from hadir.config import Settings

logger = logging.getLogger(__name__)


# Settings keys whose default values are obvious placeholders. If
# any of these is still set when ``env=production``, refuse to
# boot. The list is small on purpose — these are the secrets
# whose leakage would be hardest to recover from.
_PLACEHOLDER_SECRETS: dict[str, str] = {
    "session_secret": "dev-session-secret-change-me",
    "fernet_key": "dev-fernet-key-change-me",
    "auth_fernet_key": "dev-auth-fernet-key-change-me",
    "report_signed_url_secret": "dev-report-signed-url-secret-change-me",
}


class ProductionConfigError(RuntimeError):
    """Raised when ``HADIR_ENV=production`` boots with unsafe config."""


def check_production_config(settings: Settings) -> None:
    """Fail-fast guard for production deployments.

    The whole point is **never** allow a production process to
    serve a request unless TLS is in front of it. Mismatches here
    raise ``ProductionConfigError`` before any router is mounted —
    the container exits non-zero and supervisord/systemd surfaces
    the failure.
    """

    if settings.env != "production":
        return

    failures: list[str] = []

    if not settings.session_cookie_secure:
        failures.append(
            "HADIR_SESSION_COOKIE_SECURE must be 'true' in production "
            "(session cookies will not survive an HTTPS-only client)"
        )

    if not settings.behind_proxy:
        failures.append(
            "HADIR_BEHIND_PROXY must be 'true' in production "
            "(otherwise X-Forwarded-Proto isn't honoured and the "
            "HTTPS gate cannot tell encrypted requests from plain ones)"
        )

    if not settings.allowed_origins:
        failures.append(
            "HADIR_ALLOWED_ORIGINS must list at least one origin in "
            "production (e.g. https://hadir.example.com)"
        )

    base = (settings.oidc_redirect_base_url or "").lower()
    if base and not base.startswith("https://"):
        failures.append(
            f"HADIR_OIDC_REDIRECT_BASE_URL must start with https:// in "
            f"production (got {settings.oidc_redirect_base_url!r})"
        )

    for attr, placeholder in _PLACEHOLDER_SECRETS.items():
        value = getattr(settings, attr, None)
        if value == placeholder:
            failures.append(
                f"HADIR_{attr.upper()} is still set to the dev placeholder; "
                "rotate before serving production traffic"
            )

    if failures:
        bullet = "\n  - ".join(failures)
        raise ProductionConfigError(
            "Refusing to start: HADIR_ENV=production but the following "
            "configuration is unsafe:\n  - " + bullet
        )


# Paths exempt from the HTTPS gate. ``/api/health`` is reached by
# the docker-compose healthcheck on the private network and by
# load-balancer probes that may target HTTP intentionally.
_HTTPS_EXEMPT_PATHS: frozenset[str] = frozenset({"/api/health"})


class HttpsEnforceMiddleware(BaseHTTPMiddleware):
    """Block plain-HTTP requests when ``env=production``.

    ``request.url.scheme`` is what Starlette resolves *after*
    ``ProxyHeadersMiddleware`` reads ``X-Forwarded-Proto``, so a
    request that arrived over TLS at nginx and got proxied as HTTP
    on the private network still reads as ``https`` here.

    The 421 status means "this server can't authoritatively
    answer over plain HTTP" — better than 400 because the client
    knows to retry over TLS.
    """

    def __init__(self, app, *, exempt_paths: Iterable[str] | None = None):
        super().__init__(app)
        self._exempt = frozenset(exempt_paths or _HTTPS_EXEMPT_PATHS)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self._exempt:
            return await call_next(request)
        scheme = request.url.scheme
        if scheme != "https":
            logger.warning(
                "rejected non-HTTPS request: scheme=%s path=%s",
                scheme,
                request.url.path,
            )
            return JSONResponse(
                {
                    "detail": (
                        "HTTPS required. Reconnect using https:// — this "
                        "endpoint will not answer over plain HTTP in "
                        "production."
                    )
                },
                status_code=421,
            )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Stamp response headers nginx normally adds — defence in depth."""

    def __init__(self, app, *, hsts_max_age: int = 31536000):
        super().__init__(app)
        self._hsts = (
            f"max-age={int(hsts_max_age)}; includeSubDomains; preload"
        )

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("Strict-Transport-Security", self._hsts)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Referrer-Policy", "strict-origin-when-cross-origin"
        )
        # Minimal Permissions-Policy — explicitly disables features
        # the app does not use. Operators that need a feature
        # (e.g. camera for in-browser enrollment) override here.
        response.headers.setdefault(
            "Permissions-Policy",
            "geolocation=(), microphone=(), camera=(), payment=()",
        )
        return response
