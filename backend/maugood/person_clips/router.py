"""API endpoints for person clips — /api/person-clips/*.

All endpoints require authentication. List/stats/system-stats are available
to Admin and HR; stream/delete are Admin-only.

New in migration 0048+:
  GET  /api/person-clips/{id}/processing-results  — per-UC results
  GET  /api/person-clips/system-stats             — resources + queue + pipeline
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select, text

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, current_user, require_any_role, require_role
from maugood.config import get_settings
from maugood.db import (
    cameras,
    clip_processing_results,
    employees,
    face_crops,
    get_engine,
    person_clips,
)
from maugood.employees.photos import decrypt_bytes
from maugood.person_clips.repository import bulk_delete_clips, delete_clip, get_clip, get_stats, list_clips
from maugood.person_clips.reprocess import (
    ALL_USE_CASES,
    DEFAULT_USE_CASES,
    get_reprocess_worker,
    is_single_clip_running,
    trigger_single_clip_reprocess,
)
from maugood.person_clips.schemas import (
    BulkDeleteClipRequest,
    BulkDeleteClipResponse,
    ClipProcessingResult,
    ClipProcessingResultsResponse,
    FaceCropListResponse,
    FaceCropOut,
    PersonClipListResponse,
    PersonClipOut,
    PersonClipStats,
    PipelineStats,
    ReprocessFaceMatchRequest,
    ReprocessFaceMatchResponse,
    ReprocessFaceMatchStatus,
    SingleClipReprocessRequest,
    SingleClipReprocessResponse,
    StorageStats,
    SystemResourceStats,
    ClipQueueStats,
    WorkerStatus,
    SystemStatsResponse,
)
from maugood.tenants.scope import TenantScope, resolve_tenant_schema_via_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/person-clips", tags=["person-clips"])

ADMIN = Depends(require_role("Admin"))
HR_OR_ADMIN = Depends(require_any_role("Admin", "HR"))


def _resolve_employee_names(conn, scope: TenantScope, all_matched_ids: set[int]) -> dict[int, str]:
    if not all_matched_ids:
        return {}
    rows = conn.execute(
        select(employees.c.id, employees.c.full_name).where(
            employees.c.id.in_(list(all_matched_ids)),
            employees.c.tenant_id == scope.tenant_id,
        )
    ).all()
    return {r.id: r.full_name for r in rows}


def _row_to_out(row, name_map: dict[int, str] | None = None) -> PersonClipOut:
    matched: list[int] = []
    raw = getattr(row, "matched_employees", None)
    if raw is not None and isinstance(raw, list):
        matched = [int(x) for x in raw if isinstance(x, (int, float))]
    names: list[str] = []
    if name_map is not None:
        names = [name_map.get(eid, f"EMP {eid}") for eid in matched]
    return PersonClipOut(
        id=row.id,
        camera_id=row.camera_id,
        camera_name=str(getattr(row, "camera_name", "") or ""),
        employee_id=row.employee_id,
        employee_name=str(getattr(row, "employee_name", "") or None)
        if getattr(row, "employee_name", None)
        else None,
        track_id=row.track_id,
        clip_start=row.clip_start,
        clip_end=row.clip_end,
        duration_seconds=float(row.duration_seconds or 0),
        filesize_bytes=int(row.filesize_bytes or 0),
        frame_count=int(row.frame_count or 0),
        person_count=int(getattr(row, "person_count", 0) or 0),
        matched_employees=matched,
        matched_employee_names=names,
        matched_status=str(getattr(row, "matched_status", "pending") or "pending"),
        person_start=getattr(row, "person_start", None),
        person_end=getattr(row, "person_end", None),
        face_matching_duration_ms=getattr(row, "face_matching_duration_ms", None),
        face_matching_progress=int(getattr(row, "face_matching_progress", 0) or 0),
        encoding_start_at=getattr(row, "encoding_start_at", None),
        encoding_end_at=getattr(row, "encoding_end_at", None),
        fps_recorded=getattr(row, "fps_recorded", None),
        resolution_w=getattr(row, "resolution_w", None),
        resolution_h=getattr(row, "resolution_h", None),
        detection_source=str(
            getattr(row, "detection_source", "face") or "face"
        ),
        chunk_count=int(getattr(row, "chunk_count", 1) or 1),
        recording_status=str(
            getattr(row, "recording_status", "completed") or "completed"
        ),
        created_at=row.created_at,
    )


# ---------------------------------------------------------------------------
# System stats (declared before /{clip_id} so it routes cleanly)
# ---------------------------------------------------------------------------

@router.get("/system-stats", response_model=SystemStatsResponse)
def get_system_stats(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> SystemStatsResponse:
    """Return system resource usage, clip queue depth, and pipeline stats."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    settings = get_settings()

    # --- Resources (psutil) -------------------------------------------------
    import psutil  # noqa: PLC0415

    cpu_per_core = psutil.cpu_percent(percpu=True, interval=0.1)
    cpu_per_core_list = cpu_per_core if isinstance(cpu_per_core, list) else [float(cpu_per_core)]
    cpu_total = sum(cpu_per_core_list) / max(1, len(cpu_per_core_list))
    mem = psutil.virtual_memory()

    # GPU — try py3nvml; gracefully skip if not available
    gpu_available = False
    gpu_percent: Optional[float] = None
    gpu_memory_used_mb: Optional[float] = None
    gpu_memory_total_mb: Optional[float] = None
    try:
        import pynvml  # type: ignore[import-untyped]  # noqa: PLC0415
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        gpu_available = True
        gpu_percent = float(util.gpu)
        gpu_memory_used_mb = round(mem_info.used / 1024 / 1024, 1)
        gpu_memory_total_mb = round(mem_info.total / 1024 / 1024, 1)
    except Exception:  # noqa: BLE001
        pass

    resources = SystemResourceStats(
        cpu_percent_per_core=cpu_per_core_list,
        cpu_percent_total=round(cpu_total, 1),
        memory_total_mb=round(mem.total / 1024 / 1024, 1),
        memory_used_mb=round(mem.used / 1024 / 1024, 1),
        memory_percent=round(mem.percent, 1),
        gpu_available=gpu_available,
        gpu_percent=gpu_percent,
        gpu_memory_used_mb=gpu_memory_used_mb,
        gpu_memory_total_mb=gpu_memory_total_mb,
    )

    # --- Storage --------------------------------------------------------------
    clips_root = settings.clip_storage_root
    total_clips_bytes = 0
    clip_files_count = 0
    clips_path = Path(clips_root)
    if clips_path.exists():
        for f in clips_path.rglob("*.mp4"):
            try:
                total_clips_bytes += f.stat().st_size
                clip_files_count += 1
            except OSError:
                pass
        # Also count legacy path
    legacy_path = Path(settings.person_clips_storage_path)
    if legacy_path.exists():
        for f in legacy_path.rglob("*.mp4"):
            try:
                total_clips_bytes += f.stat().st_size
                clip_files_count += 1
            except OSError:
                pass

    try:
        disk = psutil.disk_usage(clips_root if clips_path.exists() else "/")
        total_gb = round(disk.total / 1024 ** 3, 2)
        used_gb = round(disk.used / 1024 ** 3, 2)
        free_gb = round(disk.free / 1024 ** 3, 2)
    except OSError:
        total_gb = used_gb = free_gb = 0.0

    storage = StorageStats(
        clips_root=clips_root,
        total_gb=total_gb,
        used_gb=used_gb,
        free_gb=free_gb,
        clip_files_count=clip_files_count,
        clip_files_total_mb=round(total_clips_bytes / 1024 / 1024, 2),
    )

    # --- Clip queue (from capture manager's clip workers) -------------------
    worker_statuses: list[WorkerStatus] = []
    try:
        from maugood.capture import capture_manager  # noqa: PLC0415
        for (tid, cam_id), worker in capture_manager._workers.items():
            if tid != user.tenant_id:
                continue
            cw = getattr(worker, "_clip_worker", None)
            if cw is None:
                continue
            worker_statuses.append(WorkerStatus(
                camera_id=cam_id,
                camera_name=getattr(worker, "camera_name", f"Camera {cam_id}"),
                tenant_id=tid,
                is_alive=cw.is_alive(),
                queue_size=cw.queue_size(),
            ))
    except Exception:  # noqa: BLE001
        pass

    alive = sum(1 for w in worker_statuses if w.is_alive)
    total_q = sum(w.queue_size for w in worker_statuses)
    clip_queue = ClipQueueStats(
        total_workers=len(worker_statuses),
        alive_workers=alive,
        total_queue_depth=total_q,
        workers=worker_statuses,
    )

    # --- Pipeline stats (DB aggregates) ------------------------------------
    with engine.begin() as conn:
        total_clips = conn.execute(
            select(func.count(person_clips.c.id)).where(
                person_clips.c.tenant_id == scope.tenant_id
            )
        ).scalar_one()

        status_counts = conn.execute(
            select(
                person_clips.c.matched_status,
                func.count(person_clips.c.id).label("cnt"),
            )
            .where(person_clips.c.tenant_id == scope.tenant_id)
            .group_by(person_clips.c.matched_status)
        ).all()
        sc = {r.matched_status: r.cnt for r in status_counts}

        # Per-UC aggregates from clip_processing_results
        uc_stats = conn.execute(
            select(
                clip_processing_results.c.use_case,
                func.count(clip_processing_results.c.id).label("cnt"),
                func.avg(clip_processing_results.c.duration_ms).label("avg_ms"),
            )
            .where(
                clip_processing_results.c.tenant_id == scope.tenant_id,
                clip_processing_results.c.status == "completed",
            )
            .group_by(clip_processing_results.c.use_case)
        ).all()
        uc_map = {r.use_case: {"cnt": r.cnt, "avg_ms": r.avg_ms} for r in uc_stats}

    pipeline = PipelineStats(
        total_clips=int(total_clips),
        clips_pending=int(sc.get("pending", 0)),
        clips_processing=int(sc.get("processing", 0)),
        clips_completed=int(sc.get("processed", 0)),
        clips_failed=int(sc.get("failed", 0)),
        uc1_completed=int(uc_map.get("uc1", {}).get("cnt", 0)),
        uc2_completed=int(uc_map.get("uc2", {}).get("cnt", 0)),
        uc3_completed=int(uc_map.get("uc3", {}).get("cnt", 0)),
        avg_uc1_duration_ms=uc_map.get("uc1", {}).get("avg_ms"),
        avg_uc2_duration_ms=uc_map.get("uc2", {}).get("avg_ms"),
        avg_uc3_duration_ms=uc_map.get("uc3", {}).get("avg_ms"),
    )

    # Reprocess status
    raw = get_reprocess_worker().get_status()
    reprocess_status = ReprocessFaceMatchStatus(
        status=raw.get("status", "idle"),
        mode=raw.get("mode", "all"),
        use_cases=raw.get("use_cases", list(DEFAULT_USE_CASES)),
        total_clips=raw.get("total_clips", 0),
        processed_clips=raw.get("processed_clips", 0),
        matched_total=raw.get("matched_total", 0),
        failed_count=raw.get("failed_count", 0),
        errors=raw.get("errors", []),
        started_at=raw.get("started_at"),
        ended_at=raw.get("ended_at"),
    )

    return SystemStatsResponse(
        resources=resources,
        storage=storage,
        clip_queue=clip_queue,
        pipeline=pipeline,
        reprocess_status=reprocess_status,
    )


# ---------------------------------------------------------------------------
# List + stats
# ---------------------------------------------------------------------------

@router.get("", response_model=PersonClipListResponse)
def list_person_clips(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    camera_id: Optional[int] = Query(default=None),
    employee_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
    detection_source: Optional[str] = Query(
        default=None,
        description=(
            "Filter by which detector triggered the clip. "
            "One of 'face', 'body', 'both'. Omitted = all."
        ),
        pattern=r"^(face|body|both)$",
    ),
    recording_status: Optional[str] = Query(
        default=None,
        description=(
            "Filter by recording lifecycle. One of 'recording', "
            "'finalizing', 'completed', 'failed', 'abandoned'. "
            "Omitted = all (default also hides failed/abandoned)."
        ),
        pattern=r"^(recording|finalizing|completed|failed|abandoned)$",
    ),
    matched_status: Optional[str] = Query(
        default=None,
        description=(
            "Filter by face-matching pipeline status. One of "
            "'pending', 'processing', 'processed', 'failed'. "
            "Omitted = no matched_status filter."
        ),
        pattern=r"^(pending|processing|processed|failed)$",
    ),
) -> PersonClipListResponse:
    """List person clips, with optional filters."""

    scope = TenantScope(tenant_id=user.tenant_id)
    start_dt: Optional[datetime] = None
    end_dt: Optional[datetime] = None
    if start:
        try:
            start_dt = datetime.fromisoformat(start)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid start date") from exc
    if end:
        try:
            end_dt = datetime.fromisoformat(end)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid end date") from exc

    with get_engine().begin() as conn:
        rows, total = list_clips(
            conn, scope, page=page, page_size=page_size,
            camera_id=camera_id, employee_id=employee_id,
            start=start_dt, end=end_dt,
            detection_source=detection_source,
            recording_status=recording_status,
            matched_status=matched_status,
        )
        all_ids: set[int] = set()
        for r in rows:
            raw = getattr(r, "matched_employees", None)
            if raw is not None and isinstance(raw, list):
                for eid in raw:
                    if isinstance(eid, (int, float)):
                        all_ids.add(int(eid))
        name_map = _resolve_employee_names(conn, scope, all_ids)

    # Migration 0054 — overlay live person counts on the 🔴 LIVE
    # rows. The placeholder INSERT at clip start sets person_count=0;
    # without this overlay every recording card would show "0 person"
    # until the clip finalizes. Fetch the per-camera live counts from
    # the in-memory worker state in one batch.
    items = [_row_to_out(r, name_map) for r in rows]
    has_recording = any(c.recording_status == "recording" for c in items)
    if has_recording:
        try:
            from maugood.capture import capture_manager  # noqa: PLC0415

            live_counts = capture_manager.get_live_person_counts(
                tenant_id=scope.tenant_id
            )
        except Exception:  # noqa: BLE001
            live_counts = {}
        if live_counts:
            for c in items:
                if c.recording_status != "recording":
                    continue
                live = live_counts.get(int(c.camera_id))
                if live is not None:
                    c.person_count = int(live)

    return PersonClipListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/stats", response_model=PersonClipStats)
def person_clip_stats(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> PersonClipStats:
    """Summary stats for person clips."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        total, size, per_camera = get_stats(conn, scope)

        # Status breakdown counts
        status_rows = conn.execute(
            select(
                person_clips.c.matched_status,
                func.count(person_clips.c.id).label("cnt"),
            )
            .where(person_clips.c.tenant_id == scope.tenant_id)
            .group_by(person_clips.c.matched_status)
        ).all()
    sc = {r.matched_status: int(r.cnt) for r in status_rows}

    return PersonClipStats(
        total_clips=total,
        total_size_bytes=size,
        per_camera=per_camera,
        pending_match=sc.get("pending", 0),
        processing_match=sc.get("processing", 0),
        completed_match=sc.get("processed", 0),
        failed_match=sc.get("failed", 0),
    )


# ---------------------------------------------------------------------------
# Reprocess endpoints
# ---------------------------------------------------------------------------

@router.post("/reprocess-face-match", response_model=ReprocessFaceMatchResponse)
def reprocess_face_match(
    body: ReprocessFaceMatchRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> ReprocessFaceMatchResponse:
    """Start (or resume) reprocessing all saved person clips for face matching.

    ``mode``: ``"all"`` re-processes every clip; ``"skip_existing"`` skips
    clips that already have ``matched_employees``.

    ``use_cases``: list of ``["uc1", "uc2", "uc3"]`` (any combination).
    """

    schema = resolve_tenant_schema_via_engine(get_engine(), user.tenant_id)
    scope = TenantScope(tenant_id=user.tenant_id, tenant_schema=schema)

    # Validate use_cases.
    valid_ucs = [uc for uc in body.use_cases if uc in ALL_USE_CASES]
    if not valid_ucs:
        valid_ucs = list(DEFAULT_USE_CASES)

    worker = get_reprocess_worker()
    if worker.is_running():
        return ReprocessFaceMatchResponse(
            started=False,
            message="Reprocess is already running. "
            "Poll /api/person-clips/reprocess-status for progress.",
        )

    started = worker.trigger(
        scope=scope,
        mode=body.mode,
        use_cases=tuple(valid_ucs),
        actor_user_id=user.id,
    )

    if started:
        logger.info(
            "face match reprocess triggered: tenant=%s mode=%s use_cases=%s by user=%s",
            scope.tenant_id, body.mode, valid_ucs, user.id,
        )
        return ReprocessFaceMatchResponse(
            started=True,
            message=f"Face match reprocess started (use cases: {', '.join(valid_ucs)}). "
            "Poll /api/person-clips/reprocess-status for progress.",
        )

    return ReprocessFaceMatchResponse(started=False, message="Could not start reprocess.")


@router.get("/reprocess-status", response_model=ReprocessFaceMatchStatus)
def reprocess_face_match_status(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> ReprocessFaceMatchStatus:
    """Return the current reprocess status for this tenant."""

    raw = get_reprocess_worker().get_status()
    return ReprocessFaceMatchStatus(
        status=raw.get("status", "idle"),
        mode=raw.get("mode", "all"),
        use_cases=raw.get("use_cases", list(DEFAULT_USE_CASES)),
        total_clips=raw.get("total_clips", 0),
        processed_clips=raw.get("processed_clips", 0),
        matched_total=raw.get("matched_total", 0),
        failed_count=raw.get("failed_count", 0),
        errors=raw.get("errors", []),
        started_at=raw.get("started_at"),
        ended_at=raw.get("ended_at"),
    )


# ---------------------------------------------------------------------------
# Per-clip processing results
# ---------------------------------------------------------------------------

@router.get("/{clip_id}/processing-results", response_model=ClipProcessingResultsResponse)
def get_clip_processing_results(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> ClipProcessingResultsResponse:
    """Return per-use-case processing results for a clip."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)
        if row is None:
            raise HTTPException(status_code=404, detail="person clip not found")

        cpr_rows = conn.execute(
            select(clip_processing_results)
            .where(
                clip_processing_results.c.person_clip_id == clip_id,
                clip_processing_results.c.tenant_id == scope.tenant_id,
            )
            .order_by(clip_processing_results.c.use_case)
        ).all()

        # Collect all matched employee IDs for name resolution.
        all_ids: set[int] = set()
        for cpr in cpr_rows:
            raw_me = getattr(cpr, "matched_employees", None)
            if isinstance(raw_me, list):
                all_ids.update(int(e) for e in raw_me if isinstance(e, (int, float)))
        name_map = _resolve_employee_names(conn, scope, all_ids)

    results: list[ClipProcessingResult] = []
    for cpr in cpr_rows:
        matched = [int(e) for e in (cpr.matched_employees or []) if isinstance(e, (int, float))]
        results.append(ClipProcessingResult(
            id=cpr.id,
            person_clip_id=cpr.person_clip_id,
            use_case=cpr.use_case,
            status=cpr.status,
            started_at=cpr.started_at,
            ended_at=cpr.ended_at,
            duration_ms=cpr.duration_ms,
            face_extract_duration_ms=cpr.face_extract_duration_ms,
            match_duration_ms=cpr.match_duration_ms,
            face_crop_count=int(cpr.face_crop_count or 0),
            matched_employees=matched,
            matched_employee_names=[name_map.get(e, f"EMP {e}") for e in matched],
            unknown_count=int(cpr.unknown_count or 0),
            match_details=cpr.match_details,
            error=cpr.error,
            created_at=cpr.created_at,
        ))

    return ClipProcessingResultsResponse(clip_id=clip_id, results=results)


# ---------------------------------------------------------------------------
# Single-clip reprocess
# ---------------------------------------------------------------------------

@router.post("/{clip_id}/reprocess", response_model=SingleClipReprocessResponse)
def reprocess_single_clip(
    clip_id: int,
    body: SingleClipReprocessRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> SingleClipReprocessResponse:
    """Trigger async face-match reprocessing for one clip.

    Runs in a daemon thread; does not affect the live capture pipeline.
    The caller should poll ``GET /{clip_id}/processing-results`` to track
    per-use-case progress. Returns ``running=True`` when a thread for this
    clip is already live — the frontend should surface a busy indicator
    rather than starting a duplicate.
    """
    scope = TenantScope(tenant_id=user.tenant_id)
    schema = resolve_tenant_schema_via_engine(get_engine(), user.tenant_id)
    scope = TenantScope(tenant_id=user.tenant_id, tenant_schema=schema)

    # Verify the clip belongs to this tenant.
    with get_engine().begin() as conn:
        row = get_clip(conn, scope, clip_id)
    if row is None:
        raise HTTPException(status_code=404, detail="person clip not found")

    if is_single_clip_running(scope.tenant_id, clip_id):
        return SingleClipReprocessResponse(
            started=False,
            running=True,
            message="Reprocess already running for this clip. Poll processing-results for progress.",
        )

    valid_ucs = [uc for uc in body.use_cases if uc in ALL_USE_CASES]
    if not valid_ucs:
        valid_ucs = list(DEFAULT_USE_CASES)

    started = trigger_single_clip_reprocess(
        clip_id=clip_id,
        scope=scope,
        use_cases=tuple(valid_ucs),
        actor_user_id=user.id,
    )

    if started:
        logger.info(
            "single-clip reprocess triggered: tenant=%s clip=%s use_cases=%s by user=%s",
            scope.tenant_id, clip_id, valid_ucs, user.id,
        )
        return SingleClipReprocessResponse(
            started=True,
            running=True,
            message=f"Reprocess started (use cases: {', '.join(valid_ucs)}). "
            "Poll processing-results for progress.",
        )

    return SingleClipReprocessResponse(started=False, message="Could not start reprocess.")


# ---------------------------------------------------------------------------
# Face crop list + image serve
# ---------------------------------------------------------------------------

@router.get("/{clip_id}/face-crops", response_model=FaceCropListResponse)
def list_clip_face_crops(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    use_case: Optional[str] = Query(default=None, description="Filter by use case: uc1, uc2"),
) -> FaceCropListResponse:
    """List face crops stored for a clip, optionally filtered by use case."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        clip_row = get_clip(conn, scope, clip_id)
        if clip_row is None:
            raise HTTPException(status_code=404, detail="person clip not found")

        q = (
            select(
                face_crops,
                employees.c.full_name.label("employee_name"),
            )
            .outerjoin(
                employees,
                (face_crops.c.employee_id == employees.c.id)
                & (face_crops.c.tenant_id == employees.c.tenant_id),
            )
            .where(
                face_crops.c.person_clip_id == clip_id,
                face_crops.c.tenant_id == scope.tenant_id,
            )
            .order_by(face_crops.c.created_at.asc())
        )
        if use_case:
            q = q.where(face_crops.c.use_case == use_case)

        crop_rows = conn.execute(q).all()

    items = [
        FaceCropOut(
            id=r.id,
            person_clip_id=r.person_clip_id,
            camera_id=r.camera_id,
            use_case=r.use_case,
            employee_id=r.employee_id,
            employee_name=getattr(r, "employee_name", None),
            event_timestamp=r.event_timestamp,
            face_index=int(r.face_index),
            quality_score=float(r.quality_score),
            detection_score=float(r.detection_score),
            width=int(r.width),
            height=int(r.height),
            created_at=r.created_at,
        )
        for r in crop_rows
    ]
    return FaceCropListResponse(
        clip_id=clip_id,
        use_case_filter=use_case,
        items=items,
        total=len(items),
    )


@router.get("/{clip_id}/face-crops/{crop_id}/image")
def get_face_crop_image(
    clip_id: int,
    crop_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> Response:
    """Decrypt and serve a face crop JPEG.

    Cross-tenant requests return 404 — the WHERE clause on ``tenant_id``
    enforces this before any file I/O.
    """
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        crop_row = conn.execute(
            select(face_crops).where(
                face_crops.c.id == crop_id,
                face_crops.c.person_clip_id == clip_id,
                face_crops.c.tenant_id == scope.tenant_id,
            )
        ).first()

    if crop_row is None:
        raise HTTPException(status_code=404, detail="face crop not found")
    if not crop_row.file_path:
        raise HTTPException(status_code=410, detail="face crop file missing")

    crop_path = Path(str(crop_row.file_path))
    if not crop_path.exists():
        raise HTTPException(status_code=410, detail="face crop file missing")

    try:
        encrypted = crop_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error(
            "face crop decrypt failed: clip_id=%s crop_id=%s reason=%s",
            clip_id, crop_id, type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="face crop decrypt failed") from exc

    return Response(content=plain, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# Thumbnail + stream
# ---------------------------------------------------------------------------

@router.get("/{clip_id}/thumbnail")
def person_clip_thumbnail(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> Response:
    """Serve the thumbnail (first frame) for a person clip."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        raise HTTPException(status_code=404, detail="person clip not found")
    if not row.file_path:
        raise HTTPException(status_code=410, detail="clip file missing")

    thumb_path = Path(str(row.file_path)).with_suffix(".thumb.jpg")
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="thumbnail not found")

    try:
        encrypted = thumb_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error("thumb decrypt failed: clip_id=%s reason=%s", clip_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail="thumbnail decrypt failed") from exc

    return Response(content=plain, media_type="image/jpeg")


@router.get("/{clip_id}/stream")
def stream_person_clip(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    response: Response,
) -> Response:
    """Stream a person clip video file. Decrypts on the fly."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        raise HTTPException(status_code=404, detail="person clip not found")
    if not row.file_path:
        raise HTTPException(status_code=410, detail="clip file missing")

    file_path = Path(str(row.file_path))
    if not file_path.exists():
        logger.warning("clip file missing on disk: clip_id=%s path=%s", clip_id, file_path)
        raise HTTPException(status_code=410, detail="clip file missing")

    try:
        encrypted = file_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error("clip decrypt failed: clip_id=%s reason=%s", clip_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail="clip decrypt failed") from exc

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="person_clip.streamed",
            entity_type="person_clip",
            entity_id=str(clip_id),
            after={"camera_id": row.camera_id, "employee_id": row.employee_id},
        )

    filename = f"person-clip-{clip_id}.mp4"
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return Response(
        content=plain,
        media_type="video/mp4",
        headers={
            "Content-Length": str(len(plain)),
            "Accept-Ranges": "bytes",
        },
    )


# ---------------------------------------------------------------------------
# Delete endpoints
# ---------------------------------------------------------------------------

@router.post("/bulk-delete", response_model=BulkDeleteClipResponse)
def bulk_delete_person_clips(
    body: BulkDeleteClipRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> BulkDeleteClipResponse:
    """Delete multiple person clips (files + DB rows). Admin-only."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        rows = bulk_delete_clips(conn, scope, body.clip_ids)

    if not rows:
        return BulkDeleteClipResponse(deleted_count=0, deleted_ids=[])

    for row in rows:
        if row.file_path:
            mp4 = Path(str(row.file_path))
            try:
                mp4.unlink(missing_ok=True)
                mp4.with_suffix(".thumb.jpg").unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("clip file delete failed: clip_id=%s reason=%s", row.id, type(exc).__name__)

    with engine.begin() as conn:
        for row in rows:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="person_clip.deleted",
                entity_type="person_clip",
                entity_id=str(row.id),
                before={"camera_id": row.camera_id, "employee_id": row.employee_id},
            )

    deleted_ids = [r.id for r in rows]
    return BulkDeleteClipResponse(deleted_count=len(deleted_ids), deleted_ids=deleted_ids)


@router.delete("/{clip_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_person_clip(
    clip_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    """Delete a person clip (file + DB row). Admin-only."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    # Migration 0054 / 0055 — refuse to delete a row in any in-flight
    # state. ``recording`` = reader is still writing frames.
    # ``finalizing`` = reader handed off, ClipWorker is encoding.
    # Deleting now leaks intermediate files + races with the in-flight
    # UPDATE that flips status → 'completed'.
    if getattr(row, "recording_status", None) in ("recording", "finalizing"):
        raise HTTPException(
            status_code=409,
            detail={
                "field": "recording_status",
                "message": (
                    "clip is still being processed — disable clip "
                    "recording on the camera or wait for the encode "
                    "to finish, then delete"
                ),
            },
        )

    if row.file_path:
        mp4 = Path(str(row.file_path))
        try:
            mp4.unlink(missing_ok=True)
            mp4.with_suffix(".thumb.jpg").unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("clip file delete failed: clip_id=%s reason=%s", clip_id, type(exc).__name__)

    with engine.begin() as conn:
        delete_clip(conn, scope, clip_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="person_clip.deleted",
            entity_type="person_clip",
            entity_id=str(clip_id),
            before={"camera_id": row.camera_id, "employee_id": row.employee_id},
        )

    response.status_code = status.HTTP_204_NO_CONTENT
    return response
