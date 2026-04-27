"""P28.8 — Super-Admin system metrics endpoints.

Two endpoints:

* ``GET /api/super-admin/system/metrics`` — host-wide CPU / memory /
  disk plus capture-side stats and a snapshot of the scheduled-jobs
  table from APScheduler.
* ``GET /api/super-admin/system/tenants-summary`` — per-tenant
  high-level counts (workers running, events last hour, any-stage-red
  flag).

Super-Admin role only. The Super-Admin console uses a separate cookie
(``hadir_super_session``) and a separate dependency
(``current_super_admin``) than the tenant API — that's the auth gate.

English-only — Super-Admin is internal MTS staff (documented).
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func as sa_func
from sqlalchemy import select

from hadir.capture import capture_manager
from hadir.config import get_settings
from hadir.db import (
    detection_events,
    get_engine,
    make_admin_engine,
    tenant_context,
    tenants as tenants_table,
)
from hadir.detection.detectors import _detect_lock
from hadir.super_admin.dependencies import (
    CurrentSuperAdmin,
    current_super_admin,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/super-admin/system", tags=["super-admin", "system"])

SUPER_ADMIN = Depends(current_super_admin)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class HostMetrics(BaseModel):
    cpu_percent: float
    cpu_per_core: list[float]
    load_avg: list[float]
    mem_used_mb: int
    mem_total_mb: int
    mem_percent: float
    disk_used_gb: float
    disk_total_gb: float
    disk_percent: float
    uptime_sec: int


class DataPartitionMetrics(BaseModel):
    path: str
    used_gb: float
    total_gb: float
    percent: float
    face_crops_count: int
    face_crops_size_gb: float
    estimated_days_until_full: Optional[int] = None


class DatabaseMetrics(BaseModel):
    pool_active: int
    pool_idle: int
    pool_total: int
    size_mb: Optional[int] = None


class CaptureMetrics(BaseModel):
    total_workers_running: int
    total_workers_configured: int
    tenants_with_workers: int
    detector_lock_contention_60s_pct: float
    active_mjpeg_viewers: int
    active_ws_subscribers: int


class ScheduledJobOut(BaseModel):
    name: str
    last_run: Optional[str] = None
    next_run: Optional[str] = None
    status: str = "unknown"


class SystemMetricsOut(BaseModel):
    host: HostMetrics
    data_partition: DataPartitionMetrics
    database: DatabaseMetrics
    capture: CaptureMetrics
    scheduled_jobs: list[ScheduledJobOut]


class TenantSummaryRow(BaseModel):
    slug: str
    workers_running: int
    workers_configured: int
    events_last_hour: int
    any_stage_red: bool


class TenantsSummaryOut(BaseModel):
    tenants: list[TenantSummaryRow]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _host_metrics() -> HostMetrics:
    """Best-effort host metrics. ``psutil`` is the source; we degrade
    gracefully if any single field can't be read (sandboxed Docker
    environments sometimes hide load average etc.)."""

    import psutil  # noqa: PLC0415

    try:
        cpu_percent = float(psutil.cpu_percent(interval=None))
    except Exception:  # noqa: BLE001
        cpu_percent = 0.0
    try:
        cpu_per_core = [
            float(v) for v in psutil.cpu_percent(percpu=True, interval=None)
        ]
    except Exception:  # noqa: BLE001
        cpu_per_core = []
    try:
        load = list(os.getloadavg())
    except Exception:  # noqa: BLE001
        load = [0.0, 0.0, 0.0]

    mem = psutil.virtual_memory()
    # Disk for the data partition — use the configured faces path if
    # set, otherwise fall back to root. ``psutil.disk_usage`` follows
    # symlinks.
    settings = get_settings()
    disk_path = (
        settings.faces_storage_path
        if settings.faces_storage_path
        else "/"
    )
    try:
        du = psutil.disk_usage(disk_path)
    except Exception:  # noqa: BLE001
        du = psutil.disk_usage("/")

    try:
        boot_ts = float(psutil.boot_time())
        uptime = max(0, int(time.time() - boot_ts))
    except Exception:  # noqa: BLE001
        uptime = 0

    return HostMetrics(
        cpu_percent=round(cpu_percent, 1),
        cpu_per_core=[round(v, 1) for v in cpu_per_core],
        load_avg=[round(v, 2) for v in load],
        mem_used_mb=int((mem.total - mem.available) / (1024 * 1024)),
        mem_total_mb=int(mem.total / (1024 * 1024)),
        mem_percent=round(mem.percent, 1),
        disk_used_gb=round(du.used / (1024**3), 2),
        disk_total_gb=round(du.total / (1024**3), 2),
        disk_percent=round(du.percent, 1),
        uptime_sec=uptime,
    )


def _data_partition_metrics() -> DataPartitionMetrics:
    import psutil  # noqa: PLC0415

    settings = get_settings()
    base = Path(settings.faces_storage_path or "/data")
    try:
        du = psutil.disk_usage(str(base))
    except Exception:  # noqa: BLE001
        du = psutil.disk_usage("/")

    # Walk the captures tree just for face crop count + total size.
    # Bounded by the disk; on a fresh box this is a couple of files.
    captures_root = base / "captures"
    count = 0
    total_bytes = 0
    if captures_root.exists():
        try:
            for p in captures_root.rglob("*.jpg"):
                try:
                    total_bytes += p.stat().st_size
                    count += 1
                except OSError:
                    continue
        except Exception:  # noqa: BLE001
            pass

    # Estimate days until full requires growth-over-time history.
    # Simplification: not available in v1.0 (no history table) →
    # always None on a fresh dev install. v1.x can persist a daily
    # snapshot to make this real.
    days_until_full: Optional[int] = None

    return DataPartitionMetrics(
        path=str(base),
        used_gb=round(du.used / (1024**3), 2),
        total_gb=round(du.total / (1024**3), 2),
        percent=round(du.percent, 1),
        face_crops_count=count,
        face_crops_size_gb=round(total_bytes / (1024**3), 2),
        estimated_days_until_full=days_until_full,
    )


def _database_metrics() -> DatabaseMetrics:
    """Pool stats + DB size in MB. Failures degrade to zero/null."""

    engine = get_engine()
    try:
        pool = engine.pool
        active = pool.checkedout()  # type: ignore[union-attr]
        total = pool.size() + pool.overflow()  # type: ignore[union-attr]
        idle = max(0, total - active)
    except Exception:  # noqa: BLE001
        active = 0
        idle = 0
        total = 0

    size_mb: Optional[int] = None
    try:
        from sqlalchemy import text  # noqa: PLC0415

        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT pg_database_size(current_database())")
            ).first()
        if row is not None:
            size_mb = int(int(row[0]) / (1024 * 1024))
    except Exception:  # noqa: BLE001
        size_mb = None

    return DatabaseMetrics(
        pool_active=int(active),
        pool_idle=int(idle),
        pool_total=int(total),
        size_mb=size_mb,
    )


def _capture_metrics() -> CaptureMetrics:
    """Aggregate worker counts across every tenant + lock contention."""

    snapshot = capture_manager.workers_snapshot()
    total_running = len(snapshot)
    tenants_with_workers = len({t for (t, _c) in snapshot})

    # configured = sum of cameras.worker_enabled across all tenants.
    admin_engine = make_admin_engine()
    total_configured = 0
    try:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                tenant_rows = conn.execute(
                    select(tenants_table.c.id, tenants_table.c.schema_name).where(
                        tenants_table.c.status == "active"
                    )
                ).all()
        for r in tenant_rows:
            try:
                with tenant_context(str(r.schema_name)):
                    with admin_engine.begin() as conn:
                        # Inline import — avoid heavy module-level import.
                        from hadir.db import cameras as cameras_table  # noqa: PLC0415

                        total_configured += int(
                            conn.execute(
                                select(sa_func.count())
                                .select_from(cameras_table)
                                .where(
                                    cameras_table.c.tenant_id == int(r.id),
                                    cameras_table.c.worker_enabled.is_(True),
                                )
                            ).scalar_one()
                        )
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        total_configured = total_running

    contention = float(_detect_lock.contention_pct_60s())

    subs = capture_manager.get_subscriber_counts()
    return CaptureMetrics(
        total_workers_running=total_running,
        total_workers_configured=total_configured,
        tenants_with_workers=tenants_with_workers,
        detector_lock_contention_60s_pct=round(contention, 1),
        active_mjpeg_viewers=int(subs.get("mjpeg", 0)),
        active_ws_subscribers=int(subs.get("ws", 0)),
    )


def _scheduled_jobs() -> list[ScheduledJobOut]:
    """Inspect every BackgroundScheduler we can find on the running app
    and surface its jobs. The list is best-effort — failures degrade
    to an empty list."""

    out: list[ScheduledJobOut] = []
    candidates: list[tuple[str, Any]] = []

    try:
        from hadir.attendance import attendance_scheduler  # noqa: PLC0415

        candidates.append(("attendance_recompute", attendance_scheduler))
    except Exception:  # noqa: BLE001
        pass
    try:
        from hadir.scheduled_reports import report_runner  # noqa: PLC0415

        candidates.append(("scheduled_reports", report_runner))
    except Exception:  # noqa: BLE001
        pass
    try:
        from hadir.notifications import notification_worker  # noqa: PLC0415

        candidates.append(("notifications_worker", notification_worker))
    except Exception:  # noqa: BLE001
        pass
    try:
        from hadir.retention import retention_scheduler  # noqa: PLC0415

        candidates.append(("retention", retention_scheduler))
    except Exception:  # noqa: BLE001
        pass
    try:
        from hadir.employees.lifecycle_cron import lifecycle_scheduler  # noqa: PLC0415

        candidates.append(("lifecycle_cron", lifecycle_scheduler))
    except Exception:  # noqa: BLE001
        pass

    for label, sched in candidates:
        try:
            apsched = getattr(sched, "_scheduler", None)
            if apsched is None:
                out.append(
                    ScheduledJobOut(name=label, status="not_started")
                )
                continue
            jobs = list(apsched.get_jobs())
            if not jobs:
                out.append(ScheduledJobOut(name=label, status="no_jobs"))
                continue
            for j in jobs:
                next_run = (
                    j.next_run_time.isoformat() if j.next_run_time else None
                )
                out.append(
                    ScheduledJobOut(
                        name=f"{label}.{j.id}",
                        last_run=None,  # APScheduler doesn't track last_run on the public surface
                        next_run=next_run,
                        status="ok",
                    )
                )
        except Exception:  # noqa: BLE001
            out.append(ScheduledJobOut(name=label, status="error"))
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/metrics", response_model=SystemMetricsOut)
def system_metrics(
    _user: Annotated[CurrentSuperAdmin, SUPER_ADMIN],
) -> SystemMetricsOut:
    """Host + DB + capture + scheduled-jobs snapshot.

    Polled every 5 s by the Super-Admin System page. The page uses
    the values to render CPU bars, memory + disk gauges, and the
    detector-lock contention bar."""

    return SystemMetricsOut(
        host=_host_metrics(),
        data_partition=_data_partition_metrics(),
        database=_database_metrics(),
        capture=_capture_metrics(),
        scheduled_jobs=_scheduled_jobs(),
    )


@router.get("/tenants-summary", response_model=TenantsSummaryOut)
def tenants_summary(
    _user: Annotated[CurrentSuperAdmin, SUPER_ADMIN],
) -> TenantsSummaryOut:
    """Per-tenant high-level health for the Super-Admin System page's
    bottom table. Polled every 30 s — the values move slower than the
    host metrics row."""

    admin_engine = make_admin_engine()
    rows: list[TenantSummaryRow] = []
    one_hour_ago = datetime.now(tz=timezone.utc) - timedelta(hours=1)

    try:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                trows = conn.execute(
                    select(
                        tenants_table.c.id,
                        tenants_table.c.slug,
                        tenants_table.c.schema_name,
                    ).where(tenants_table.c.status == "active")
                ).all()
    except Exception:  # noqa: BLE001
        return TenantsSummaryOut(tenants=[])

    for tr in trows:
        tenant_id = int(tr.id)
        slug = str(tr.slug)
        schema = str(tr.schema_name)

        running = len(capture_manager.active_camera_ids(tenant_id=tenant_id))

        configured = 0
        events_last_hour = 0
        any_red = False
        try:
            with tenant_context(schema):
                with admin_engine.begin() as conn:
                    from hadir.db import cameras as cameras_table  # noqa: PLC0415

                    configured = int(
                        conn.execute(
                            select(sa_func.count())
                            .select_from(cameras_table)
                            .where(
                                cameras_table.c.tenant_id == tenant_id,
                                cameras_table.c.worker_enabled.is_(True),
                            )
                        ).scalar_one()
                    )
                    events_last_hour = int(
                        conn.execute(
                            select(sa_func.count())
                            .select_from(detection_events)
                            .where(
                                detection_events.c.tenant_id == tenant_id,
                                detection_events.c.captured_at >= one_hour_ago,
                            )
                        ).scalar_one()
                    )

            # any_stage_red: pull the worker stats for each running
            # worker. Cheap — we only iterate live workers.
            for cam_id in capture_manager.active_camera_ids(
                tenant_id=tenant_id
            ):
                payload = capture_manager.get_full_worker_stats(
                    tenant_id, cam_id
                )
                if payload is None:
                    continue
                stages = payload.get("stages", {}) or {}
                for s in stages.values():
                    if isinstance(s, dict) and s.get("state") == "red":
                        any_red = True
                        break
                if any_red:
                    break
        except Exception:  # noqa: BLE001
            pass

        rows.append(
            TenantSummaryRow(
                slug=slug,
                workers_running=running,
                workers_configured=configured,
                events_last_hour=events_last_hour,
                any_stage_red=any_red,
            )
        )

    return TenantsSummaryOut(tenants=rows)
