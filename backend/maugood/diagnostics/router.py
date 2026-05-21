"""FastAPI router — TEMP-DIAGNOSTIC-2026-05-20.

Endpoints under ``/api/diagnostics`` for the Frame Diagnostics tab.
Admin-only. Returns server-wide data (cross-tenant) because the
investigation target is server-side performance — the operator
running this needs to see all cameras' anomalies, including those
in tenants other than their session's home tenant.

Removal: this whole file goes when ``maugood/diagnostics/`` does.
"""

from __future__ import annotations

import time
from typing import Annotated, Any

import psutil
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from maugood.auth.dependencies import CurrentUser, require_role
from maugood.capture import capture_manager
from maugood.diagnostics import recorder

ADMIN = Depends(require_role("Admin"))

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])


# --- State + control -------------------------------------------------------


class StateOut(BaseModel):
    enabled: bool
    session_started_at: float
    session_started_ago_s: float
    event_count: int


@router.get("/state", response_model=StateOut)
def get_state(_user: Annotated[CurrentUser, ADMIN]) -> StateOut:
    """Return current diagnostics state.

    UI polls this on tab mount + after every Start/Stop click so the
    button state always reflects the server's truth (matters in
    multi-operator scenarios — two Admins on the same diagnostic
    session shouldn't disagree about whether it's running).
    """

    now = time.time()
    started = recorder.session_started_at()
    return StateOut(
        enabled=recorder.is_enabled(),
        session_started_at=started,
        session_started_ago_s=round(max(0.0, now - started), 1),
        event_count=len(recorder.snapshot()),
    )


@router.post("/start", response_model=StateOut)
def start(_user: Annotated[CurrentUser, ADMIN]) -> StateOut:
    recorder.set_enabled(True)
    return get_state(_user)


@router.post("/stop", response_model=StateOut)
def stop(_user: Annotated[CurrentUser, ADMIN]) -> StateOut:
    recorder.set_enabled(False)
    return get_state(_user)


@router.post("/clear", response_model=StateOut)
def clear(_user: Annotated[CurrentUser, ADMIN]) -> StateOut:
    recorder.clear()
    return get_state(_user)


# --- Events ----------------------------------------------------------------


class EventOut(BaseModel):
    ts: float
    tenant_id: int | None
    camera_id: int | None
    camera_name: str | None
    kind: str
    reason: str
    metrics: dict[str, Any]


class EventsResponse(BaseModel):
    events: list[EventOut]
    enabled: bool
    session_started_at: float


@router.get("/events", response_model=EventsResponse)
def list_events(
    _user: Annotated[CurrentUser, ADMIN],
    since_ts: float | None = Query(
        default=None,
        description="Return only events with ts > since_ts. UI sends the "
        "last seen ts for incremental polling.",
    ),
    camera_id: int | None = Query(default=None),
    kind: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=2000),
) -> EventsResponse:
    events = recorder.snapshot(
        since_ts=since_ts, camera_id=camera_id, kind=kind, limit=limit
    )
    return EventsResponse(
        events=[EventOut(**e) for e in events],
        enabled=recorder.is_enabled(),
        session_started_at=recorder.session_started_at(),
    )


# --- Live system snapshot --------------------------------------------------
# Composes data the UI tab refreshes alongside the event stream so the
# operator can see "while frame_slow events are firing, host CPU is
# X% and per-camera fps_reader is Y" in one place.


class CameraLive(BaseModel):
    tenant_id: int
    camera_id: int
    camera_name: str
    status: str
    fps_reader: float
    fps_analyzer: float
    motion_skipped_60s: int
    frames_analyzed_60s: int
    faces_saved_60s: int
    matches_60s: int
    native_fps: float | None
    pipeline_stages: dict[str, str]  # stage name → state (green/amber/red/unknown)


class SystemSnapshotOut(BaseModel):
    ts: float
    host_cpu_percent_overall: float
    host_cpu_percent_per_core: list[float]
    host_memory_percent: float
    host_memory_used_gb: float
    host_memory_total_gb: float
    process_count: int
    thread_count: int
    cameras: list[CameraLive]


@router.get("/system-snapshot", response_model=SystemSnapshotOut)
def system_snapshot(_user: Annotated[CurrentUser, ADMIN]) -> SystemSnapshotOut:
    """Live host + per-camera snapshot.

    The CPU read does NOT use ``interval=`` (which would block for
    1 s and make the UI laggy). The non-blocking read is "since
    the last call" — good enough for trend visualisation.
    """

    cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
    overall = sum(cpu_per_core) / max(1, len(cpu_per_core))
    mem = psutil.virtual_memory()

    cameras: list[CameraLive] = []
    try:
        stats = capture_manager.get_full_worker_stats()
    except Exception:  # noqa: BLE001 — never let the snapshot bring down the tab
        stats = []
    for s in stats:
        stages = s.get("stages", {}) or {}
        cameras.append(CameraLive(
            tenant_id=int(s.get("tenant_id") or 0),
            camera_id=int(s.get("camera_id") or 0),
            camera_name=str(s.get("camera_name") or ""),
            status=str(s.get("status") or "unknown"),
            fps_reader=float(s.get("fps_reader") or 0.0),
            fps_analyzer=float(s.get("fps_analyzer") or 0.0),
            motion_skipped_60s=int(s.get("frames_motion_skipped_60s") or 0),
            frames_analyzed_60s=int(s.get("frames_analyzed_60s") or 0),
            faces_saved_60s=int(s.get("faces_saved_60s") or 0),
            matches_60s=int(s.get("matches_60s") or 0),
            native_fps=(s.get("metadata") or {}).get("fps"),
            pipeline_stages={
                name: str((info or {}).get("state") or "unknown")
                for name, info in stages.items()
            },
        ))

    return SystemSnapshotOut(
        ts=time.time(),
        host_cpu_percent_overall=round(overall, 1),
        host_cpu_percent_per_core=[round(c, 1) for c in cpu_per_core],
        host_memory_percent=round(mem.percent, 1),
        host_memory_used_gb=round(mem.used / (1024**3), 2),
        host_memory_total_gb=round(mem.total / (1024**3), 2),
        process_count=len(psutil.pids()),
        thread_count=sum(
            (p.num_threads() for p in psutil.process_iter(["num_threads"])
             if p.info.get("num_threads") is not None),
            0,
        ),
        cameras=cameras,
    )
