"""Authentication: local password login, server-side sessions, role guards.

Scope is pilot-only (PROJECT_CONTEXT §8). Entra ID OIDC, 2FA, and HTTPS
certificates are v1.0 concerns and do not belong in this module.

The public surface deliberately stays narrow — the router, the dependencies,
and the ``CurrentUser`` type. Internal helpers (session storage, audit
writer, rate limiter) are accessed through those and not imported directly
from request handlers.
"""

from maugood.auth.dependencies import (
    CurrentUser,
    current_user,
    require_any_role,
    require_department,
    require_role,
)
from maugood.auth.ratelimit import LoginRateLimiter, get_rate_limiter
from maugood.auth.router import router

__all__ = [
    "CurrentUser",
    "LoginRateLimiter",
    "current_user",
    "get_rate_limiter",
    "require_any_role",
    "require_department",
    "require_role",
    "router",
]
