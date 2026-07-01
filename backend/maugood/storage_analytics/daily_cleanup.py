"""Automatic daily clip cleanup — minute-scan + scheduler.

When a tenant enables ``clip_daily_cleanup_enabled`` and sets a local
``clip_daily_cleanup_time`` (HH:MM, 24h), the raw video of every clip
created *before today* (tenant-local) is deleted once per day at (or
after) that time — processed or not. Face crops, detection_events, and
attendance_records are untouched (same soft-clear contract as the
manual/retention cleanup).

Why a 60-second minute-scan rather than a per-tenant cron: the fire
time is per-tenant configurable AND evaluated in each tenant's own
timezone, and it can change at runtime via the Storage Analytics
settings PATCH. A scan that re-reads config every minute is
self-healing — a config change takes effect within a minute, a server
that was down at the configured time simply catches up on the next
tick, and there are no cron jobs to reschedule. The
``clip_daily_cleanup_last_run_on`` bookkeeping column gates it to
exactly one run per local day.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from maugood.db import get_engine, tenant_context, tenant_settings, tenants
from maugood.storage_analytics.cleanup import (
    CLEANUP_CAP,
    _tenant_timezone,
    get_daily_cleanup_config,
    run_daily_clip_cleanup,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_JOB_ID = "daily-clip-cleanup-scan"
# Absolute per-tenant batch bound so a huge backlog can't spin forever.
_MAX_BATCHES = 200


@dataclass
class TenantDailyCleanupResult:
    tenant_id: int
    tenant_schema: str
    ran: bool = False
    deleted_count: int = 0
    bytes_freed: int = 0
    error: str | None = None


@dataclass
class DailyCleanupScanResult:
    ran_at: datetime
    per_tenant: list[TenantDailyCleanupResult] = field(default_factory=list)


def _parse_hhmm(value: str) -> time:
    """Parse ``HH:MM`` (defensive: fall back to midnight on garbage)."""

    try:
        hh, mm = value.split(":", 1)
        return time(hour=int(hh), minute=int(mm))
    except (ValueError, AttributeError):
        return time(0, 0)


def _run_for_tenant(
    engine: Engine,
    tenant_id: int,
    tenant_schema: str,
    *,
    now: datetime,
) -> TenantDailyCleanupResult:
    result = TenantDailyCleanupResult(
        tenant_id=tenant_id, tenant_schema=tenant_schema
    )
    scope = TenantScope(tenant_id=tenant_id)

    with tenant_context(tenant_schema):
        with engine.begin() as conn:
            cfg = get_daily_cleanup_config(conn, scope)
            if not cfg.enabled:
                return result
            tz = _tenant_timezone(conn, scope)

        now_local = now.astimezone(tz)
        today_local: date = now_local.date()
        # Already handled today's run.
        if cfg.last_run_on is not None and cfg.last_run_on >= today_local:
            return result
        # Configured time hasn't arrived yet in the tenant's local day.
        if now_local.time() < _parse_hhmm(cfg.cleanup_time):
            return result

        # Due: reclaim every clip from before today, in capped batches.
        deleted = 0
        bytes_freed = 0
        for _ in range(_MAX_BATCHES):
            with engine.begin() as conn:
                r = run_daily_clip_cleanup(
                    conn,
                    scope,
                    actor_user_id=None,
                    cap=CLEANUP_CAP,
                    now=now,
                )
            deleted += r.deleted_count
            bytes_freed += r.bytes_freed
            if not r.has_more:
                break

        # Mark the day done regardless of how many rows were cleared, so
        # a day with zero eligible clips doesn't re-scan every minute.
        with engine.begin() as conn:
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == tenant_id)
                .values(clip_daily_cleanup_last_run_on=today_local)
            )

        result.ran = True
        result.deleted_count = deleted
        result.bytes_freed = bytes_freed
        logger.info(
            "daily clip cleanup: tenant=%s schema=%s cleared=%d bytes=%d",
            tenant_id,
            tenant_schema,
            deleted,
            bytes_freed,
        )
    return result


def run_daily_cleanup_scan(
    engine: Engine | None = None,
    *,
    now: datetime | None = None,
) -> DailyCleanupScanResult:
    """Scan every tenant and run the daily cleanup for those that are due.

    Mirrors ``run_retention_sweep``'s tenant enumeration: reads the
    ``public.tenants`` registry, then does each tenant's work inside a
    ``tenant_context`` so the per-connection ``SET search_path`` scopes
    the queries. A failure for one tenant is logged and skipped — it
    must not stop the others.
    """

    now = now or datetime.now(tz=timezone.utc)
    engine = engine or get_engine()
    out = DailyCleanupScanResult(ran_at=now)

    with tenant_context("public"):
        with engine.begin() as conn:
            rows = conn.execute(
                select(tenants.c.id, tenants.c.schema_name).order_by(
                    tenants.c.id
                )
            ).all()
    pairs = [(int(r.id), str(r.schema_name)) for r in rows]

    for tenant_id, tenant_schema in pairs:
        try:
            out.per_tenant.append(
                _run_for_tenant(engine, tenant_id, tenant_schema, now=now)
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "daily clip cleanup failed for tenant=%s schema=%s",
                tenant_id,
                tenant_schema,
            )
            out.per_tenant.append(
                TenantDailyCleanupResult(
                    tenant_id=tenant_id,
                    tenant_schema=tenant_schema,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
    return out


class DailyClipCleanupScheduler:
    """Singleton facade matching the other scheduler wrappers
    (attendance, report_runner, retention). Tests neutralise it via the
    same start/stop-monkeypatch pattern in ``tests/conftest.py``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: BackgroundScheduler | None = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            scheduler = BackgroundScheduler(daemon=True, timezone=timezone.utc)
            scheduler.add_job(
                run_daily_cleanup_scan,
                IntervalTrigger(seconds=60),
                id=_JOB_ID,
                replace_existing=True,
                coalesce=True,
                max_instances=1,
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info("daily clip cleanup scheduler started (interval=60s)")
            try:
                from maugood.metrics import (  # noqa: PLC0415
                    install_scheduler_failure_listener,
                )

                install_scheduler_failure_listener(
                    scheduler,
                    job_name="daily_clip_cleanup_scan",
                    tenant_id=None,  # cross-tenant
                )
            except Exception:  # noqa: BLE001
                pass

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


daily_clip_cleanup_scheduler = DailyClipCleanupScheduler()


__all__ = [
    "DailyCleanupScanResult",
    "DailyClipCleanupScheduler",
    "TenantDailyCleanupResult",
    "daily_clip_cleanup_scheduler",
    "run_daily_cleanup_scan",
]
