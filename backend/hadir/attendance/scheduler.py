"""APScheduler wrapper that recomputes today's attendance rows.

Runs every ``HADIR_ATTENDANCE_RECOMPUTE_MINUTES`` (default 15). Also
recomputes once on startup so the first lifespan tick lands rows before
anyone hits ``GET /api/attendance``.

Historical days are **not** recomputed — per the pilot-plan, once
``date`` rolls over we treat yesterday as frozen. v1.0 introduces a
separate "late recompute" flow.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from hadir.attendance import engine as attendance_engine
from hadir.attendance import repository as attendance_repo
from hadir.config import get_settings
from hadir.db import get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_JOB_ID = "attendance-recompute-today"


def recompute_today(scope: TenantScope) -> int:
    """Recompute the attendance_records row for every active employee today.

    Returns the number of rows upserted. Keeps itself resilient: a single
    employee blowing up doesn't abort the others.
    """

    engine = get_engine()
    tz = attendance_repo.local_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()

    with engine.begin() as conn:
        policy = attendance_repo.active_policy_for(conn, scope, the_date=today)
    if policy is None:
        logger.warning(
            "attendance: no active policy for tenant %s on %s", scope.tenant_id, today
        )
        return 0

    with engine.begin() as conn:
        employee_ids = attendance_repo.active_employee_ids(conn, scope)

    upserted = 0
    for emp_id in employee_ids:
        try:
            with engine.begin() as conn:
                events = attendance_repo.events_for(
                    conn, scope, employee_id=emp_id, the_date=today
                )
                record = attendance_engine.compute(
                    employee_id=emp_id,
                    the_date=today,
                    policy=policy,
                    events=events,
                )
                attendance_repo.upsert_attendance(conn, scope, record)
            upserted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "attendance: recompute failed for employee %s: %s",
                emp_id,
                type(exc).__name__,
            )
    logger.info(
        "attendance recompute done: tenant=%s date=%s upserted=%d",
        scope.tenant_id,
        today,
        upserted,
    )
    return upserted


class AttendanceScheduler:
    """Thin supervisor for the periodic recompute job."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: BackgroundScheduler | None = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            settings = get_settings()
            scope = TenantScope(tenant_id=settings.default_tenant_id)
            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(
                recompute_today,
                "interval",
                minutes=settings.attendance_recompute_minutes,
                id=_JOB_ID,
                replace_existing=True,
                kwargs={"scope": scope},
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "attendance scheduler started: interval=%dmin",
                settings.attendance_recompute_minutes,
            )

            # Seed once on startup so a fresh boot has rows immediately.
            def _seed() -> None:
                try:
                    recompute_today(scope)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "attendance: startup seed failed: %s", type(exc).__name__
                    )

            threading.Thread(
                target=_seed, name="attendance-seed", daemon=True
            ).start()

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


attendance_scheduler = AttendanceScheduler()
