"""Pipeline Monitor data aggregator.

Walks the running backend's subsystems and collects per-worker
stats in one uniform shape — the frontend renders one table from
this response. Tenant-scoped (live-capture + clip pipeline) +
process-wide (schedulers).

Each worker row carries the columns the dashboard table needs:
``name, status, active_jobs, queue_count, processing, completed,
failed, current_task, speed_ms, health, group``.

Errors collecting any single subsystem degrade to a synthetic row
with ``health="unknown"`` so the dashboard never goes blank because
one subsystem misbehaved.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

from maugood.capture import capture_manager
from maugood.clip_pipeline import clip_pipeline

logger = logging.getLogger(__name__)


def _make_row(
    *,
    name: str,
    group: str,
    status: str = "running",
    active_jobs: Optional[int] = None,
    active_unit: Optional[str] = None,
    queue_count: Optional[int] = None,
    processing: Optional[int] = None,
    completed: Optional[int] = None,
    failed: Optional[int] = None,
    current_task: str = "",
    speed_ms: Optional[float] = None,
    health: str = "healthy",
    next_run: Optional[str] = None,
    detail: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    # ``active_unit`` disambiguates the Active column on the dashboard:
    # rollup rows (RTSP / Clip Saving) carry "cams" so the operator
    # sees "3 cams" instead of bare "3"; queue rows carry "workers"
    # (worker-thread count); schedulers carry "jobs". Frontend
    # appends the unit to the cell text when present.
    return {
        "name": name,
        "group": group,
        "status": status,
        "active_jobs": active_jobs,
        "active_unit": active_unit,
        "queue_count": queue_count,
        "processing": processing,
        "completed": completed,
        "failed": failed,
        "current_task": current_task,
        "speed_ms": speed_ms,
        "health": health,
        "next_run": next_run,
        "detail": detail or {},
    }


# ---- Live capture group -----------------------------------------------------


def _live_capture_rows(tenant_id: int) -> list[dict[str, Any]]:
    """RTSP Live Feed + Clip Saving — rolled up across this tenant's
    cameras. Per-camera reader/analyzer/clip threads collapse to one
    row each so the operator sees the workload, not the thread count.
    """

    rows: list[dict[str, Any]] = []
    try:
        workers = capture_manager.workers_for_tenant(tenant_id)
    except Exception:  # noqa: BLE001
        workers = []

    # RTSP Live Feed — sum across every running capture worker.
    rtsp_active = 0
    rtsp_running = 0
    rtsp_failed = 0
    rtsp_current_tasks: list[str] = []
    rtsp_health = "idle"
    for cam_id, w in workers:
        try:
            stats = w.get_stats()
        except Exception:  # noqa: BLE001
            continue
        if w.is_alive():
            rtsp_running += 1
            rtsp_active += 1
            rtsp_current_tasks.append(
                f"cam #{cam_id} {stats.get('fps_reader', 0)}fps"
            )
        else:
            rtsp_failed += 1

    if rtsp_failed > 0:
        rtsp_health = "degraded"
    elif rtsp_active > 0:
        rtsp_health = "healthy"

    rows.append(
        _make_row(
            name="RTSP Live Feed",
            group="live_capture",
            status="running" if rtsp_running > 0 else "idle",
            active_jobs=rtsp_active,
            active_unit="cams",
            queue_count=None,
            processing=rtsp_running,
            completed=None,  # not tracked here; per-camera health is the truth
            failed=rtsp_failed,
            current_task=(
                f"Reading {rtsp_running} stream{'' if rtsp_running == 1 else 's'}"
                if rtsp_running
                else "no cameras"
            ),
            speed_ms=None,
            health=rtsp_health,
            detail={"current": rtsp_current_tasks[:10]},
        )
    )

    # Clip Saving — aggregate every camera's ClipWorker queue depth +
    # in-flight count. The per-camera ClipWorker objects live on each
    # CaptureWorker as ``_clip_worker``; they expose ``queue_size()``,
    # ``is_processing()``, and lifetime counters (added in this same
    # commit). Defensive ``getattr`` so a partial-feature CaptureWorker
    # never bricks the dashboard.
    clip_queue = 0
    clip_in_flight = 0
    clip_completed = 0
    clip_failed = 0
    clip_workers = 0
    clip_current: list[str] = []
    # Option B segmenter rollup: when stream_copy mode is on, aggregate
    # segment counts + disk usage across cameras so the dashboard
    # confirms the parallel ffmpeg subprocesses are healthy.
    seg_segments_total = 0
    seg_disk_bytes_total = 0
    seg_running_count = 0
    seg_restart_total = 0
    seg_mode_detected: Optional[str] = None
    for cam_id, w in workers:
        cw = getattr(w, "_clip_worker", None)
        if cw is None:
            continue
        clip_workers += 1
        seg = getattr(w, "_segmenter", None)
        if seg is not None:
            seg_mode_detected = "stream_copy"
            try:
                s = seg.stats()
                if s.get("running"):
                    seg_running_count += 1
                seg_segments_total += int(s.get("segment_count", 0))
                seg_disk_bytes_total += int(s.get("disk_bytes", 0))
                seg_restart_total += int(s.get("restart_count", 0))
            except Exception:  # noqa: BLE001
                pass
        try:
            clip_queue += int(cw.queue_size())
        except Exception:  # noqa: BLE001
            pass
        try:
            if cw.is_processing():
                clip_in_flight += 1
                tag = f"cam #{cam_id}"
                cid = getattr(cw, "current_clip_id", None)
                if cid is not None:
                    tag += f" clip #{cid}"
                clip_current.append(tag)
        except Exception:  # noqa: BLE001
            pass
        try:
            clip_completed += int(getattr(cw, "lifetime_processed", 0))
        except Exception:  # noqa: BLE001
            pass
        try:
            clip_failed += int(getattr(cw, "lifetime_failed", 0))
        except Exception:  # noqa: BLE001
            pass

    # Display mode in the dashboard so the operator can see at a
    # glance which clip-saving path is active.
    try:
        from maugood.config import get_settings  # noqa: PLC0415

        clip_saving_mode = (
            get_settings().clip_saving_mode or "encode"
        ).strip().lower()
    except Exception:  # noqa: BLE001
        clip_saving_mode = "encode"

    rows.append(
        _make_row(
            name="Clip Saving",
            group="live_capture",
            status="running" if clip_workers > 0 else "idle",
            active_jobs=clip_workers,
            active_unit="cams",
            queue_count=clip_queue,
            processing=clip_in_flight,
            completed=clip_completed,
            failed=clip_failed,
            current_task=(
                f"[{clip_saving_mode}] "
                + (
                    ", ".join(clip_current[:3]) + (
                        f" +{len(clip_current) - 3} more"
                        if len(clip_current) > 3 else ""
                    )
                    if clip_current
                    else (
                        f"Watching {clip_workers} camera"
                        f"{'' if clip_workers == 1 else 's'}"
                        if clip_workers else "no cameras"
                    )
                )
            ),
            speed_ms=None,
            health="degraded" if clip_failed > 0 else (
                "healthy" if clip_in_flight > 0 else
                "healthy" if clip_workers > 0 else "idle"
            ),
            detail={
                "current": clip_current[:10],
                "mode": clip_saving_mode,
                "segmenter": {
                    "running_cameras": seg_running_count,
                    "segments_on_disk": seg_segments_total,
                    "disk_bytes": seg_disk_bytes_total,
                    "restart_count": seg_restart_total,
                } if seg_mode_detected else None,
            },
        )
    )

    return rows


# ---- Clip pipeline group ---------------------------------------------------


def _pipeline_rows(tenant_id: int) -> list[dict[str, Any]]:
    """Per-UC cropping rows + one Face Matching row, sourced from
    ``clip_pipeline.status_snapshot``."""

    try:
        snap = clip_pipeline.status_snapshot(tenant_id=tenant_id)
    except Exception:  # noqa: BLE001
        return [
            _make_row(
                name="Clip Pipeline",
                group="pipeline",
                status="stopped",
                health="unknown",
                current_task="status_snapshot failed",
            )
        ]

    rows: list[dict[str, Any]] = []
    ucs = snap.get("config", {}).get("ucs", ["uc1", "uc2", "uc3"])
    cropping_by_uc = snap.get("cropping_by_uc", {}) or {}
    for uc in ucs:
        b = cropping_by_uc.get(uc) or {}
        workers = b.get("workers", []) or []
        current_task = next(
            (w["current_job"] for w in workers if w.get("busy")),
            "idle" if not b.get("in_flight") else "",
        )
        rows.append(
            _make_row(
                name=f"{uc.upper()} Face Cropping",
                group="pipeline",
                status="running" if snap.get("running") else "stopped",
                active_jobs=len(workers),
                active_unit="workers",
                queue_count=int(b.get("queue_depth", 0)),
                processing=int(b.get("in_flight", 0)),
                completed=int(b.get("lifetime_processed", 0)),
                failed=int(b.get("lifetime_failed", 0)),
                current_task=current_task,
                speed_ms=_median_speed_for_stage(uc),
                health=_health_for_stage(uc),
                detail={"workers": workers},
            )
        )

    m = snap.get("matching", {}) or {}
    m_workers = m.get("workers", []) or []
    m_current = next(
        (w["current_job"] for w in m_workers if w.get("busy")),
        "idle" if not m.get("in_flight") else "",
    )
    rows.append(
        _make_row(
            name="Face Matching",
            group="pipeline",
            status="running" if snap.get("running") else "stopped",
            active_jobs=len(m_workers),
            active_unit="workers",
            queue_count=int(m.get("queue_depth", 0)),
            processing=int(m.get("in_flight", 0)),
            completed=int(m.get("lifetime_processed", 0)),
            failed=int(m.get("lifetime_failed", 0)),
            current_task=m_current,
            speed_ms=_median_speed_for_matching(),
            health=_health_for_matching(),
            detail={"workers": m_workers},
        )
    )

    return rows


def _median_speed_for_stage(uc: str) -> Optional[float]:
    stage = clip_pipeline._cropping_by_uc.get(uc)  # noqa: SLF001
    if stage is None:
        return None
    return stage.stats().median_duration_ms


def _health_for_stage(uc: str) -> str:
    stage = clip_pipeline._cropping_by_uc.get(uc)  # noqa: SLF001
    if stage is None:
        return "unknown"
    return stage.stats().health


def _median_speed_for_matching() -> Optional[float]:
    m = clip_pipeline._matching  # noqa: SLF001
    if m is None:
        return None
    return m.stats().median_duration_ms


def _health_for_matching() -> str:
    m = clip_pipeline._matching  # noqa: SLF001
    if m is None:
        return "unknown"
    return m.stats().health


# ---- Schedulers group ------------------------------------------------------


def _scheduler_rows() -> list[dict[str, Any]]:
    """The seven always-on schedulers — read their APScheduler state."""

    out: list[dict[str, Any]] = []
    # (display name, current_task subtitle, importer)
    candidates: list[tuple[str, str, Any]] = []

    def _try(name: str, subtitle: str, importer):  # type: ignore[no-untyped-def]
        try:
            candidates.append((name, subtitle, importer()))
        except Exception:  # noqa: BLE001
            out.append(
                _make_row(
                    name=name,
                    group="scheduler",
                    status="unknown",
                    health="unknown",
                    current_task=f"import failed",
                )
            )

    _try(
        "Attendance Worker",
        "Recompute attendance every 15 min",
        lambda: __import__(
            "maugood.attendance", fromlist=["attendance_scheduler"]
        ).attendance_scheduler,
    )
    _try(
        "Notifications",
        "Drain queue every 30 s",
        lambda: __import__(
            "maugood.notifications", fromlist=["notification_worker"]
        ).notification_worker,
    )
    _try(
        "Scheduled Reports",
        "Scan schedules every 60 s",
        lambda: __import__(
            "maugood.scheduled_reports", fromlist=["report_runner"]
        ).report_runner,
    )
    _try(
        "Retention Cleanup",
        "Sweep stale rows at 03:00 tenant-local",
        lambda: __import__(
            "maugood.retention", fromlist=["retention_scheduler"]
        ).retention_scheduler,
    )
    _try(
        "Lifecycle Cron",
        "Flip relieved employees at 00:01",
        lambda: __import__(
            "maugood.employees.lifecycle_cron", fromlist=["lifecycle_scheduler"]
        ).lifecycle_scheduler,
    )
    _try(
        "Capture Reconcile",
        "Reconcile workers every 2 s",
        lambda: capture_manager,
    )

    for name, subtitle, sched in candidates:
        apsched = getattr(sched, "_scheduler", None) or getattr(
            sched, "_reconcile_scheduler", None
        )
        if apsched is None:
            out.append(
                _make_row(
                    name=name,
                    group="scheduler",
                    status="not_started",
                    health="idle",
                    current_task=subtitle,
                )
            )
            continue
        try:
            jobs = list(apsched.get_jobs())
        except Exception:  # noqa: BLE001
            jobs = []
        next_run: Optional[str] = None
        for j in jobs:
            try:
                if j.next_run_time is not None:
                    if next_run is None or (
                        j.next_run_time.isoformat() < next_run
                    ):
                        next_run = j.next_run_time.isoformat()
            except Exception:  # noqa: BLE001
                continue
        out.append(
            _make_row(
                name=name,
                group="scheduler",
                status="running" if jobs else "no_jobs",
                active_jobs=len(jobs),
                active_unit="jobs",
                health="healthy" if jobs else "idle",
                current_task=subtitle,
                next_run=next_run,
                detail={"job_count": len(jobs)},
            )
        )

    # Rate limiter sits outside APScheduler — it spins its own
    # threading.Timer. Surface a coarse "running" row so the dashboard
    # accounts for all 7.
    try:
        from maugood.auth.ratelimit import get_rate_limiter  # noqa: PLC0415

        limiter = get_rate_limiter()
        out.append(
            _make_row(
                name="Rate Limit Reset",
                group="scheduler",
                status="running" if getattr(limiter, "_started", True) else "stopped",
                health="healthy",
                current_task="Reset login counters every 10 min",
            )
        )
    except Exception:  # noqa: BLE001
        out.append(
            _make_row(
                name="Rate Limit Reset",
                group="scheduler",
                status="unknown",
                health="unknown",
                current_task="import failed",
            )
        )
    return out


# ---- Public entry point ----------------------------------------------------


def build_snapshot(*, tenant_id: int) -> dict[str, Any]:
    """One unified payload — every worker row the dashboard renders."""

    started = time.time()
    live = _live_capture_rows(tenant_id)
    pipeline = _pipeline_rows(tenant_id)
    schedulers = _scheduler_rows()
    all_rows = live + pipeline + schedulers

    running = sum(1 for r in all_rows if r["status"] == "running")
    stalled = sum(1 for r in all_rows if r["health"] == "stalled")
    degraded = sum(1 for r in all_rows if r["health"] == "degraded")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "took_ms": round((time.time() - started) * 1000.0, 1),
        "summary": {
            "total_workers": len(all_rows),
            "running": running,
            "stalled": stalled,
            "degraded": degraded,
        },
        "groups": [
            {"key": "live_capture", "label": "Live capture", "workers": live},
            {
                "key": "pipeline",
                "label": "Per-clip processing",
                "workers": pipeline,
            },
            {
                "key": "scheduler",
                "label": "Schedulers",
                "workers": schedulers,
            },
        ],
    }
