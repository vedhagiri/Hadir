"""Login rate limiter (pilot-grade).

In-memory ``(email, ip) -> attempt count`` counter with a periodic reset
driven by APScheduler. This is **not** production-safe — it has no
cross-process coordination and forgets everything on a restart. Document
that explicitly in ``backend/CLAUDE.md``; v1.0 will replace it with a
Redis-backed bucket that survives restarts and spans workers.

Only *failed* attempts count. A successful login clears the counter for
that key so a legitimate user who typos their password a few times isn't
penalised once they get it right.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class LoginRateLimiter:
    """Thread-safe counter with a scheduler-driven reset."""

    max_attempts: int
    reset_minutes: int
    _counts: dict[tuple[str, str], int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _scheduler: BackgroundScheduler | None = None

    def _key(self, email: str, ip: str) -> tuple[str, str]:
        # Emails are normalised to lowercase at the edge; double-normalise
        # here to protect against a caller forgetting to.
        return (email.strip().lower(), ip)

    def is_blocked(self, email: str, ip: str) -> bool:
        """Return True if further attempts from ``(email, ip)`` should 429."""

        with self._lock:
            return self._counts.get(self._key(email, ip), 0) >= self.max_attempts

    def register_failure(self, email: str, ip: str) -> int:
        """Increment the counter; return the new count."""

        with self._lock:
            key = self._key(email, ip)
            new_value = self._counts.get(key, 0) + 1
            self._counts[key] = new_value
            return new_value

    def reset_key(self, email: str, ip: str) -> None:
        """Clear the counter for one identity after a successful login."""

        with self._lock:
            self._counts.pop(self._key(email, ip), None)

    def reset_all(self) -> None:
        """Wipe every counter. Called by the APScheduler job."""

        with self._lock:
            count = len(self._counts)
            self._counts.clear()
        if count:
            logger.info("login rate-limiter: cleared %d tracked key(s)", count)

    def start(self) -> None:
        """Start the background reset job."""

        if self._scheduler is not None:
            return
        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(
            self.reset_all,
            "interval",
            minutes=self.reset_minutes,
            id="login-rate-limit-reset",
            replace_existing=True,
        )
        scheduler.start()
        self._scheduler = scheduler
        logger.info(
            "login rate-limiter started: max_attempts=%d reset_every=%dmin",
            self.max_attempts,
            self.reset_minutes,
        )

    def stop(self) -> None:
        """Stop the reset job, if running."""

        if self._scheduler is not None:
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


# Process-wide singleton. The FastAPI startup hook populates and starts it;
# dependencies pull it through ``get_rate_limiter`` so tests can swap it.
_limiter: LoginRateLimiter | None = None


def get_rate_limiter() -> LoginRateLimiter:
    """Return the singleton limiter, creating it on first call."""

    from maugood.config import get_settings

    global _limiter
    if _limiter is None:
        settings = get_settings()
        _limiter = LoginRateLimiter(
            max_attempts=settings.login_max_attempts,
            reset_minutes=settings.login_rate_limit_reset_minutes,
        )
    return _limiter


def reset_rate_limiter() -> None:
    """Drop the singleton. Test-only utility."""

    global _limiter
    if _limiter is not None:
        _limiter.stop()
    _limiter = None
