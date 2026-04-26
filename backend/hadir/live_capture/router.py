"""Live Capture endpoints (P28.5a).

Four routes — all Admin-only, all tenant-scoped, all audit-logged
on subscription start + close (NEVER per frame; the audit log would
explode at 10 fps × N viewers).

* ``GET /api/cameras/{id}/live.mjpg`` — MJPEG multipart at ~10 fps,
  source is the per-worker ``latest_jpeg`` slot held by the
  ``CaptureWorker`` for that ``(tenant, camera)``. Boxes are baked in
  upstream by the worker's reader thread (using cached detections from
  the analyzer), so the frontend just sets ``<img src=…>``.
* ``GET /api/cameras/{id}/events.ws`` — WebSocket. Detection events
  + heartbeat + per-30s stats. No frames here — pure JSON.
* ``GET /api/cameras/{id}/events.csv?hours=N`` — Streams the camera's
  recent ``detection_events`` rows for the export button.
* ``GET /api/cameras/{id}/live-stats`` — Polled JSON: detections in
  last 10 minutes, known/unknown counts, fps, reachability.

Concurrency caps (per-camera, per-tenant): 10 simultaneous MJPEG
viewers and 10 WebSocket subscribers. Beyond either, return 503 /
close with code 1013. The cap is high because there's no per-viewer
capture cost — only network. All viewers share the single capture
worker via ``CaptureManager.get_preview``.

Tenant isolation red line: every request resolves the camera with
``WHERE id = :id AND tenant_id = :scope_tenant_id``. Cross-tenant
camera_id lookups return 404. The MJPEG and WebSocket handlers
both run that check BEFORE yielding any bytes; the manager itself
also keys workers by ``(tenant_id, camera_id)`` so a forged camera_id
that happens to belong to another tenant can never serve bytes.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, select

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, current_user, require_role
from hadir.auth.sessions import is_expired, load_session, touch_session
from hadir.config import get_settings
from hadir.capture import capture_manager
from hadir.capture.event_bus import event_bus
from hadir.db import (
    camera_health_snapshots,
    cameras,
    detection_events,
    employees,
    get_engine,
    tenant_context,
    tenants,
    user_sessions,
)
from hadir.tenants import TenantScope, get_tenant_scope


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/cameras", tags=["live-capture"])


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Per (tenant, camera) max concurrent viewers. Higher than the early
# spec'd "5" because all viewers share one worker — there's no
# per-viewer capture cost, only network. Tighten if a tenant runs hot.
MAX_MJPEG_VIEWERS_PER_CAMERA = 10
MAX_WS_SUBSCRIBERS_PER_CAMERA = 10

# MJPEG cadence cap. The reader thread updates the per-worker preview
# JPEG at the camera's native fps (often 15-30); we pace at 25 fps
# here to bound bandwidth without throwing away the smoothness gain
# from the P28.5a reader/analyzer split. Boxes baked in upstream means
# this cap doesn't lose information — just bandwidth.
MJPEG_FRAME_INTERVAL_S = 0.04

# Bail-out threshold: 250 ticks × 0.04 s ≈ 10 seconds of no fresh
# frames → end the stream so the browser shows the offline state
# instead of a frozen pixmap.
MJPEG_IDLE_TICK_LIMIT = 250

# 5-second freshness window. The reader pushes at native fps so any
# gap longer than 5 s means the worker is stuck or the camera
# dropped — either way, viewer should reconnect.
FRAME_FRESH_MAX_AGE_S = 5.0

# Initial wait before declaring the buffer offline. Cold-boot of a
# new camera takes ~2 s to produce its first annotated frame; we
# don't want to 503 a client that arrived before the first push.
COLD_START_WAIT_S = 2.0


# ---------------------------------------------------------------------------
# Concurrency tracking
# ---------------------------------------------------------------------------

# Process-global counters. Keyed by (tenant_id, camera_id). The
# locks protect the counter increments — we don't need them to
# protect the per-viewer streams since each viewer has its own
# generator/coroutine.
_mjpeg_lock = threading.Lock()
_mjpeg_counts: dict[tuple[int, int], int] = {}
_ws_lock = threading.Lock()
_ws_counts: dict[tuple[int, int], int] = {}


def _try_acquire_mjpeg(tenant_id: int, camera_id: int) -> bool:
    key = (tenant_id, camera_id)
    with _mjpeg_lock:
        cur = _mjpeg_counts.get(key, 0)
        if cur >= MAX_MJPEG_VIEWERS_PER_CAMERA:
            return False
        _mjpeg_counts[key] = cur + 1
        return True


def _release_mjpeg(tenant_id: int, camera_id: int) -> None:
    key = (tenant_id, camera_id)
    with _mjpeg_lock:
        cur = _mjpeg_counts.get(key, 0)
        if cur <= 1:
            _mjpeg_counts.pop(key, None)
        else:
            _mjpeg_counts[key] = cur - 1


def _try_acquire_ws(tenant_id: int, camera_id: int) -> bool:
    key = (tenant_id, camera_id)
    with _ws_lock:
        cur = _ws_counts.get(key, 0)
        if cur >= MAX_WS_SUBSCRIBERS_PER_CAMERA:
            return False
        _ws_counts[key] = cur + 1
        return True


def _release_ws(tenant_id: int, camera_id: int) -> None:
    key = (tenant_id, camera_id)
    with _ws_lock:
        cur = _ws_counts.get(key, 0)
        if cur <= 1:
            _ws_counts.pop(key, None)
        else:
            _ws_counts[key] = cur - 1


# ---------------------------------------------------------------------------
# Tenant + camera resolution helpers
# ---------------------------------------------------------------------------


def _resolve_camera_in_tenant(
    *, tenant_id: int, camera_id: int
) -> Optional[dict]:
    """Return ``{id, name, enabled}`` if the camera belongs to the
    tenant, ``None`` otherwise. Cross-tenant guesses return None.
    """

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(cameras.c.id, cameras.c.name, cameras.c.enabled).where(
                and_(
                    cameras.c.id == camera_id,
                    cameras.c.tenant_id == tenant_id,
                )
            )
        ).first()
    if row is None:
        return None
    return {"id": int(row.id), "name": str(row.name), "enabled": bool(row.enabled)}


# ---------------------------------------------------------------------------
# /live.mjpg — multipart stream
# ---------------------------------------------------------------------------


@router.get("/{camera_id}/live.mjpg")
def live_mjpg(
    camera_id: int,
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> StreamingResponse:
    """Stream the latest annotated frames as multipart MJPEG.

    Boxes are drawn upstream by the capture worker, so this endpoint
    just paces frame delivery. Caps at ``MJPEG_FRAME_INTERVAL_S``
    (10 fps) regardless of capture rate — viewers seeing the same
    JPEG twice is fine.
    """

    cam = _resolve_camera_in_tenant(tenant_id=scope.tenant_id, camera_id=camera_id)
    if cam is None:
        # 404 on cross-tenant guess — never reveal that the id exists
        # in another tenant. Same shape as employee/photo paths.
        raise HTTPException(status_code=404, detail="camera not found")

    if not _try_acquire_mjpeg(scope.tenant_id, camera_id):
        raise HTTPException(
            status_code=503, detail="too many viewers; try again later"
        )

    # Subscription audit — written ONCE per stream open. Closes are
    # audited from inside the generator's ``finally`` so a network
    # drop counts as an unsubscribe.
    engine = get_engine()
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id if user.id > 0 else None,
            action="live_capture.mjpg.subscribed",
            entity_type="camera",
            entity_id=str(camera_id),
            after={"camera_name": cam["name"]},
        )

    captured_tenant_id = scope.tenant_id
    captured_schema = scope.tenant_schema
    actor_id_for_close = user.id if user.id > 0 else None

    boundary = b"--frame"

    async def gen():  # type: ignore[no-untyped-def]
        cold_deadline = time.time() + COLD_START_WAIT_S
        idle_ticks = 0
        last_ts: float = 0.0
        try:
            while True:
                if await request.is_disconnected():
                    break
                got = capture_manager.get_preview(
                    captured_tenant_id, camera_id
                )
                fresh = (
                    got is not None
                    and (time.time() - got[1]) <= FRAME_FRESH_MAX_AGE_S
                )
                if not fresh:
                    if time.time() < cold_deadline:
                        await asyncio.sleep(MJPEG_FRAME_INTERVAL_S)
                        continue
                    idle_ticks += 1
                    if idle_ticks > MJPEG_IDLE_TICK_LIMIT:
                        break
                    await asyncio.sleep(MJPEG_FRAME_INTERVAL_S)
                    continue
                idle_ticks = 0
                jpg, ts = got  # type: ignore[misc]
                # Skip if the worker hasn't produced a new frame since
                # our last yield — saves bandwidth on a static scene.
                if ts == last_ts:
                    await asyncio.sleep(MJPEG_FRAME_INTERVAL_S)
                    continue
                last_ts = ts
                yield boundary + b"\r\n"
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(jpg)}\r\n\r\n".encode()
                yield jpg + b"\r\n"
                await asyncio.sleep(MJPEG_FRAME_INTERVAL_S)
        finally:
            _release_mjpeg(captured_tenant_id, camera_id)
            try:
                with tenant_context(captured_schema):
                    with get_engine().begin() as conn:
                        write_audit(
                            conn,
                            tenant_id=captured_tenant_id,
                            actor_user_id=actor_id_for_close,
                            action="live_capture.mjpg.unsubscribed",
                            entity_type="camera",
                            entity_id=str(camera_id),
                        )
            except Exception:  # noqa: BLE001
                # Audit failure on close is annoying but non-fatal;
                # the open audit row is already in place.
                logger.debug(
                    "live_mjpg unsubscribe audit failed for camera %d", camera_id
                )

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            # Tell every intermediary not to cache or buffer the
            # stream — most are tuned for normal HTTP requests and
            # would happily hold bytes until the body completes.
            "Cache-Control": "no-cache, no-store, must-revalidate, private",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# /events.ws — WebSocket
# ---------------------------------------------------------------------------


def _ws_authorise(
    websocket: WebSocket,
) -> Optional[tuple[CurrentUser, TenantScope]]:
    """Cookie-only auth for the WebSocket: sessions don't carry
    Authorization headers and we don't want to invent a new auth
    mechanism just for live capture. Returns ``None`` (and lets the
    caller close with a policy-violation code) if anything is wrong.

    Mirrors the HTTP path's auth chain — same session lookup, same
    sliding-expiry refresh, same Admin-role gate. The difference is
    we resolve the tenant cookie once at handshake time and operate
    inside a tenant_context for the whole connection lifetime
    (re-entered on each ``send_json`` block by the outer handler).
    """

    session_id = websocket.cookies.get("hadir_session")
    if not session_id:
        return None
    tenant_cookie = websocket.cookies.get("hadir_tenant") or "main"
    engine = get_engine()
    from hadir.auth.dependencies import (  # noqa: PLC0415
        _load_current_user_bundle,
        primary_role,
    )

    with tenant_context(tenant_cookie):
        with engine.begin() as conn:
            session_row = load_session(conn, session_id)
            if session_row is None or is_expired(session_row):
                return None
            touch_session(
                conn,
                session_row.id,
                idle_minutes=get_settings().session_idle_minutes,
            )
            data = dict(session_row.data or {})
            tenant_schema = str(data.get("tenant_schema") or tenant_cookie)
            tenant_id = int(session_row.tenant_id)

            bundle = _load_current_user_bundle(
                conn, user_id=session_row.user_id, tenant_id=tenant_id
            )
            if bundle is None:
                return None
            active_role = str(
                data.get("active_role") or primary_role(bundle.available_roles)
            )
            if active_role != "Admin":
                return None
            user = CurrentUser(
                id=bundle.id,
                tenant_id=bundle.tenant_id,
                email=bundle.email,
                full_name=bundle.full_name,
                roles=(active_role,),
                available_roles=bundle.available_roles,
                active_role=active_role,
                departments=bundle.departments,
                session_id=session_row.id,
                preferred_language=bundle.preferred_language,
                preferred_theme=bundle.preferred_theme,
                preferred_density=bundle.preferred_density,
            )
    scope = TenantScope(tenant_id=tenant_id, tenant_schema=tenant_schema)
    return user, scope


def _camera_status_for_stats(*, tenant_id: int, camera_id: int) -> str:
    """Quick reachability call used by the WS heartbeat + stats endpoint."""

    if capture_manager.is_preview_fresh(
        tenant_id, camera_id, max_age_s=FRAME_FRESH_MAX_AGE_S
    ):
        return "online"
    return "offline"


@router.websocket("/{camera_id}/events.ws")
async def events_ws(websocket: WebSocket, camera_id: int) -> None:
    auth = _ws_authorise(websocket)
    if auth is None:
        # 1008 = "Policy Violation". The pre-accept close uses an
        # HTTP-style 403 since handshake hasn't completed yet — most
        # browsers surface this as a connect error.
        await websocket.close(code=1008)
        return
    user, scope = auth

    cam = _resolve_camera_in_tenant(tenant_id=scope.tenant_id, camera_id=camera_id)
    if cam is None:
        await websocket.close(code=1008)
        return

    if not _try_acquire_ws(scope.tenant_id, camera_id):
        # 1013 = Try Again Later
        await websocket.close(code=1013)
        return

    await websocket.accept()

    engine = get_engine()
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id if user.id > 0 else None,
                action="live_capture.events.subscribed",
                entity_type="camera",
                entity_id=str(camera_id),
                after={"camera_name": cam["name"]},
            )

    sub = event_bus.subscribe(tenant_id=scope.tenant_id, camera_id=camera_id)
    last_heartbeat = time.time()
    last_stats = time.time()

    try:
        while True:
            now = time.time()
            timeout = min(
                5.0 - (now - last_heartbeat),
                30.0 - (now - last_stats),
                1.0,
            )
            timeout = max(0.05, timeout)
            try:
                ev = await asyncio.wait_for(sub.queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                ev = None

            if ev is not None:
                await websocket.send_json(
                    {
                        "type": "detection",
                        "time": datetime.fromtimestamp(
                            ev.captured_at, tz=timezone.utc
                        ).isoformat(),
                        "camera_id": ev.camera_id,
                        "employee_id": ev.employee_id,
                        "employee_name": ev.employee_name,
                        "employee_code": ev.employee_code,
                        "confidence": ev.confidence,
                        "status": "identified" if ev.employee_id else "unknown",
                        "bbox": ev.bbox,
                    }
                )
                continue

            now = time.time()
            if now - last_heartbeat >= 5.0:
                last_heartbeat = now
                worker_stats = capture_manager.get_worker_stats(
                    scope.tenant_id, camera_id
                ) or {}
                await websocket.send_json(
                    {
                        "type": "heartbeat",
                        "server_time": datetime.now(tz=timezone.utc).isoformat(),
                        "camera_status": _camera_status_for_stats(
                            tenant_id=scope.tenant_id, camera_id=camera_id
                        ),
                        "status": worker_stats.get("status"),
                        "fps_reader": worker_stats.get("fps_reader"),
                        "fps_analyzer": worker_stats.get("fps_analyzer"),
                        "motion_skipped": worker_stats.get("motion_skipped"),
                    }
                )
            if now - last_stats >= 30.0:
                last_stats = now
                stats = _stats_for_camera(scope=scope, camera_id=camera_id)
                await websocket.send_json(
                    {
                        "type": "stats",
                        "detections_last_10m": stats["detections_last_10m"],
                        "known_count": stats["known_count"],
                        "unknown_count": stats["unknown_count"],
                    }
                )
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "events_ws: unexpected error for camera=%d: %s",
            camera_id,
            type(exc).__name__,
        )
    finally:
        event_bus.unsubscribe(
            tenant_id=scope.tenant_id, camera_id=camera_id, sub=sub
        )
        _release_ws(scope.tenant_id, camera_id)
        try:
            with tenant_context(scope.tenant_schema):
                with engine.begin() as conn:
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id if user.id > 0 else None,
                        action="live_capture.events.unsubscribed",
                        entity_type="camera",
                        entity_id=str(camera_id),
                    )
        except Exception:  # noqa: BLE001
            logger.debug(
                "events_ws unsubscribe audit failed for camera %d", camera_id
            )


# ---------------------------------------------------------------------------
# /live-stats — polled JSON
# ---------------------------------------------------------------------------


def _stats_for_camera(*, scope: TenantScope, camera_id: int) -> dict:
    engine = get_engine()
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=10)
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                func.count().label("total"),
                func.count(detection_events.c.employee_id).label("known"),
            ).where(
                and_(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.camera_id == camera_id,
                    detection_events.c.captured_at >= cutoff,
                )
            )
        ).one()
        total = int(rows.total)
        known = int(rows.known)
        # Latest health snapshot for fps + reachability.
        health = conn.execute(
            select(
                camera_health_snapshots.c.frames_last_minute,
                camera_health_snapshots.c.reachable,
                camera_health_snapshots.c.captured_at,
            )
            .where(
                and_(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == camera_id,
                )
            )
            .order_by(camera_health_snapshots.c.captured_at.desc())
            .limit(1)
        ).first()
    # Prefer the live worker's stats over the per-minute health row —
    # the reader thread updates fps_reader at 1 Hz so the value is
    # always at most 1 second stale; the health snapshot lags by up to
    # a minute. Fall back to the snapshot when the worker isn't
    # running (camera disabled, or P28.5a's manager.get_worker_stats
    # returns None).
    worker_stats = capture_manager.get_worker_stats(scope.tenant_id, camera_id)
    if worker_stats is not None:
        fps_reader = float(worker_stats.get("fps_reader", 0.0) or 0.0)
        fps_analyzer = float(worker_stats.get("fps_analyzer", 0.0) or 0.0)
        motion_skipped = int(worker_stats.get("motion_skipped", 0) or 0)
    else:
        fps_reader = (
            float(health.frames_last_minute) / 60.0
            if health is not None and health.frames_last_minute is not None
            else 0.0
        )
        fps_analyzer = 0.0
        motion_skipped = 0
    return {
        "detections_last_10m": total,
        "known_count": known,
        "unknown_count": total - known,
        "fps": round(fps_reader, 2),
        "fps_reader": round(fps_reader, 2),
        "fps_analyzer": round(fps_analyzer, 2),
        "motion_skipped": motion_skipped,
        "status": _camera_status_for_stats(tenant_id=scope.tenant_id, camera_id=camera_id),
    }


@router.get("/{camera_id}/live-stats")
def live_stats(
    camera_id: int,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> dict:
    cam = _resolve_camera_in_tenant(tenant_id=scope.tenant_id, camera_id=camera_id)
    if cam is None:
        raise HTTPException(status_code=404, detail="camera not found")
    return _stats_for_camera(scope=scope, camera_id=camera_id)


# ---------------------------------------------------------------------------
# /events.csv — last-N-hours export
# ---------------------------------------------------------------------------


@router.get("/{camera_id}/events.csv")
def events_csv(
    camera_id: int,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
    request: Request,
    hours: int = Query(default=1, ge=1, le=24),
) -> StreamingResponse:
    """Stream the camera's recent detection events as CSV.

    Same shape the Camera Logs export from P11 emits — kept thin so
    the export button on the live page lands on familiar bytes.
    """

    cam = _resolve_camera_in_tenant(tenant_id=scope.tenant_id, camera_id=camera_id)
    if cam is None:
        raise HTTPException(status_code=404, detail="camera not found")

    cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.employee_id,
                detection_events.c.confidence,
                detection_events.c.track_id,
                employees.c.full_name,
                employees.c.employee_code,
            )
            .select_from(
                detection_events.outerjoin(
                    employees, detection_events.c.employee_id == employees.c.id
                )
            )
            .where(
                and_(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.camera_id == camera_id,
                    detection_events.c.captured_at >= cutoff,
                )
            )
            .order_by(detection_events.c.captured_at.desc())
        ).all()

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        [
            "id",
            "captured_at",
            "employee_id",
            "employee_code",
            "employee_name",
            "confidence",
            "track_id",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r.id,
                r.captured_at.isoformat() if r.captured_at else "",
                r.employee_id if r.employee_id is not None else "",
                r.employee_code or "",
                r.full_name or "",
                f"{r.confidence:.4f}" if r.confidence is not None else "",
                r.track_id or "",
            ]
        )

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id if user.id > 0 else None,
            action="live_capture.events.exported",
            entity_type="camera",
            entity_id=str(camera_id),
            after={"hours": hours, "row_count": len(rows)},
        )

    filename = (
        f"hadir-events-{camera_id}-{datetime.now(tz=timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    )
    return StreamingResponse(
        iter([buf.getvalue().encode("utf-8")]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
