"""P29 — Resources tab endpoints under ``/api/operations/resources``.

All three are Admin-only (matches the rest of ``/api/operations/*``),
tenant-scoped where it makes sense, and read-only. Polled every 5 s
by the Resources tab; no audit row per poll.

Endpoint contracts intentionally documented inline so a future
operator/dev can read the JSON shape from the code without launching
the page.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from maugood.auth.dependencies import CurrentUser, require_role
from maugood.capture import capture_manager
from maugood.observability import host_metrics
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/operations/resources", tags=["operations", "resources"])

ADMIN = Depends(require_role("Admin"))


# ---------------------------------------------------------------------------
# /host — System Overview tiles
# ---------------------------------------------------------------------------


class HostCpuMemOut(BaseModel):
    cpu_percent: float = 0.0
    cpu_per_core: list[float] = Field(default_factory=list)
    cpu_count_logical: int = 0
    cpu_count_physical: int = 0
    load_avg_1m: Optional[float] = None
    load_avg_5m: Optional[float] = None
    load_avg_15m: Optional[float] = None
    mem_used_mb: int = 0
    mem_total_mb: int = 0
    mem_available_mb: int = 0
    mem_percent: float = 0.0
    swap_used_mb: int = 0
    swap_total_mb: int = 0
    swap_percent: float = 0.0
    uptime_sec: int = 0


class HostDiskOut(BaseModel):
    data_partition_path: str
    used_gb: float
    total_gb: float
    percent: float
    read_mb_s: Optional[float] = None
    write_mb_s: Optional[float] = None
    face_crops_count: int = 0
    face_crops_size_gb: float = 0.0


class HostNetworkOut(BaseModel):
    sent_mb_s: Optional[float] = None
    recv_mb_s: Optional[float] = None


class BackendProcessOut(BaseModel):
    cpu_percent: float = 0.0
    memory_mb: float = 0.0
    threads: int = 0
    open_files: int = 0


class HostGpuOut(BaseModel):
    available: bool = False
    percent: Optional[float] = None
    memory_used_mb: Optional[float] = None
    memory_total_mb: Optional[float] = None


class ThreadInfoOut(BaseModel):
    name: str
    daemon: bool
    alive: bool
    cpu_user_s: Optional[float] = None
    cpu_system_s: Optional[float] = None


class ThreadCategoryOut(BaseModel):
    category: str  # stable key — UI translates via i18n
    display: str   # English fallback
    count: int
    cpu_user_s: float = 0.0
    cpu_system_s: float = 0.0
    threads: list[ThreadInfoOut] = Field(default_factory=list)


class ThreadBreakdownOut(BaseModel):
    total: int
    categories: list[ThreadCategoryOut] = Field(default_factory=list)


class ResourcesHostOut(BaseModel):
    host: HostCpuMemOut
    disk: HostDiskOut
    network: HostNetworkOut
    backend_process: BackendProcessOut
    gpu: HostGpuOut
    thread_breakdown: ThreadBreakdownOut
    generated_at: str


@router.get("/host", response_model=ResourcesHostOut)
def get_resources_host(
    user: Annotated[CurrentUser, ADMIN],
) -> ResourcesHostOut:
    """System Overview tiles.

    Host metrics are host-wide regardless of which tenant Admin asks
    — the host is shared. We document that label in the Resources tab
    UI rather than per-tenant the numbers (which would be a lie on a
    multi-tenant box).

    No audit row — polled every 5 s. The action of changing host
    state lives elsewhere and audits there.
    """

    cpu_mem = host_metrics.read_host_cpu_mem()
    disk = host_metrics.read_host_disk()
    network = host_metrics.read_host_network()
    backend = host_metrics.read_backend_process()
    gpu = host_metrics.read_gpu_optional()
    crops_count, crops_gb = host_metrics.face_crops_size()
    threads = host_metrics.read_thread_breakdown()

    return ResourcesHostOut(
        host=HostCpuMemOut(**cpu_mem.__dict__),
        disk=HostDiskOut(
            data_partition_path=disk.data_partition_path,
            used_gb=disk.used_gb,
            total_gb=disk.total_gb,
            percent=disk.percent,
            read_mb_s=disk.read_mb_s,
            write_mb_s=disk.write_mb_s,
            face_crops_count=crops_count,
            face_crops_size_gb=crops_gb,
        ),
        network=HostNetworkOut(
            sent_mb_s=network.sent_mb_s,
            recv_mb_s=network.recv_mb_s,
        ),
        backend_process=BackendProcessOut(**backend.__dict__),
        gpu=HostGpuOut(**gpu.__dict__),
        thread_breakdown=ThreadBreakdownOut(
            total=threads.total,
            categories=[
                ThreadCategoryOut(
                    category=c.category,
                    display=c.display,
                    count=c.count,
                    cpu_user_s=c.cpu_user_s,
                    cpu_system_s=c.cpu_system_s,
                    threads=[
                        ThreadInfoOut(
                            name=ti.name,
                            daemon=ti.daemon,
                            alive=ti.alive,
                            cpu_user_s=ti.cpu_user_s,
                            cpu_system_s=ti.cpu_system_s,
                        )
                        for ti in c.threads
                    ],
                )
                for c in threads.categories
            ],
        ),
        generated_at=datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    )


# ---------------------------------------------------------------------------
# /cameras — Per-camera resource view
# ---------------------------------------------------------------------------


class CameraResourceOut(BaseModel):
    """Per-camera resource view. Tenant-scoped — only this tenant's
    running workers appear.

    Note that ``cpu_share_estimate_pct`` and ``memory_share_estimate_mb``
    are derived heuristics, NOT thread-level psutil measurements (which
    are noisy at sub-second windows). ``bytes_received_60s`` comes from
    the ``ss -tnpi`` sampler driven by the CaptureManager reconcile
    tick — ``None`` when the sampler couldn't read (ss missing or no
    matching socket).
    """

    tenant_id: int
    camera_id: int
    camera_name: str
    cpu_share_estimate_pct: Optional[float] = None
    memory_share_estimate_mb: Optional[float] = None
    fps_reader: float = 0.0
    fps_analyzer: float = 0.0
    reader_frames_60s: int = 0
    frames_analyzed_60s: int = 0
    frames_motion_skipped_60s: int = 0
    frame_drops_60s: int = 0
    rtsp_reconnects_60s: int = 0
    bytes_received_60s: Optional[int] = None
    clip_recording_active: bool = False
    clip_queue_size: int = 0


class ResourcesCamerasOut(BaseModel):
    cameras: list[CameraResourceOut]
    generated_at: str


@router.get("/cameras", response_model=ResourcesCamerasOut)
def get_resources_cameras(
    user: Annotated[CurrentUser, ADMIN],
) -> ResourcesCamerasOut:
    """Per-camera resource share for every running worker on the
    requesting Admin's tenant.

    Tenant isolation: ``CaptureManager.get_resource_stats_for_tenant``
    filters on ``tenant_id`` in the workers dict; a cross-tenant guess
    of a camera_id returns nothing rather than another tenant's data.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    rows = capture_manager.get_resource_stats_for_tenant(scope.tenant_id)
    cameras = [CameraResourceOut(**r) for r in rows]
    return ResourcesCamerasOut(
        cameras=cameras,
        generated_at=datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    )


# ---------------------------------------------------------------------------
# /stages — Pipeline stage breakdown
# ---------------------------------------------------------------------------


StageScope = Literal["per_camera", "shared_backend_process"]


class StageRowOut(BaseModel):
    key: str
    display: str
    scope: StageScope
    cpu_label: str  # human-readable; the UI doesn't try to compute %
    queue_size: Optional[int] = None
    avg_processing_ms: Optional[float] = None
    p95_processing_ms: Optional[float] = None
    throughput_per_min: Optional[int] = None
    error_count_5min: int = 0
    detail: str = ""
    extras: dict[str, Any] = Field(default_factory=dict)


class ResourcesStagesOut(BaseModel):
    stages: list[StageRowOut]
    generated_at: str


@router.get("/stages", response_model=ResourcesStagesOut)
def get_resources_stages(
    user: Annotated[CurrentUser, ADMIN],
) -> ResourcesStagesOut:
    """Per-stage breakdown across the capture pipeline.

    Five stages:

    * ``rtsp_reader``  — per-camera aggregate (reader fps + reconnects)
    * ``detection``    — shared backend process (detector lock + timing)
    * ``matching``     — shared backend process (matcher cache timing)
    * ``attendance``   — shared backend process (last scheduler run)
    * ``clip_save``    — per-camera aggregate (clip-worker queue + timing)

    ``detection`` and ``matching`` are labelled ``shared_backend_process``
    because the underlying primitives (``_detect_lock``, ``matcher_cache``)
    are process-global. Their numbers are host-wide, not per-tenant —
    the UI calls this out explicitly.

    ``rtsp_reader`` and ``clip_save`` ARE tenant-scoped: we sum over
    only this tenant's running workers.
    """

    from maugood.attendance.scheduler import (  # noqa: PLC0415
        last_run_stats as attendance_last_run_stats,
    )
    from maugood.capture import capture_manager  # noqa: PLC0415
    from maugood.detection.detectors import _detect_lock  # noqa: PLC0415
    from maugood.identification.matcher import (  # noqa: PLC0415
        matcher_cache,
    )

    scope = TenantScope(tenant_id=user.tenant_id)

    # Tenant-scoped worker rollup for rtsp_reader + clip_save.
    workers = capture_manager.workers_for_tenant(scope.tenant_id)
    sum_fps_reader = 0.0
    sum_errors_5min = 0
    sum_clip_queue = 0
    sum_clip_calls_60s = 0
    clip_avg_ms_samples: list[float] = []
    clip_p95_ms_samples: list[float] = []
    clip_errors_5min_total = 0

    for _cam_id, w in workers:
        try:
            stats = w.get_full_stats()
            sum_fps_reader += float(stats.get("fps_reader", 0.0) or 0.0)
            sum_errors_5min += int(stats.get("errors_5min", 0) or 0)
        except Exception:  # noqa: BLE001
            pass

        # Pull the worker's clip-worker timing stats. The clip worker
        # lives on the CaptureWorker; we have to reach into the
        # protected attr because the public ``get_recording_state``
        # doesn't surface timing.
        try:
            clip = getattr(w, "_clip_worker", None)
            if clip is not None:
                sum_clip_queue += int(clip.queue_size())
                ts = clip.finalize_timing_stats()
                if ts.get("calls_60s"):
                    sum_clip_calls_60s += int(ts["calls_60s"])
                    if ts.get("avg_processing_ms") is not None:
                        clip_avg_ms_samples.append(float(ts["avg_processing_ms"]))
                    if ts.get("p95_processing_ms") is not None:
                        clip_p95_ms_samples.append(float(ts["p95_processing_ms"]))
                clip_errors_5min_total += int(ts.get("errors_5min", 0) or 0)
        except Exception:  # noqa: BLE001
            pass

    rtsp_throughput = int(sum_fps_reader * 60)

    rtsp_stage = StageRowOut(
        key="rtsp_reader",
        display="RTSP Reader",
        scope="per_camera",
        cpu_label="reader_thread_shared",
        queue_size=None,
        avg_processing_ms=None,
        p95_processing_ms=None,
        throughput_per_min=rtsp_throughput,
        error_count_5min=sum_errors_5min,
        detail=(
            "Per-camera RTSP read loop. CPU is shared across reader "
            "threads — the actionable signal is fps_reader on each "
            "camera + the reconnect count."
        ),
        extras={"running_workers": len(workers)},
    )

    # Detection — shared backend process.
    det = _detect_lock.timing_stats_60s()
    detection_stage = StageRowOut(
        key="detection",
        display="Person + Face Detection",
        scope="shared_backend_process",
        cpu_label="detector_lock_serialised",
        queue_size=None,
        avg_processing_ms=det.get("avg_held_ms"),
        p95_processing_ms=det.get("p95_held_ms"),
        throughput_per_min=int(det.get("calls_60s", 0)) * 1
        if det.get("calls_60s") is not None
        else None,
        error_count_5min=0,
        detail=(
            "Serialised via the module-level _detect_lock. Numbers are "
            "host-wide across every camera, not just this tenant."
        ),
        extras={"contention_pct_60s": det.get("contention_pct", 0.0)},
    )

    # Matching — shared backend process.
    mat = matcher_cache.match_timing_stats()
    matching_stage = StageRowOut(
        key="matching",
        display="Face Matching",
        scope="shared_backend_process",
        cpu_label="matcher_cache_shared",
        queue_size=0,  # synchronous in caller — no real queue
        avg_processing_ms=mat.get("avg_processing_ms"),
        p95_processing_ms=mat.get("p95_processing_ms"),
        throughput_per_min=int(mat.get("calls_60s", 0))
        if mat.get("calls_60s") is not None
        else None,
        error_count_5min=0,
        detail=(
            "Cosine-similarity match against enrolled embeddings. "
            "Numbers are host-wide across every tenant."
        ),
        extras={},
    )

    # Attendance — shared, last scheduler run timing.
    att = attendance_last_run_stats()
    attendance_stage = StageRowOut(
        key="attendance",
        display="Attendance Compute",
        scope="shared_backend_process",
        cpu_label="scheduler_thread_shared",
        queue_size=None,
        avg_processing_ms=att.get("last_run_duration_ms"),
        p95_processing_ms=None,
        throughput_per_min=None,
        error_count_5min=0,
        detail=(
            "Periodic scheduler job — runs every "
            "MAUGOOD_ATTENDANCE_RECOMPUTE_MINUTES across all tenants."
        ),
        extras={
            "last_run_at": att.get("last_run_at"),
            "last_run_rows": att.get("last_run_rows"),
        },
    )

    # Clip save — per-camera, aggregated.
    clip_avg_ms = (
        round(sum(clip_avg_ms_samples) / len(clip_avg_ms_samples), 2)
        if clip_avg_ms_samples
        else None
    )
    clip_p95_ms = (
        round(max(clip_p95_ms_samples), 2) if clip_p95_ms_samples else None
    )
    clip_stage = StageRowOut(
        key="clip_save",
        display="Clip Save",
        scope="per_camera",
        cpu_label="ffmpeg_subprocess_per_camera",
        queue_size=sum_clip_queue,
        avg_processing_ms=clip_avg_ms,
        p95_processing_ms=clip_p95_ms,
        throughput_per_min=sum_clip_calls_60s if sum_clip_calls_60s else 0,
        error_count_5min=clip_errors_5min_total,
        detail=(
            "ffmpeg subprocess per camera. CPU is psutil-attributable "
            "to the ffmpeg PID; we don't measure that yet — surface "
            "queue size + per-finalize duration as the actionable "
            "signal."
        ),
        extras={"running_workers": len(workers)},
    )

    return ResourcesStagesOut(
        stages=[
            rtsp_stage,
            detection_stage,
            matching_stage,
            attendance_stage,
            clip_stage,
        ],
        generated_at=datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    )
