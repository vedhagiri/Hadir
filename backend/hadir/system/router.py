"""System health endpoints used by the P11 System page.

* ``GET /api/system/health`` — uptime + DB connection count + scheduler
  status + a few headline counts (enrolled employees, today's events,
  today's attendance rows).
* ``GET /api/system/cameras-health`` — per-camera latest snapshot
  (frames_last_minute, reachable, last_seen) plus a 24-hour timeseries
  the frontend renders as a sparkline.
"""

from __future__ import annotations

import os
import time as time_mod
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, desc, func, select, text
from zoneinfo import ZoneInfo

from hadir.attendance import attendance_scheduler
from hadir.attendance.repository import local_tz
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.auth.ratelimit import get_rate_limiter
from hadir.capture import capture_manager
from hadir.db import (
    attendance_records,
    camera_health_snapshots,
    cameras,
    detection_events,
    employee_photos,
    employees,
    get_engine,
)
from hadir.tenants.scope import TenantScope

router = APIRouter(prefix="/api/system", tags=["system"])

ADMIN = Depends(require_role("Admin"))


# Track process startup time once per worker. ``time.monotonic`` would be
# safer against clock changes, but uptime as a wall-clock delta is what
# operators want to see on the System page.
_PROCESS_START_TS = time_mod.time()


class HealthOut(BaseModel):
    backend_uptime_seconds: int
    process_pid: int
    db_connections_active: int
    capture_workers_running: int
    attendance_scheduler_running: bool
    rate_limiter_running: bool
    enrolled_employees: int
    employees_active: int
    cameras_total: int
    cameras_enabled: int
    detection_events_today: int
    attendance_records_today: int


class CameraHealthSeriesPoint(BaseModel):
    captured_at: datetime
    frames_last_minute: int
    reachable: bool


class CameraHealthOut(BaseModel):
    camera_id: int
    name: str
    location: str
    # P28.5b: split worker / display flags. Old API consumers that
    # checked ``enabled`` should switch to ``worker_enabled`` (the
    # operational flag). ``display_enabled`` is supplementary.
    worker_enabled: bool
    display_enabled: bool
    rtsp_host: str
    last_seen_at: Optional[datetime] = None
    latest_frames_last_minute: int
    latest_reachable: bool
    series_24h: list[CameraHealthSeriesPoint]


class CamerasHealthOut(BaseModel):
    items: list[CameraHealthOut]


def _local_today() -> datetime.date:  # type: ignore[name-defined]
    tz = local_tz()
    return datetime.now(timezone.utc).astimezone(tz).date()


def _local_day_bounds_utc(d) -> tuple[datetime, datetime]:  # type: ignore[no-untyped-def]
    tz = local_tz()
    start_local = datetime.combine(d, time(0, 0), tzinfo=tz)
    end_local = datetime.combine(d, time(23, 59, 59, 999999), tzinfo=tz)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


@router.get("/health", response_model=HealthOut)
def get_health(user: Annotated[CurrentUser, ADMIN]) -> HealthOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    today = _local_today()
    day_start_utc, day_end_utc = _local_day_bounds_utc(today)

    with engine.begin() as conn:
        # Postgres `pg_stat_activity` works for the connected database
        # only — exactly what we want.
        try:
            db_conns = int(
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM pg_stat_activity "
                        "WHERE datname = current_database()"
                    )
                ).scalar_one()
            )
        except Exception:
            db_conns = 0

        enrolled = int(
            conn.execute(
                select(func.count(func.distinct(employee_photos.c.employee_id))).where(
                    employee_photos.c.tenant_id == scope.tenant_id,
                    employee_photos.c.embedding.is_not(None),
                )
            ).scalar_one()
        )
        employees_active = int(
            conn.execute(
                select(func.count()).where(
                    employees.c.tenant_id == scope.tenant_id,
                    employees.c.status == "active",
                )
            ).scalar_one()
        )
        cameras_total = int(
            conn.execute(
                select(func.count()).where(cameras.c.tenant_id == scope.tenant_id)
            ).scalar_one()
        )
        cameras_enabled = int(
            conn.execute(
                select(func.count()).where(
                    cameras.c.tenant_id == scope.tenant_id,
                    # P28.5b: ``enabled`` was split into worker_enabled
                    # + display_enabled. The system-health "cameras
                    # enabled" count is the count of cameras whose
                    # capture worker is on (the operationally-relevant
                    # number — display-disabled cameras are still
                    # recording).
                    cameras.c.worker_enabled.is_(True),
                )
            ).scalar_one()
        )
        events_today = int(
            conn.execute(
                select(func.count()).where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.captured_at >= day_start_utc,
                    detection_events.c.captured_at <= day_end_utc,
                )
            ).scalar_one()
        )
        attendance_today = int(
            conn.execute(
                select(func.count()).where(
                    attendance_records.c.tenant_id == scope.tenant_id,
                    attendance_records.c.date == today,
                )
            ).scalar_one()
        )

    uptime = max(0, int(time_mod.time() - _PROCESS_START_TS))
    return HealthOut(
        backend_uptime_seconds=uptime,
        process_pid=os.getpid(),
        db_connections_active=db_conns,
        capture_workers_running=len(capture_manager.active_camera_ids()),
        attendance_scheduler_running=attendance_scheduler._scheduler is not None,  # type: ignore[attr-defined]
        rate_limiter_running=get_rate_limiter()._scheduler is not None,  # type: ignore[attr-defined]
        enrolled_employees=enrolled,
        employees_active=employees_active,
        cameras_total=cameras_total,
        cameras_enabled=cameras_enabled,
        detection_events_today=events_today,
        attendance_records_today=attendance_today,
    )


@router.get("/cameras-health", response_model=CamerasHealthOut)
def cameras_health(user: Annotated[CurrentUser, ADMIN]) -> CamerasHealthOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    items: list[CameraHealthOut] = []
    with engine.begin() as conn:
        cam_rows = camera_repo_list_cameras(conn, scope)

        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        for cam in cam_rows:
            latest = conn.execute(
                select(
                    camera_health_snapshots.c.captured_at,
                    camera_health_snapshots.c.frames_last_minute,
                    camera_health_snapshots.c.reachable,
                )
                .where(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == cam.id,
                )
                .order_by(desc(camera_health_snapshots.c.captured_at))
                .limit(1)
            ).first()

            series_rows = conn.execute(
                select(
                    camera_health_snapshots.c.captured_at,
                    camera_health_snapshots.c.frames_last_minute,
                    camera_health_snapshots.c.reachable,
                )
                .where(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == cam.id,
                    camera_health_snapshots.c.captured_at >= cutoff,
                )
                .order_by(camera_health_snapshots.c.captured_at.asc())
            ).all()

            series = [
                CameraHealthSeriesPoint(
                    captured_at=r.captured_at,
                    frames_last_minute=int(r.frames_last_minute),
                    reachable=bool(r.reachable),
                )
                for r in series_rows
            ]

            items.append(
                CameraHealthOut(
                    camera_id=cam.id,
                    name=cam.name,
                    location=cam.location,
                    worker_enabled=cam.worker_enabled,
                    display_enabled=cam.display_enabled,
                    rtsp_host=cam.rtsp_host,
                    last_seen_at=cam.last_seen_at,
                    latest_frames_last_minute=(
                        int(latest.frames_last_minute) if latest is not None else 0
                    ),
                    latest_reachable=(
                        bool(latest.reachable) if latest is not None else False
                    ),
                    series_24h=series,
                )
            )
    return CamerasHealthOut(items=items)


def camera_repo_list_cameras(conn, scope: TenantScope):  # type: ignore[no-untyped-def]
    """Local helper to avoid a circular import with ``hadir.cameras``."""

    from hadir.cameras import repository as camera_repo  # noqa: PLC0415

    return camera_repo.list_cameras(conn, scope)
