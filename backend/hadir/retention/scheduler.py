"""APScheduler wrapper for the retention sweep (v1.0 P25).

Daily cron at 03:00 in the configured tenant timezone
(``HADIR_LOCAL_TIMEZONE`` — defaults to ``Asia/Muscat``). The
job is idempotent: each table's DELETE has a fixed cutoff
relative to ``now()`` so re-running it the next day just sweeps
the next 24 hours of expired rows.

Wired into the FastAPI lifespan in ``hadir.main`` alongside the
P10 attendance scheduler and the P20 notification worker.
"""

from __future__ import annotations

import logging
import threading
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.background import BackgroundScheduler

from hadir.config import get_settings
from hadir.retention.sweep import run_retention_sweep

logger = logging.getLogger(__name__)

_JOB_ID = "retention-sweep"


class RetentionScheduler:
    """Singleton facade with start/stop semantics matching the
    other scheduler wrappers (attendance, report_runner,
    notification_worker). Tests neutralise it via the same
    pattern in ``tests/conftest.py``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: BackgroundScheduler | None = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            settings = get_settings()
            try:
                tz = ZoneInfo(settings.local_timezone)
            except ZoneInfoNotFoundError:
                logger.warning(
                    "retention: unknown timezone %s; falling back to UTC",
                    settings.local_timezone,
                )
                tz = ZoneInfo("UTC")
            scheduler = BackgroundScheduler(daemon=True, timezone=tz)
            scheduler.add_job(
                run_retention_sweep,
                "cron",
                hour=3,
                minute=0,
                id=_JOB_ID,
                replace_existing=True,
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "retention scheduler started: 03:00 %s daily",
                tz.key,
            )

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


retention_scheduler = RetentionScheduler()
