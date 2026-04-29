"""P28.8 — tenant operations router.

Five endpoints, all Admin-only and tenant-scoped:

* ``GET  /api/operations/workers``                        — list + summary
* ``POST /api/operations/workers/{camera_id}/restart``    — single restart
* ``POST /api/operations/workers/restart-all``            — bulk restart
* ``GET  /api/operations/workers/{camera_id}/errors``     — recent errors
* ``PATCH /api/cameras/{id}/metadata``                    — manual fields

Cross-tenant ``camera_id`` returns **404** (not 403) — the camera
doesn't exist *in this tenant's scope*, so we don't acknowledge it
either way.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.capture import capture_manager
from maugood.db import (
    attendance_records,
    audit_log,
    cameras,
    detection_events,
    get_engine,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["operations"])

ADMIN = Depends(require_role("Admin"))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


StageState = Literal["green", "amber", "red", "unknown"]


class StageOut(BaseModel):
    state: StageState
    last_activity_at: Optional[str] = None
    detail: str = ""


class StageSet(BaseModel):
    rtsp: StageOut
    detection: StageOut
    matching: StageOut
    attendance: StageOut


class WorkerMetadataOut(BaseModel):
    resolution_w: Optional[int] = None
    resolution_h: Optional[int] = None
    fps: Optional[float] = None
    codec: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    mount_location: Optional[str] = None
    detected_at: Optional[datetime] = None


class WorkerStatsOut(BaseModel):
    tenant_id: int
    camera_id: int
    camera_name: str
    status: Literal["starting", "running", "reconnecting", "stopped", "failed"]
    started_at: Optional[str] = None
    uptime_sec: int = 0
    stages: StageSet
    fps_reader: float = 0.0
    fps_analyzer: float = 0.0
    frames_analyzed_60s: int = 0
    frames_motion_skipped_60s: int = 0
    faces_saved_60s: int = 0
    matches_60s: int = 0
    errors_5min: int = 0
    recent_errors: list[str] = Field(default_factory=list)
    metadata: WorkerMetadataOut


class WorkersSummary(BaseModel):
    running: int
    configured: int
    stages_red_count: int
    stages_amber_count: int
    errors_5min_total: int
    detection_events_last_hour: int
    faces_saved_last_hour: int
    successful_matches_last_hour: int


class WorkersListOut(BaseModel):
    workers: list[WorkerStatsOut]
    summary: WorkersSummary


class RestartResultOut(BaseModel):
    camera_id: int
    restarted: bool
    status: Literal["starting", "running", "reconnecting", "stopped", "failed"]


class RestartAllOut(BaseModel):
    restarted: int
    failed: int
    total: int


class CameraErrorsOut(BaseModel):
    recent_errors: list[str]
    audit_log_errors: list[dict[str, Any]]


class CameraMetadataIn(BaseModel):
    brand: Optional[str] = Field(default=None, max_length=80)
    model: Optional[str] = Field(default=None, max_length=120)
    mount_location: Optional[str] = Field(default=None, max_length=200)


class CameraMetadataOut(BaseModel):
    camera_id: int
    brand: Optional[str] = None
    model: Optional[str] = None
    mount_location: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _empty_stages(*, worker_enabled: bool) -> StageSet:
    """Default 4-stage shape for a worker that isn't running.

    A *disabled* worker (``worker_enabled=false``) shows every stage
    as ``unknown`` — the operator turned it off on purpose, RTSP red
    would be a false alarm. A worker that *should* be running but
    isn't (capture manager hasn't picked it up yet, or it crashed
    before the manager re-started it) shows RTSP red so the
    operator notices.
    """

    if not worker_enabled:
        return StageSet(
            rtsp=StageOut(state="unknown", detail="Worker disabled"),
            detection=StageOut(state="unknown", detail="Worker disabled"),
            matching=StageOut(state="unknown", detail="Worker disabled"),
            attendance=StageOut(state="unknown", detail="Worker disabled"),
        )
    return StageSet(
        rtsp=StageOut(state="red", detail="Worker not running"),
        detection=StageOut(state="unknown", detail="Worker not running"),
        matching=StageOut(state="unknown", detail="Worker not running"),
        attendance=StageOut(state="unknown", detail="Worker not running"),
    )


def _camera_in_tenant(scope: TenantScope, camera_id: int) -> Optional[dict]:
    """Resolve a camera row with all metadata. Returns None on cross-tenant
    or missing camera — callers convert to 404."""

    with get_engine().begin() as conn:
        row = conn.execute(
            select(
                cameras.c.id,
                cameras.c.name,
                cameras.c.worker_enabled,
                cameras.c.detected_resolution_w,
                cameras.c.detected_resolution_h,
                cameras.c.detected_fps,
                cameras.c.detected_codec,
                cameras.c.detected_at,
                cameras.c.brand,
                cameras.c.model,
                cameras.c.mount_location,
            ).where(
                cameras.c.tenant_id == scope.tenant_id,
                cameras.c.id == camera_id,
            )
        ).first()
    if row is None:
        return None
    return {
        "id": int(row.id),
        "name": str(row.name),
        "worker_enabled": bool(row.worker_enabled),
        "detected_resolution_w": row.detected_resolution_w,
        "detected_resolution_h": row.detected_resolution_h,
        "detected_fps": (
            float(row.detected_fps) if row.detected_fps is not None else None
        ),
        "detected_codec": row.detected_codec,
        "detected_at": row.detected_at,
        "brand": row.brand,
        "model": row.model,
        "mount_location": row.mount_location,
    }


def _stopped_worker_payload(
    scope: TenantScope, *, camera_id: int, camera_row: dict
) -> WorkerStatsOut:
    """Build a synthetic ``WorkerStatsOut`` for a camera whose worker
    isn't running. Pulls metadata from the row so the UI still has the
    full hardware footer."""

    md = WorkerMetadataOut(
        resolution_w=camera_row["detected_resolution_w"],
        resolution_h=camera_row["detected_resolution_h"],
        fps=camera_row["detected_fps"],
        codec=camera_row["detected_codec"],
        brand=camera_row["brand"],
        model=camera_row["model"],
        mount_location=camera_row["mount_location"],
        detected_at=camera_row["detected_at"],
    )
    return WorkerStatsOut(
        tenant_id=scope.tenant_id,
        camera_id=camera_id,
        camera_name=camera_row["name"],
        status="stopped",
        started_at=None,
        uptime_sec=0,
        stages=_empty_stages(worker_enabled=bool(camera_row["worker_enabled"])),
        metadata=md,
    )


def _hydrate_stats(payload: dict, camera_row: dict) -> WorkerStatsOut:
    """Fill ``status`` from the worker's legacy stats dict + tack on the
    full metadata bag (which the worker's own ``get_full_stats``
    already pulls, but tests stub the worker so let's be defensive).
    """

    md_in = payload.get("metadata", {}) or {}
    md = WorkerMetadataOut(
        resolution_w=md_in.get("resolution_w") or camera_row["detected_resolution_w"],
        resolution_h=md_in.get("resolution_h") or camera_row["detected_resolution_h"],
        fps=md_in.get("fps") or camera_row["detected_fps"],
        codec=md_in.get("codec") or camera_row["detected_codec"],
        brand=md_in.get("brand") or camera_row["brand"],
        model=md_in.get("model") or camera_row["model"],
        mount_location=md_in.get("mount_location") or camera_row["mount_location"],
        detected_at=md_in.get("detected_at") or camera_row["detected_at"],
    )
    stages_in = payload.get("stages", {}) or {}
    stages = StageSet(
        rtsp=StageOut(**(stages_in.get("rtsp") or {"state": "unknown"})),
        detection=StageOut(**(stages_in.get("detection") or {"state": "unknown"})),
        matching=StageOut(**(stages_in.get("matching") or {"state": "unknown"})),
        attendance=StageOut(**(stages_in.get("attendance") or {"state": "unknown"})),
    )
    return WorkerStatsOut(
        tenant_id=int(payload.get("tenant_id", 0)),
        camera_id=int(payload["camera_id"]),
        camera_name=str(payload["camera_name"]),
        status=str(payload.get("status", "running")),  # type: ignore[arg-type]
        started_at=payload.get("started_at"),
        uptime_sec=int(payload.get("uptime_sec", 0)),
        stages=stages,
        fps_reader=float(payload.get("fps_reader", 0.0) or 0.0),
        fps_analyzer=float(payload.get("fps_analyzer", 0.0) or 0.0),
        frames_analyzed_60s=int(payload.get("frames_analyzed_60s", 0) or 0),
        frames_motion_skipped_60s=int(
            payload.get("frames_motion_skipped_60s", 0) or 0
        ),
        faces_saved_60s=int(payload.get("faces_saved_60s", 0) or 0),
        matches_60s=int(payload.get("matches_60s", 0) or 0),
        errors_5min=int(payload.get("errors_5min", 0) or 0),
        recent_errors=list(payload.get("recent_errors") or []),
        metadata=md,
    )


def _summary(scope: TenantScope, workers: list[WorkerStatsOut]) -> WorkersSummary:
    """Tenant-wide counters for the summary strip."""

    running = sum(1 for w in workers if w.status == "running")
    red = 0
    amber = 0
    errors_5min_total = 0
    for w in workers:
        for stage in (w.stages.rtsp, w.stages.detection, w.stages.matching, w.stages.attendance):
            if stage.state == "red":
                red += 1
            elif stage.state == "amber":
                amber += 1
        errors_5min_total += w.errors_5min

    one_hour_ago = datetime.now(tz=timezone.utc) - timedelta(hours=1)

    with get_engine().begin() as conn:
        configured = int(
            conn.execute(
                select(func.count())
                .select_from(cameras)
                .where(
                    cameras.c.tenant_id == scope.tenant_id,
                    cameras.c.worker_enabled.is_(True),
                )
            ).scalar_one()
        )
        events_last_hour = int(
            conn.execute(
                select(func.count())
                .select_from(detection_events)
                .where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.captured_at >= one_hour_ago,
                )
            ).scalar_one()
        )
        # Faces saved = events with a non-null face_crop_path.
        faces_last_hour = int(
            conn.execute(
                select(func.count())
                .select_from(detection_events)
                .where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.captured_at >= one_hour_ago,
                    detection_events.c.face_crop_path.is_not(None),
                )
            ).scalar_one()
        )
        # Matches = events that resolved to a live employee_id.
        matches_last_hour = int(
            conn.execute(
                select(func.count())
                .select_from(detection_events)
                .where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.captured_at >= one_hour_ago,
                    detection_events.c.employee_id.is_not(None),
                )
            ).scalar_one()
        )

    return WorkersSummary(
        running=running,
        configured=configured,
        stages_red_count=red,
        stages_amber_count=amber,
        errors_5min_total=errors_5min_total,
        detection_events_last_hour=events_last_hour,
        faces_saved_last_hour=faces_last_hour,
        successful_matches_last_hour=matches_last_hour,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/operations/workers", response_model=WorkersListOut)
def list_workers(user: Annotated[CurrentUser, ADMIN]) -> WorkersListOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    # Resolve every camera row with worker_enabled — this is the
    # "configured" set. Workers may or may not be running; we render
    # both so the operator sees stopped/failed too.
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(
                cameras.c.id,
                cameras.c.name,
                cameras.c.worker_enabled,
                cameras.c.detected_resolution_w,
                cameras.c.detected_resolution_h,
                cameras.c.detected_fps,
                cameras.c.detected_codec,
                cameras.c.detected_at,
                cameras.c.brand,
                cameras.c.model,
                cameras.c.mount_location,
            ).where(cameras.c.tenant_id == scope.tenant_id)
        ).all()

    workers_out: list[WorkerStatsOut] = []
    for r in rows:
        camera_row = {
            "id": int(r.id),
            "name": str(r.name),
            "worker_enabled": bool(r.worker_enabled),
            "detected_resolution_w": r.detected_resolution_w,
            "detected_resolution_h": r.detected_resolution_h,
            "detected_fps": (
                float(r.detected_fps) if r.detected_fps is not None else None
            ),
            "detected_codec": r.detected_codec,
            "detected_at": r.detected_at,
            "brand": r.brand,
            "model": r.model,
            "mount_location": r.mount_location,
        }
        payload = capture_manager.get_full_worker_stats(
            scope.tenant_id, int(r.id)
        )
        if payload is None:
            workers_out.append(
                _stopped_worker_payload(
                    scope, camera_id=int(r.id), camera_row=camera_row
                )
            )
        else:
            workers_out.append(_hydrate_stats(payload, camera_row))

    # Sort: red stages first (most-broken first), then by name for
    # stable ordering across polls.
    def _red_count(w: WorkerStatsOut) -> int:
        return sum(
            1
            for s in (w.stages.rtsp, w.stages.detection, w.stages.matching, w.stages.attendance)
            if s.state == "red"
        )

    workers_out.sort(key=lambda w: (-_red_count(w), w.camera_name))

    return WorkersListOut(
        workers=workers_out, summary=_summary(scope, workers_out)
    )


@router.post(
    "/operations/workers/restart-all", response_model=RestartAllOut
)
def restart_all_workers(user: Annotated[CurrentUser, ADMIN]) -> RestartAllOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    result = capture_manager.restart_all_for_tenant(scope.tenant_id)

    with get_engine().begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="worker_restart_all_requested",
            entity_type="capture_manager",
            entity_id=None,
            after={
                "restarted": result["restarted"],
                "failed": result["failed"],
                "total": result["total"],
            },
        )

    return RestartAllOut(**result)


@router.post(
    "/operations/workers/{camera_id}/restart",
    response_model=RestartResultOut,
)
def restart_one_worker(
    camera_id: int, user: Annotated[CurrentUser, ADMIN]
) -> RestartResultOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    cam = _camera_in_tenant(scope, camera_id)
    if cam is None:
        raise HTTPException(status_code=404, detail="camera not found")

    ok = capture_manager.restart_camera(
        tenant_id=scope.tenant_id, camera_id=camera_id
    )

    with get_engine().begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="worker_restart_requested",
            entity_type="camera",
            entity_id=str(camera_id),
            after={
                "camera_name": cam["name"],
                "restarted": ok,
            },
        )

    payload = capture_manager.get_full_worker_stats(
        scope.tenant_id, camera_id
    )
    new_status = (
        str(payload.get("status", "stopped")) if payload else "stopped"
    )
    return RestartResultOut(
        camera_id=camera_id,
        restarted=ok,
        status=new_status,  # type: ignore[arg-type]
    )


@router.get(
    "/operations/workers/{camera_id}/errors",
    response_model=CameraErrorsOut,
)
def worker_errors(
    camera_id: int, user: Annotated[CurrentUser, ADMIN]
) -> CameraErrorsOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    cam = _camera_in_tenant(scope, camera_id)
    if cam is None:
        raise HTTPException(status_code=404, detail="camera not found")

    worker = capture_manager.get_worker(scope.tenant_id, camera_id)
    recent: list[str] = (
        worker.get_recent_errors() if worker is not None else []
    )

    # Audit-log entries with action 'worker_*_failed' or
    # 'capture.worker.start_failed' for this camera_id, last 20.
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(
                audit_log.c.id,
                audit_log.c.action,
                audit_log.c.created_at,
                audit_log.c.after,
            )
            .where(
                audit_log.c.tenant_id == scope.tenant_id,
                audit_log.c.entity_id == str(camera_id),
                audit_log.c.action.like("capture.worker.%"),
            )
            .order_by(audit_log.c.id.desc())
            .limit(20)
        ).all()

    return CameraErrorsOut(
        recent_errors=recent,
        audit_log_errors=[
            {
                "id": int(r.id),
                "action": str(r.action),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "after": dict(r.after) if r.after else {},
            }
            for r in rows
        ],
    )


@router.patch(
    "/cameras/{camera_id}/metadata", response_model=CameraMetadataOut
)
def patch_camera_metadata(
    camera_id: int,
    payload: CameraMetadataIn,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraMetadataOut:
    """Update the manual metadata fields. Auto-detected columns (resolution,
    fps, codec, detected_at) are NOT settable here — the worker owns
    them. Trying to send them raises 422 from the schema (they're not
    in ``CameraMetadataIn``)."""

    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)
    if not provided:
        raise HTTPException(
            status_code=400, detail="no metadata fields provided"
        )

    with get_engine().begin() as conn:
        before_row = conn.execute(
            select(
                cameras.c.id,
                cameras.c.name,
                cameras.c.brand,
                cameras.c.model,
                cameras.c.mount_location,
            ).where(
                cameras.c.tenant_id == scope.tenant_id,
                cameras.c.id == camera_id,
            )
        ).first()
        if before_row is None:
            raise HTTPException(status_code=404, detail="camera not found")

        from sqlalchemy import update as sa_update  # noqa: PLC0415

        conn.execute(
            sa_update(cameras)
            .where(
                cameras.c.tenant_id == scope.tenant_id,
                cameras.c.id == camera_id,
            )
            .values(**provided)
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.metadata_updated",
            entity_type="camera",
            entity_id=str(camera_id),
            before={
                "brand": before_row.brand,
                "model": before_row.model,
                "mount_location": before_row.mount_location,
            },
            after=provided,
        )

        after_row = conn.execute(
            select(
                cameras.c.brand,
                cameras.c.model,
                cameras.c.mount_location,
            ).where(
                cameras.c.tenant_id == scope.tenant_id,
                cameras.c.id == camera_id,
            )
        ).first()

    return CameraMetadataOut(
        camera_id=camera_id,
        brand=after_row.brand,
        model=after_row.model,
        mount_location=after_row.mount_location,
    )
