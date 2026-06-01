"""In-memory anomaly ring — TEMP-DIAGNOSTIC-2026-05-20.

Public helpers (``record_*``) are the only thing call sites use. Each
helper:
  1. Bails immediately if the global ``_enabled`` flag is False.
  2. Builds a ``FrameDiagnosticEvent`` value object.
  3. Appends it to the ring buffer under a single lock.

Thresholds + rate-limiters live alongside the helpers so the call
site stays one-liner. Spammy event kinds (``ffmpeg_restart``) have a
per-(camera, kind) cooldown to keep the ring useful even when the
underlying loop is restarting every 3 seconds.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from threading import Lock
from typing import Any

# Cap memory: ~2000 events × ~300 bytes ≈ 600 KB. Enough headroom for
# a 2-hour session with realistic anomaly rates.
_RING_MAX = 2000

# Per-(camera_id, kind) cooldown — skip emitting the same kind more
# often than this. Lets a fast restart-loop produce one event every
# 5 s instead of 82, so the ring stays informative.
_KIND_COOLDOWNS_S: dict[str, float] = {
    "ffmpeg_restart": 5.0,
    "rtsp_reconnect": 5.0,
    "frame_slow": 2.0,
    "detection_slow": 2.0,
    "segmenter_thrashing": 30.0,
    "reader_read_failed": 5.0,
    "camera_read_timeout": 5.0,
}


@dataclass(frozen=True, slots=True)
class FrameDiagnosticEvent:
    """One anomaly observation.

    ``kind`` is one of:
      * ``frame_slow`` — reader hot-path exceeded the budget
      * ``reader_read_failed`` — ``cap.read()`` returned empty
      * ``rtsp_reconnect`` — outer reconnect loop kicked in
      * ``ffmpeg_restart`` — segmenter watchdog restarted ffmpeg
      * ``segmenter_thrashing`` — > N restarts in a short window
      * ``detection_slow`` — analyzer ``detect()`` call exceeded budget
      * ``analyzer_starved`` — analyzer saw no new frame seq since
        last tick (reader stalled)
      * ``camera_read_timeout`` — RTSP connect pre-flight failed; the
        camera is offline and the worker is in its reconnect loop

    ``metrics`` is free-form per-kind. Document the keys in the call
    site so the UI knows what to render.
    """

    ts: float  # unix seconds (server time)
    tenant_id: int | None
    camera_id: int | None
    camera_name: str | None
    kind: str
    reason: str
    metrics: dict[str, Any] = field(default_factory=dict)


# --- Module state ----------------------------------------------------------
# All mutation goes through ``_lock``. Reads outside the lock (just
# the bool flag) are intentional — Python reads of single references
# are atomic and we want ``is_enabled()`` to be free of contention so
# the disabled-path stays trivially cheap.

_enabled: bool = False
_session_started_at: float = time.time()
_ring: deque[FrameDiagnosticEvent] = deque(maxlen=_RING_MAX)
_last_emit_at: dict[tuple[int | None, str], float] = defaultdict(float)
_lock = Lock()


# --- Public API ------------------------------------------------------------


def is_enabled() -> bool:
    """O(1) check — call this at the top of every ``record_*`` helper.

    Returning False here makes the hot-path bail before any
    allocation, dict lookup, or lock acquisition. The dominant cost
    when diagnostics is OFF is the four ``time.monotonic()`` calls at
    the call site, not anything in this module.
    """

    return _enabled


def set_enabled(value: bool) -> None:
    global _enabled, _session_started_at
    with _lock:
        was_enabled = _enabled
        _enabled = bool(value)
        # Starting a fresh session — reset the ``session_started_at``
        # so the UI can show duration accurately. Don't clear the
        # ring; the operator might want to compare a previous run.
        if value and not was_enabled:
            _session_started_at = time.time()


def session_started_at() -> float:
    return _session_started_at


def clear() -> None:
    with _lock:
        _ring.clear()
        _last_emit_at.clear()


def snapshot(
    *,
    since_ts: float | None = None,
    camera_id: int | None = None,
    kind: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Return matching events as plain dicts (FastAPI-serialisable).

    Filters are AND-composed. ``limit`` slices the most-recent N
    after filtering — handy for the UI's "last 200" view.
    """

    with _lock:
        items = list(_ring)
    out: list[dict[str, Any]] = []
    for ev in items:
        if since_ts is not None and ev.ts < since_ts:
            continue
        if camera_id is not None and ev.camera_id != camera_id:
            continue
        if kind is not None and ev.kind != kind:
            continue
        out.append(asdict(ev))
    if limit is not None and limit > 0:
        out = out[-limit:]
    return out


# --- Internal: cooldown-gated append ---------------------------------------


def _maybe_append(event: FrameDiagnosticEvent) -> None:
    """Apply the per-(camera, kind) cooldown then append.

    Called only after ``is_enabled()`` returned True. Drops the event
    silently if the same kind was emitted for the same camera within
    the cooldown window — the goal is to preserve the *fact that
    anomaly X is happening repeatedly*, not log every single instance
    of it. The ``segmenter_thrashing`` event kind is the
    higher-signal "this is a runaway" marker.
    """

    cooldown = _KIND_COOLDOWNS_S.get(event.kind, 0.0)
    key = (event.camera_id, event.kind)
    with _lock:
        last = _last_emit_at[key]
        if cooldown > 0.0 and (event.ts - last) < cooldown:
            return
        _last_emit_at[key] = event.ts
        _ring.append(event)


# --- Public: per-kind ``record_*`` helpers ---------------------------------
# Call sites use these instead of constructing events directly. Each
# helper is a one-liner the instrumentation point can paste in.


def record_frame_slow(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    t_read_ms: float,
    t_preview_ms: float,
    t_clip_ms: float,
    t_total_ms: float,
    fps_reader: float,
    native_fps: float | None,
) -> None:
    """Reader hot-path budget exceeded.

    Breaks the total down into the three suspect calls so we can see
    *which* part of the loop is slow. ``native_fps`` may be None if
    the camera hasn't been auto-probed yet (P28.8).
    """

    if not _enabled:
        return
    budget_ms = (1000.0 / native_fps) if native_fps and native_fps > 0 else 40.0
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="frame_slow",
        reason=f"frame budget exceeded ({t_total_ms:.0f} > {budget_ms:.0f} ms)",
        metrics={
            "t_read_ms": round(t_read_ms, 2),
            "t_preview_ms": round(t_preview_ms, 2),
            "t_clip_ms": round(t_clip_ms, 2),
            "t_total_ms": round(t_total_ms, 2),
            "budget_ms": round(budget_ms, 2),
            "fps_reader": fps_reader,
            "native_fps": native_fps,
        },
    ))


def record_reader_read_failed(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
) -> None:
    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="reader_read_failed",
        reason="cap.read() returned empty — reconnecting",
        metrics={},
    ))


def record_rtsp_reconnect(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    reason: str,
    backoff_s: float,
) -> None:
    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="rtsp_reconnect",
        reason=reason,
        metrics={"backoff_s": round(backoff_s, 2)},
    ))


def record_camera_read_timeout(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    timeout_ms: float,
    reason: str,
    reconnect_attempts: int,
) -> None:
    """RTSP connect pre-flight failed — the camera is unreachable.

    Carries the operator-facing diagnostics the dead-camera fix
    requires: camera name (on the event), how long the probe took
    (``timeout_ms``), why it failed (``reason``), and how many
    consecutive reconnect attempts have piled up.
    """

    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="camera_read_timeout",
        reason=reason,
        metrics={
            "timeout_ms": round(timeout_ms, 1),
            "reconnect_attempts": reconnect_attempts,
        },
    ))


def record_ffmpeg_restart(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    exit_code: int | None,
    short_reason: str,
) -> None:
    """Segmenter watchdog re-spawned ffmpeg.

    ``short_reason`` is the first line of stderr trimmed — usually
    "No route to host" or "Connection timed out" or "EOF".
    """

    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="ffmpeg_restart",
        reason=short_reason,
        metrics={"exit_code": exit_code},
    ))


def record_segmenter_thrashing(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    restarts_30s: int,
) -> None:
    """Aggregate signal — many restarts in a short window.

    Emitted by the segmenter watchdog itself; cooldown is long
    (30 s) so the ring shows "thrashing started here" not "thrashing
    is ongoing on every poll."
    """

    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="segmenter_thrashing",
        reason=f"{restarts_30s} ffmpeg restarts in last 30s",
        metrics={"restarts_30s": restarts_30s},
    ))


def record_detection_slow(
    *,
    tenant_id: int | None,
    camera_id: int | None,
    camera_name: str | None,
    detect_ms: float,
    detector_mode: str,
    det_size: int,
) -> None:
    if not _enabled:
        return
    _maybe_append(FrameDiagnosticEvent(
        ts=time.time(),
        tenant_id=tenant_id,
        camera_id=camera_id,
        camera_name=camera_name,
        kind="detection_slow",
        reason=f"{detector_mode} detect took {detect_ms:.0f} ms (det_size={det_size})",
        metrics={
            "detect_ms": round(detect_ms, 2),
            "detector_mode": detector_mode,
            "det_size": det_size,
        },
    ))
