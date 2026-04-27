"""Per-camera capture worker — split reader / analyzer pipeline (P28.5a).

Architecture (ported from ``prototype-reference/backend/capture.py``):

  ┌─────────────────┐   latest_frame ref     ┌────────────────────┐
  │  Reader thread  │───────(lock)──────────▶│  Analyzer thread   │
  │                 │                        │                    │
  │  read RTSP at   │                        │  pull latest frame │
  │  native fps     │                        │  motion-check      │
  │  encode preview │                        │  detect + match    │
  │  JPEG with the  │                        │  tracker.update()  │
  │  most-recent    │                        │  emit_event(new)   │
  │  cached boxes   │                        │  publish cached    │
  └─────────────────┘                        │  boxes             │
                                             └────────────────────┘

Why two threads?
    Pre-P28.5a we read+detected in a single 4 fps loop. Detection takes
    100-300ms on CPU so the preview ticked at the same rate the
    detector could keep up — laggy. Splitting lets the reader run at
    the camera's native rate (smooth preview) while the analyzer runs
    only as fast as the CPU can manage.

Why motion-skip?
    Most office cameras stare at empty hallways for most of the day.
    A cheap downscaled grayscale frame-diff lets us bail before paying
    for face detection when nothing has changed. Quiet camera → near
    zero CPU.

Per-worker preview JPEG (``self._latest_jpeg``) replaces the P28.5
``frame_buffer.py`` singleton. Tenant scoping is naturally enforced —
the worker only ever serves its own tenant's frame, and
``CaptureManager.get_preview(tenant_id, camera_id)`` validates that
the (tenant, camera) tuple maps to a real worker before returning
bytes.

Test-friendly: ``VideoCaptureFactory`` and ``Analyzer`` are both
injectable, ``ReaderConfig.max_iterations`` bounds the analyzer loop
so unit tests can drive a finite scripted feed without joining
forever.
"""

from __future__ import annotations

import collections
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from hadir.capture import events as events_io
from hadir.capture.analyzer import Analyzer
from hadir.capture.annotate import AnnotationBox, annotate_frame, encode_jpeg
from hadir.capture.directory import employee_directory
from hadir.capture.tracker import Bbox, IoUTracker, TrackMatch
from hadir.db import attendance_records, cameras, detection_events
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# P28.8: cap the recent_errors deque small — only the last few are
# useful in the operations panel, and a bounded deque keeps memory
# stable on a worker that's been failing for hours.
_RECENT_ERRORS_MAX = 5

# How long the per-worker ``_compute_last_attendance_age`` cache stays
# fresh. The query is cheap but the page polls every 5 s and we don't
# want every camera card to round-trip a SELECT 12×/min × N cameras.
_ATTENDANCE_CACHE_TTL_SEC = 30.0


# --- Capture abstractions so tests can swap in a fake feed -----------------


class FrameSource(Protocol):
    """Minimal shape of ``cv2.VideoCapture`` we actually use."""

    def isOpened(self) -> bool: ...
    def read(self): ...  # type: ignore[no-untyped-def]
    def release(self) -> None: ...


VideoCaptureFactory = Callable[[str], FrameSource]


def default_capture_factory(url: str) -> FrameSource:
    """Production: open an OpenCV VideoCapture with sensible timeouts."""

    import cv2  # noqa: PLC0415

    cap = cv2.VideoCapture(url)
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)
    # Low buffer keeps us close to live — any backed-up frames are stale.
    if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap  # type: ignore[return-value]


# --- Worker config ---------------------------------------------------------


@dataclass
class ReaderConfig:
    """Tuning knobs for a single camera worker."""

    # Analyzer cap. The reader runs at the camera's native rate and is
    # not throttled here — its only pacing is whatever the RTSP source
    # delivers. Detection is the expensive call, so the analyzer is
    # what we cap.
    analyzer_max_fps: float = 6.0

    iou_threshold: float = 0.3
    track_idle_timeout_s: float = 3.0

    reconnect_backoff_initial_s: float = 1.0
    reconnect_backoff_max_s: float = 30.0

    health_interval_s: float = 60.0

    # Even when the motion-check says "no motion", re-run detection
    # every N seconds so we don't get stuck on stale boxes if the
    # motion check misfires (e.g. very subtle movement).
    force_detect_every_s: float = 3.0

    # Bound the analyzer loop for tests. The reader thread observes
    # the same shutdown event so it unwinds together.
    max_iterations: Optional[int] = None

    # Test-only: when True, the analyzer advances ``last_analyzed_seq``
    # by 1 per iteration instead of jumping to the reader's current
    # ``frame_seq``. Production stays at False (skip-to-latest) so a
    # slow analyzer can't backlog forever; tests flip it to True for
    # deterministic frame-by-frame processing of a scripted feed.
    analyzer_consume_every_seq: bool = False

    # Preview JPEG quality. 70 is the LAN sweet spot — sharp face IDs
    # at ~80 KB for 1280×720. P28.5 chose 70; we keep it.
    preview_jpeg_quality: int = 70


# --- Cheap motion check ----------------------------------------------------


_MOTION_GRAY_WIDTH = 160
_MOTION_PIXEL_THRESHOLD = 25
_MOTION_MIN_PIXELS = 80


def _check_motion(frame_bgr, prev_gray):  # type: ignore[no-untyped-def]
    """Return ``(moved, current_gray)``.

    Compares a downscaled grayscale of the current frame to the
    previous one. Cheap (~3 ms) compared to the 100-300 ms a real
    detection costs. First call (``prev_gray is None``) always
    returns moved=True so detection runs at least once.
    """

    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    h, w = frame_bgr.shape[:2]
    if w == 0:
        return False, prev_gray
    scale = _MOTION_GRAY_WIDTH / w
    new_h = max(1, int(h * scale))
    small = cv2.resize(frame_bgr, (_MOTION_GRAY_WIDTH, new_h))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    if prev_gray is None or prev_gray.shape != gray.shape:
        return True, gray

    diff = cv2.absdiff(prev_gray, gray)
    changed = int(np.count_nonzero(diff > _MOTION_PIXEL_THRESHOLD))
    return changed >= _MOTION_MIN_PIXELS, gray


# --- Worker ----------------------------------------------------------------


class CaptureWorker:
    """Owns one camera's read+detect+emit pipeline (two threads).

    The decrypted RTSP URL is passed in at construction and held only
    on this instance. ``start()`` spawns both threads; ``stop()`` sets
    the shutdown flag and joins.
    """

    # P28.5b: defaults applied when ``capture_config`` is None or
    # missing keys. Same values the migration's server_default sets;
    # mirrored here so a worker constructed without a row (tests,
    # ad-hoc) gets the prototype-tested behaviour.
    DEFAULT_CAPTURE_CONFIG: dict = {
        "max_faces_per_event": 10,
        "max_event_duration_sec": 60,
        # Deprecated runtime no-op (see ``hadir/capture/events.py`` and
        # docs/phases/fix-detector-mode-preflight.md Layer 2).
        "min_face_quality_to_save": 0.0,
        "save_full_frames": False,
    }

    def __init__(
        self,
        *,
        engine: Engine,
        scope: TenantScope,
        camera_id: int,
        camera_name: str,
        rtsp_url_plain: str,
        analyzer: Analyzer,
        capture_factory: VideoCaptureFactory = default_capture_factory,
        config: Optional[ReaderConfig] = None,
        capture_config: Optional[dict] = None,
        tracker_config: Optional[dict] = None,
        detection_config: Optional[dict] = None,
    ) -> None:
        self._engine = engine
        self._scope = scope
        self.camera_id = camera_id
        self.camera_name = camera_name
        self._rtsp_url_plain = rtsp_url_plain
        self._analyzer = analyzer
        self._capture_factory = capture_factory
        self._config = config or ReaderConfig()

        # P28.5b: per-camera capture knobs. Held under a lock because
        # ``update_config`` mutates this from another thread.
        self._capture_config_lock = threading.Lock()
        self._capture_config: dict = dict(self.DEFAULT_CAPTURE_CONFIG)
        if capture_config:
            self._capture_config.update(capture_config)

        # P28.5c: tenant-level tracker + detection config snapshots.
        # Kept under their own locks so the manager's reconcile tick
        # can swap them without coordinating with the analyzer thread.
        self._tracker_config_lock = threading.Lock()
        self._tracker_config: dict = dict(tracker_config or {})
        self._detection_config_lock = threading.Lock()
        self._detection_config: dict = dict(detection_config or {})

        # Tracker construction: prefer tenant_settings.tracker_config
        # values when supplied, fall back to ReaderConfig defaults
        # otherwise (test compat). Per-camera ``capture_config``
        # overrides the tenant-level ``max_event_duration_sec`` —
        # documented in backend/CLAUDE.md § "Capture configuration
        # precedence".
        tracker_iou = float(
            self._tracker_config.get(
                "iou_threshold", self._config.iou_threshold
            )
        )
        tracker_timeout = float(
            self._tracker_config.get(
                "timeout_sec", self._config.track_idle_timeout_s
            )
        )
        self._tracker = IoUTracker(
            iou_threshold=tracker_iou,
            idle_timeout_s=tracker_timeout,
            max_duration_sec=float(
                self._capture_config["max_event_duration_sec"]
            ),
        )

        # P28.5c: hand the detection config to the analyzer so the
        # first ``detect`` call uses the correct mode + det_size +
        # thresholds. Stub analyzers (the test fixture's
        # ``_NoopAnalyzer``) don't implement ``update_config`` —
        # call it defensively.
        if detection_config:
            try:
                from hadir.detection import DetectorConfig as _DC  # noqa: PLC0415

                if hasattr(self._analyzer, "update_config"):
                    self._analyzer.update_config(_DC.from_dict(detection_config))
            except Exception:  # noqa: BLE001
                logger.debug(
                    "analyzer update_config not supported on this analyzer "
                    "(probably a stub) — skipping"
                )

        # Reader → analyzer hand-off. The reader updates ``_latest_frame``
        # on every read and increments ``_frame_seq``; the analyzer
        # snapshots both under the lock and skips re-analysing the same
        # sequence number.
        self._frame_lock = threading.Lock()
        self._latest_frame = None  # numpy ndarray
        self._frame_seq = 0

        # Cached annotated boxes from the most recent analyzer pass.
        # The reader paints these onto every preview JPEG so a still
        # subject keeps showing their box even when motion-skip
        # bypasses detection.
        self._cached_boxes_lock = threading.Lock()
        self._cached_boxes: list[AnnotationBox] = []

        # Per-worker latest preview JPEG (replaces frame_buffer.py).
        # The reader writes here on every successful read; readers in
        # the live-capture router consume it via
        # ``CaptureManager.get_preview``.
        self._preview_lock = threading.Lock()
        self._latest_jpeg: Optional[bytes] = None
        self._latest_jpeg_ts: float = 0.0

        # Stats consumed by the WebSocket heartbeat + /live-stats.
        self._stats_lock = threading.Lock()
        self._stats: dict[str, float | int | str | None] = {
            "fps_reader": 0.0,
            "fps_analyzer": 0.0,
            "active_tracks": 0,
            "motion_skipped": 0,
            "status": "starting",
            "last_error": None,
        }

        # P28.8 — pipeline stage tracking. Timestamps default to None
        # (= "never"); the get_stats() consumer treats an unset
        # timestamp as max age.
        self._started_at: float = time.time()
        self._last_frame_at: Optional[float] = None
        self._last_analyzer_cycle_at: Optional[float] = None
        self._last_match_at: Optional[float] = None
        # Bounded deque of error strings ("ts: category: message") for
        # the View Errors drawer.
        self._recent_errors: "collections.deque[str]" = collections.deque(
            maxlen=_RECENT_ERRORS_MAX
        )
        # Rolling 60s counters. Each entry is a (timestamp, count=1)
        # so the consumer can sum entries newer than the cutoff. We
        # bound the deques generously — even at unrealistically high
        # rates the trim runs every read.
        self._frames_analyzed_window: "collections.deque[float]" = (
            collections.deque(maxlen=2000)
        )
        self._frames_motion_skipped_window: "collections.deque[float]" = (
            collections.deque(maxlen=2000)
        )
        self._faces_saved_window: "collections.deque[float]" = (
            collections.deque(maxlen=2000)
        )
        self._matches_window: "collections.deque[float]" = (
            collections.deque(maxlen=2000)
        )
        self._error_count_5min: int = 0
        # Cache for the attendance-stage lookup so polling doesn't
        # re-run the join on every get_stats call.
        self._att_cache_ts: float = 0.0
        self._att_cache_age: float = 999_999.0
        # Auto-detected metadata — populated once on first successful
        # RTSP read; written through to the cameras row and held here
        # so get_stats() doesn't have to re-query.
        self._metadata_lock = threading.Lock()
        self._detected_metadata: dict[str, Any] = {
            "resolution_w": None,
            "resolution_h": None,
            "fps": None,
            "codec": None,
            "detected_at": None,
        }
        self._metadata_written = False

        self._stop = threading.Event()
        self._reader_thread: Optional[threading.Thread] = None
        self._analyzer_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Lifecycle

    def start(self) -> None:
        if self._reader_thread is not None and self._reader_thread.is_alive():
            return
        self._stop.clear()
        self._reader_thread = threading.Thread(
            target=self._run_reader,
            name=f"capread-{self.camera_id}",
            daemon=True,
        )
        self._analyzer_thread = threading.Thread(
            target=self._run_analyzer,
            name=f"capana-{self.camera_id}",
            daemon=True,
        )
        self._reader_thread.start()
        self._analyzer_thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        for t in (self._reader_thread, self._analyzer_thread):
            if t is not None and t.is_alive():
                t.join(timeout=timeout)
        self._reader_thread = None
        self._analyzer_thread = None
        # Drop the per-worker preview so a stale frame can't be served
        # after the worker is gone.
        with self._preview_lock:
            self._latest_jpeg = None
            self._latest_jpeg_ts = 0.0

    def is_alive(self) -> bool:
        # The worker is "alive" if at least one of its threads is still
        # running. The manager's hot-reload checks this to know whether
        # to spawn a fresh worker on update.
        for t in (self._reader_thread, self._analyzer_thread):
            if t is not None and t.is_alive():
                return True
        return False

    # ------------------------------------------------------------------
    # Public reads (consumed by manager.get_preview + WS heartbeat)

    def get_latest_jpeg(self) -> Optional[tuple[bytes, float]]:
        """Return ``(jpeg, ts)`` for the most recent preview, or None."""

        with self._preview_lock:
            if self._latest_jpeg is None:
                return None
            return self._latest_jpeg, self._latest_jpeg_ts

    def is_preview_fresh(self, max_age_s: float = 5.0) -> bool:
        with self._preview_lock:
            if self._latest_jpeg is None:
                return False
            return (time.time() - self._latest_jpeg_ts) <= max_age_s

    def get_stats(self) -> dict:
        with self._stats_lock:
            return dict(self._stats)

    # ------------------------------------------------------------------
    # P28.5b: per-camera capture knobs

    def get_capture_config(self) -> dict:
        """Snapshot of the current capture knob bag. Used by the manager's
        reconcile tick to detect drift against the DB row."""

        with self._capture_config_lock:
            return dict(self._capture_config)

    def update_config(self, new_config: dict) -> None:
        """Apply a new capture_config without restarting the worker.

        Knob propagation:

        * ``max_event_duration_sec`` flips the tracker's force-retire
          threshold immediately (next ``_drop_stale`` call uses the new
          value).
        * ``max_faces_per_event``, ``min_face_quality_to_save``,
          ``save_full_frames`` are read by the analyzer thread on the
          next emit cycle (face-save path looks up via
          ``get_capture_config``).

        The manager calls this from the reconcile tick when the DB
        row's ``capture_config`` differs from the worker's. Audit
        happens at the manager level so the change is recorded once
        per actual flip, not per redundant reconcile pass.
        """

        merged = dict(self.DEFAULT_CAPTURE_CONFIG)
        merged.update(new_config or {})
        with self._capture_config_lock:
            self._capture_config = merged
        # The tracker's max_duration_sec must be live-updated since
        # the analyzer thread holds it.
        self._tracker.update_max_duration(
            float(merged["max_event_duration_sec"])
        )
        logger.info(
            "capture worker config updated: tenant=%s camera_id=%s",
            self._scope.tenant_id,
            self.camera_id,
        )

    # ------------------------------------------------------------------
    # P28.5c: tenant-level tracker + detection config hot-reload

    def get_tracker_config(self) -> dict:
        with self._tracker_config_lock:
            return dict(self._tracker_config)

    def get_detection_config(self) -> dict:
        with self._detection_config_lock:
            return dict(self._detection_config)

    def update_tracker_config(self, new_config: dict) -> None:
        """Hot-reload entry point for tenant-level tracker_config
        changes. Calls into ``IoUTracker.update_tracker_config`` which
        applies to NEW tracks only (existing tracks keep their
        original semantics — see tracker docstring)."""

        new = dict(new_config or {})
        with self._tracker_config_lock:
            self._tracker_config = new
        self._tracker.update_tracker_config(new)
        logger.info(
            "capture worker tracker_config updated: tenant=%s camera_id=%s",
            self._scope.tenant_id,
            self.camera_id,
        )

    def update_detection_config(self, new_config: dict) -> None:
        """Hot-reload entry point for tenant-level detection_config
        changes. Forwards to the analyzer's ``update_config`` which
        triggers an InsightFace re-prep when ``det_size`` changes
        and switches the active mode on the next ``detect`` call."""

        new = dict(new_config or {})
        with self._detection_config_lock:
            self._detection_config = new
        try:
            from hadir.detection import DetectorConfig as _DC  # noqa: PLC0415

            if hasattr(self._analyzer, "update_config"):
                self._analyzer.update_config(_DC.from_dict(new))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture worker detection_config update failed: tenant=%s "
                "camera_id=%s reason=%s",
                self._scope.tenant_id,
                self.camera_id,
                type(exc).__name__,
            )
            return
        logger.info(
            "capture worker detection_config updated: tenant=%s camera_id=%s "
            "mode=%s det_size=%s",
            self._scope.tenant_id,
            self.camera_id,
            new.get("mode"),
            new.get("det_size"),
        )

    # ------------------------------------------------------------------
    # Reader thread

    def _run_reader(self) -> None:
        """Outer reconnect loop + inner read loop. Native FPS."""

        # Multi-tenant routing (v1.0 P1): every DB call from this
        # worker must run under the right tenant's search_path.
        from hadir.db import tenant_context  # noqa: PLC0415

        with tenant_context(self._scope.tenant_schema):
            self._reader_loop_outer()

    def _reader_loop_outer(self) -> None:
        backoff = self._config.reconnect_backoff_initial_s
        while not self._stop.is_set():
            cap: Optional[FrameSource] = None
            try:
                cap = self._capture_factory(self._rtsp_url_plain)
                if not cap.isOpened():
                    self._set_status("reconnecting", error="could not open stream")
                    self._record_unreachable("could not open stream")
                    self._sleep_interruptible(backoff)
                    backoff = self._bump_backoff(backoff)
                    continue

                self._set_status("running", error=None)
                backoff = self._config.reconnect_backoff_initial_s

                last_fps_ts = time.time()
                frames_this_sec = 0
                frame_count_minute = 0
                last_health_ts = time.time()
                first_frame_seen = False

                while not self._stop.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        logger.info(
                            "camera %s: read returned empty — reconnecting",
                            self.camera_name,
                        )
                        self._set_status("reconnecting", error="read failed")
                        self._record_error(
                            "rtsp", "read failed — reconnecting"
                        )
                        break

                    # P28.8: on first successful read, probe + persist
                    # auto-detected metadata. Once per worker start —
                    # the row stays stale until the next restart, which
                    # is what we want (operator action triggers a
                    # re-read).
                    if not first_frame_seen:
                        first_frame_seen = True
                        self._detect_camera_metadata(cap)

                    # Hand the frame to the analyzer + count for fps.
                    with self._frame_lock:
                        self._latest_frame = frame
                        self._frame_seq += 1

                    self._last_frame_at = time.time()
                    frames_this_sec += 1
                    frame_count_minute += 1

                    # P26: prom counter — opaque tenant + camera ids only.
                    try:
                        from hadir.metrics import (  # noqa: PLC0415
                            observe_capture_frame,
                        )

                        observe_capture_frame(
                            self._scope.tenant_id, self.camera_id
                        )
                    except Exception:  # noqa: BLE001
                        pass

                    # Encode + store the preview JPEG with whatever boxes
                    # the analyzer last produced. Done on the reader
                    # thread so preview pace tracks read pace, not detect
                    # pace.
                    self._update_preview(frame)

                    now = time.time()
                    if now - last_fps_ts >= 1.0:
                        with self._stats_lock:
                            self._stats["fps_reader"] = round(
                                frames_this_sec / (now - last_fps_ts), 1
                            )
                        frames_this_sec = 0
                        last_fps_ts = now

                    if now - last_health_ts >= self._config.health_interval_s:
                        self._record_health(frame_count_minute, reachable=True)
                        try:
                            events_io.bump_camera_last_seen(
                                self._engine, self._scope, self.camera_id
                            )
                        except Exception:  # noqa: BLE001
                            pass
                        frame_count_minute = 0
                        last_health_ts = now

                # Flush partial-minute bucket on inner break.
                if frame_count_minute > 0:
                    self._record_health(frame_count_minute, reachable=True)

            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "camera %s: reader loop error: %s",
                    self.camera_name,
                    type(exc).__name__,
                )
                self._record_unreachable(f"loop error: {type(exc).__name__}")
            finally:
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:  # noqa: BLE001
                        pass

            if self._stop.is_set():
                break
            self._sleep_interruptible(backoff)
            backoff = self._bump_backoff(backoff)

        self._set_status("stopped", error=None)

    # ------------------------------------------------------------------
    # Analyzer thread

    def _run_analyzer(self) -> None:
        from hadir.db import tenant_context  # noqa: PLC0415

        with tenant_context(self._scope.tenant_schema):
            self._analyzer_loop()

    def _analyzer_loop(self) -> None:
        min_interval = 1.0 / max(0.1, self._config.analyzer_max_fps)
        last_run = 0.0
        last_analyzed_seq = -1
        prev_motion_gray = None
        last_detect_ts = 0.0
        last_fps_ts = time.time()
        runs_this_sec = 0
        iterations = 0

        while not self._stop.is_set():
            with self._frame_lock:
                frame = self._latest_frame
                seq = self._frame_seq
            if frame is None or seq == last_analyzed_seq:
                self._sleep_interruptible(0.02)
                continue

            now = time.time()
            elapsed = now - last_run
            if elapsed < min_interval:
                self._sleep_interruptible(min_interval - elapsed)
                if self._stop.is_set():
                    break
                now = time.time()
            last_run = now
            # Production: skip to whatever frame is freshest. Tests:
            # walk every seq sequentially for deterministic feeds.
            if self._config.analyzer_consume_every_seq:
                last_analyzed_seq = last_analyzed_seq + 1
            else:
                last_analyzed_seq = seq

            # P28.8: cycle marker for the Detection stage.
            self._last_analyzer_cycle_at = now
            self._frames_analyzed_window.append(now)

            moved, prev_motion_gray = _check_motion(frame, prev_motion_gray)
            force = (now - last_detect_ts) >= self._config.force_detect_every_s

            detections: list = []
            if moved or force:
                try:
                    detections = self._analyzer.detect(frame)
                    last_detect_ts = now
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "camera %s: analyzer error: %s",
                        self.camera_name,
                        type(exc).__name__,
                    )
                    self._record_error(
                        "analyzer", f"detect failed: {type(exc).__name__}"
                    )
                    detections = []
            else:
                with self._stats_lock:
                    cur = int(self._stats["motion_skipped"] or 0)
                    self._stats["motion_skipped"] = cur + 1
                self._frames_motion_skipped_window.append(now)

            # Drive the tracker even when detections is empty so idle
            # tracks expire on schedule.
            matches = self._tracker.update(
                [d.bbox for d in detections], now
            )

            # Pre-match each detection against the matcher so (a) the
            # cached boxes get accurate labels and (b) emit() doesn't
            # have to re-run the matcher for new tracks.
            per_detection_match: list[Optional[tuple[int, float]]] = []
            for det in detections:
                mm = (
                    matcher_cache.match(self._scope, det.embedding)
                    if det.embedding is not None
                    else None
                )
                # P28.8: only ACTIVE matches drive the Matching stage.
                # Inactive (former-employee) and future-joiners are
                # surveillance signals, not pipeline-health signals —
                # the operations panel cares whether attendance is
                # actually flowing.
                if mm and mm.classification == "active":
                    self.record_successful_match()
                    per_detection_match.append((mm.employee_id, mm.score))
                else:
                    per_detection_match.append(None)

            # Build the annotation box list and publish it for the
            # reader to draw onto subsequent preview frames. We only
            # overwrite the cached list when we actually ran detection
            # — motion-skip cycles leave the previous boxes in place
            # so a still subject keeps their label.
            if moved or force:
                self._publish_cached_boxes(detections, matches, per_detection_match)

            # One detection_events row per NEW track, never per frame.
            # Snapshot the capture_config + detection_config under the
            # locks so a mid-iteration update_config doesn't change
            # values half-way through the inner loop. detection_config
            # rides into emit so each row carries a per-event
            # ``detection_metadata`` snapshot (model + version).
            current_capture_config = self.get_capture_config()
            current_detection_config = self.get_detection_config()
            from hadir.detection import DetectorConfig as _DC  # noqa: PLC0415
            current_detector_config = (
                _DC.from_dict(current_detection_config)
                if current_detection_config
                else None
            )
            for det, match, pm in zip(
                detections, matches, per_detection_match
            ):
                if not match.is_new:
                    continue
                try:
                    new_id = events_io.emit_detection_event(
                        self._engine,
                        self._scope,
                        camera_id=self.camera_id,
                        frame_bgr=frame,
                        bbox=match.bbox,
                        det_score=det.det_score,
                        track_id=match.track_id,
                        embedding=det.embedding,
                        pre_matched=pm,
                        annotated_frame_bgr=frame,
                        capture_config=current_capture_config,
                        detector_config=current_detector_config,
                    )
                    if new_id is not None:
                        # P28.8: a row + crop was actually written.
                        self.record_face_saved()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "camera %s: event emit failed: %s",
                        self.camera_name,
                        type(exc).__name__,
                    )
                    self._record_error(
                        "emit", f"event write failed: {type(exc).__name__}"
                    )

            runs_this_sec += 1
            now = time.time()
            if now - last_fps_ts >= 1.0:
                with self._stats_lock:
                    self._stats["fps_analyzer"] = round(
                        runs_this_sec / (now - last_fps_ts), 1
                    )
                    self._stats["active_tracks"] = self._tracker.active_tracks
                runs_this_sec = 0
                last_fps_ts = now

            iterations += 1
            if (
                self._config.max_iterations is not None
                and iterations >= self._config.max_iterations
            ):
                # Tests bound the loop here. Signal the reader to
                # unwind too so the worker fully exits.
                self._stop.set()
                return

    # ------------------------------------------------------------------
    # Cached-box hand-off (analyzer → reader's preview encoding)

    def _publish_cached_boxes(
        self, detections, matches, per_detection_match
    ) -> None:
        boxes: list[AnnotationBox] = []
        for det, match, pm in zip(detections, matches, per_detection_match):
            bbox: Bbox = match.bbox
            if pm is not None:
                employee_id, score = pm
                pair = employee_directory.label_for(self._scope, employee_id)
                name = pair[0] if pair else f"EMP {employee_id}"
                label = f"{name} · {int(round(score * 100))}%"
                boxes.append(
                    AnnotationBox(
                        x=bbox.x, y=bbox.y, w=bbox.w, h=bbox.h,
                        label=label, known=True,
                    )
                )
            else:
                boxes.append(
                    AnnotationBox(
                        x=bbox.x, y=bbox.y, w=bbox.w, h=bbox.h,
                        label="Unknown", known=False,
                    )
                )
        with self._cached_boxes_lock:
            self._cached_boxes = boxes

    # ------------------------------------------------------------------
    # Preview JPEG (reader thread)

    def _update_preview(self, frame_bgr) -> None:  # type: ignore[no-untyped-def]
        """Annotate a copy of the frame with cached boxes, encode JPEG,
        store. Failures are swallowed at DEBUG — preview is a viewer
        feature; the underlying capture loop must keep running.
        """

        try:
            with self._cached_boxes_lock:
                boxes = list(self._cached_boxes)

            if boxes:
                # ``annotate_frame`` mutates in place; we don't want
                # to overwrite the frame the analyzer is about to read,
                # so we copy first.
                preview = frame_bgr.copy()
                annotate_frame(preview, boxes)
            else:
                preview = frame_bgr

            jpeg = encode_jpeg(preview, quality=self._config.preview_jpeg_quality)
            if jpeg is None:
                return
            with self._preview_lock:
                self._latest_jpeg = jpeg
                self._latest_jpeg_ts = time.time()
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "camera %s: preview update failed: %s",
                self.camera_name,
                type(exc).__name__,
            )

    # ------------------------------------------------------------------
    # Helpers

    def _set_status(self, status: str, *, error: Optional[str]) -> None:
        with self._stats_lock:
            self._stats["status"] = status
            self._stats["last_error"] = error

    def _sleep_interruptible(self, seconds: float) -> None:
        self._stop.wait(timeout=seconds)

    def _bump_backoff(self, current: float) -> float:
        return min(current * 2.0, self._config.reconnect_backoff_max_s)

    def _record_health(
        self, frames: int, *, reachable: bool, note: Optional[str] = None
    ) -> None:
        try:
            events_io.write_health_snapshot(
                self._engine,
                self._scope,
                camera_id=self.camera_id,
                frames_last_minute=frames,
                reachable=reachable,
                note=note,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "camera %s: health write failed: %s",
                self.camera_name,
                type(exc).__name__,
            )

    def _record_unreachable(self, note: str) -> None:
        self._record_health(0, reachable=False, note=note)

    # ------------------------------------------------------------------
    # P28.8 — pipeline stage instrumentation
    # ------------------------------------------------------------------

    def record_successful_match(self) -> None:
        """Called by the matcher integration when a detection lands an
        active employee_id. Bumps both the "last match" timestamp and
        the rolling 60s counter. Thread-safe."""

        now = time.time()
        self._last_match_at = now
        self._matches_window.append(now)

    def record_face_saved(self) -> None:
        """Called when ``emit_detection_event`` writes a face crop. Used
        for the analyzer-stage detail string."""

        self._faces_saved_window.append(time.time())

    def _record_error(self, category: str, message: str) -> None:
        """Append one entry to the recent_errors deque + bump the
        5-minute error counter. ``category`` is a short tag like "rtsp"
        / "analyzer" / "matcher" so the UI can group."""

        ts = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
        self._recent_errors.append(f"{ts}: {category}: {message}")
        # Approximate — we just bump on every event and trim by checking
        # 5 minutes of context elsewhere. Tests assert
        # ``errors_5min`` > 0 after errors, < threshold otherwise.
        self._error_count_5min += 1

    def get_recent_errors(self) -> list[str]:
        """Snapshot of the recent_errors deque, oldest first."""

        return list(self._recent_errors)

    def get_started_at(self) -> float:
        return self._started_at

    def get_metadata_snapshot(self) -> dict:
        with self._metadata_lock:
            return dict(self._detected_metadata)

    def _detect_camera_metadata(self, cap: FrameSource) -> None:  # type: ignore[no-untyped-def]
        """Read RTSP properties + UPSERT to the cameras row.

        Wrapped in a try/except per property — some cameras don't
        expose CAP_PROP_FPS or report bogus FOURCC. Failure to read
        any property leaves it NULL but doesn't fail the worker.
        """

        if self._metadata_written:
            return

        try:
            import cv2  # noqa: PLC0415
        except Exception:  # noqa: BLE001
            return

        def _safe_int(prop: int) -> Optional[int]:
            try:
                v = cap.get(prop)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return None
            try:
                iv = int(v)
            except (TypeError, ValueError):
                return None
            return iv if iv > 0 else None

        def _safe_float(prop: int) -> Optional[float]:
            try:
                v = cap.get(prop)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return None
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return None
            # Some IP cameras report 0 or huge spurious values when
            # they don't actually know.
            if fv <= 0 or fv > 240:
                return None
            return round(fv, 2)

        def _safe_codec() -> Optional[str]:
            try:
                fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC))  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return None
            if fourcc_int == 0:
                return None
            try:
                tag = "".join(
                    chr((fourcc_int >> (8 * i)) & 0xFF) for i in range(4)
                )
            except Exception:  # noqa: BLE001
                return None
            tag = tag.strip().upper()
            if not tag or not tag.isascii():
                return None
            # Normalise the common "HEVC" alias to H265 for the UI.
            if tag in ("HEVC", "HEV1"):
                return "H265"
            return tag

        width = _safe_int(cv2.CAP_PROP_FRAME_WIDTH)
        height = _safe_int(cv2.CAP_PROP_FRAME_HEIGHT)
        fps = _safe_float(cv2.CAP_PROP_FPS)
        codec = _safe_codec()
        now = datetime.now(tz=timezone.utc)

        with self._metadata_lock:
            self._detected_metadata = {
                "resolution_w": width,
                "resolution_h": height,
                "fps": fps,
                "codec": codec,
                "detected_at": now,
            }
            self._metadata_written = True

        # Persist to the cameras row. One UPDATE; if it fails (DB
        # transient, permission), log + move on — the worker keeps
        # streaming. The next restart will retry.
        try:
            with self._engine.begin() as conn:
                conn.execute(
                    update(cameras)
                    .where(
                        cameras.c.id == self.camera_id,
                        cameras.c.tenant_id == self._scope.tenant_id,
                    )
                    .values(
                        detected_resolution_w=width,
                        detected_resolution_h=height,
                        detected_fps=fps,
                        detected_codec=codec,
                        detected_at=now,
                    )
                )
            logger.info(
                "camera %s: detected metadata %sx%s @ %s fps codec=%s",
                self.camera_name,
                width,
                height,
                fps,
                codec,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "camera %s: metadata UPDATE failed: %s",
                self.camera_name,
                type(exc).__name__,
            )

    def _trim_window(self, window: "collections.deque[float]", *, cutoff: float) -> int:
        """Pop entries older than ``cutoff`` (seconds since epoch). Returns
        the count of remaining entries after trim."""

        while window and window[0] < cutoff:
            window.popleft()
        return len(window)

    def _compute_last_attendance_age(self) -> float:
        """Return seconds since the most recent attendance row tied to
        this camera. Cached for ~30 s so 5-second polling doesn't
        thrash the DB.
        """

        now = time.time()
        if (now - self._att_cache_ts) < _ATTENDANCE_CACHE_TTL_SEC:
            return self._att_cache_age

        try:
            from sqlalchemy import func as sa_func  # noqa: PLC0415

            with self._engine.begin() as conn:
                row = conn.execute(
                    select(sa_func.max(attendance_records.c.computed_at))
                    .select_from(
                        attendance_records.join(
                            detection_events,
                            (
                                detection_events.c.employee_id
                                == attendance_records.c.employee_id
                            )
                            & (
                                detection_events.c.tenant_id
                                == attendance_records.c.tenant_id
                            ),
                        )
                    )
                    .where(
                        attendance_records.c.tenant_id
                        == self._scope.tenant_id,
                        detection_events.c.camera_id == self.camera_id,
                        attendance_records.c.computed_at
                        > sa_func.now() - sa_func.cast(
                            "4 hours", sa_func.text("interval").type
                        ),
                    )
                ).first()
        except Exception:  # noqa: BLE001
            self._att_cache_ts = now
            self._att_cache_age = 999_999.0
            return self._att_cache_age

        latest = row[0] if row is not None else None
        if latest is None:
            self._att_cache_age = 999_999.0
        else:
            try:
                # latest is timezone-aware DateTime; subtract from
                # current UTC.
                latest_ts = latest.timestamp()
                self._att_cache_age = max(0.0, now - latest_ts)
            except Exception:  # noqa: BLE001
                self._att_cache_age = 999_999.0
        self._att_cache_ts = now
        return self._att_cache_age

    def _compute_stage_states(self) -> dict[str, dict[str, Any]]:
        """Compute the four pipeline stages: rtsp / detection / matching
        / attendance. See the docstring on ``get_full_stats`` for the
        thresholds and the conditional-red logic.
        """

        now = time.time()
        uptime = now - self._started_at

        cutoff_60s = now - 60
        frames_60s = self._trim_window(
            self._frames_analyzed_window, cutoff=cutoff_60s
        )
        matches_60s = self._trim_window(self._matches_window, cutoff=cutoff_60s)

        # Don't trust judgments in the first 60 s — too little data.
        if uptime < 60:
            return {
                "rtsp": {
                    "state": "unknown",
                    "last_activity_at": None,
                    "detail": "Worker just started — gathering data",
                },
                "detection": {
                    "state": "unknown",
                    "last_activity_at": None,
                    "detail": "Waiting for first analyzer cycle",
                },
                "matching": {
                    "state": "unknown",
                    "last_activity_at": None,
                    "detail": "Waiting for first detection",
                },
                "attendance": {
                    "state": "unknown",
                    "last_activity_at": None,
                    "detail": "Pending pipeline warmup",
                },
            }

        # RTSP
        rtsp_age = (now - self._last_frame_at) if self._last_frame_at else 999_999
        if rtsp_age < 5:
            rtsp_state = "green"
            with self._stats_lock:
                fps_r = self._stats.get("fps_reader", 0.0)
            rtsp_detail = f"Frames flowing at {fps_r} fps"
        elif rtsp_age < 30:
            rtsp_state = "amber"
            rtsp_detail = f"Last frame {int(rtsp_age)} seconds ago"
        else:
            rtsp_state = "red"
            rtsp_detail = (
                f"RTSP disconnected — last frame {int(rtsp_age)}s ago"
            )

        # Detection
        det_age = (
            (now - self._last_analyzer_cycle_at)
            if self._last_analyzer_cycle_at
            else 999_999
        )
        if det_age < 30:
            det_state = "green"
            with self._stats_lock:
                fps_a = self._stats.get("fps_analyzer", 0.0)
                ms = int(self._stats.get("motion_skipped", 0) or 0)
            skip_pct = (
                int(round(100 * ms / max(1, ms + frames_60s)))
                if (ms + frames_60s) > 0
                else 0
            )
            det_detail = f"{fps_a} fps, {skip_pct}% motion-skipped"
        elif det_age < 120:
            det_state = "amber"
            det_detail = f"Slow: last cycle {int(det_age)}s ago"
        else:
            det_state = "red"
            det_detail = "Analyzer thread idle / dead"

        # Matching — conditional red
        match_age = (
            (now - self._last_match_at) if self._last_match_at else 999_999
        )
        if det_state == "red":
            match_state = "unknown"
            match_detail = "Cannot judge — detection is red"
        elif match_age < 600:
            match_state = "green"
            match_detail = (
                f"Last match {int(match_age)}s ago"
                if match_age >= 1
                else "Matches happening live"
            )
        elif match_age < 3600:
            match_state = "amber"
            match_detail = (
                f"Last match {int(match_age // 60)}min ago — quiet hallway?"
            )
        elif frames_60s > 0:
            match_state = "red"
            match_detail = (
                "Detector firing but matcher silent — check enrolled photos"
            )
        else:
            match_state = "amber"
            match_detail = "Detection idle — cannot evaluate matcher"

        # Attendance — also conditional
        att_age = self._compute_last_attendance_age()
        if match_state in ("red", "unknown"):
            att_state = "unknown"
            att_detail = "Cannot judge — matching is " + match_state
        elif att_age < 3600:
            att_state = "green"
            att_detail = (
                f"Last record {int(att_age // 60)}min ago"
                if att_age >= 60
                else f"Last record {int(att_age)}s ago"
            )
        elif att_age < 14400:  # 4 hours
            att_state = "amber"
            att_detail = f"Last record {int(att_age // 3600)}h ago — lunch?"
        elif matches_60s > 0:
            att_state = "red"
            att_detail = (
                "Matches happening but no attendance — engine stuck?"
            )
        else:
            att_state = "amber"
            att_detail = "Quiet day — no recent matches to attribute"

        def _iso(ts: Optional[float]) -> Optional[str]:
            if ts is None:
                return None
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(
                timespec="seconds"
            )

        return {
            "rtsp": {
                "state": rtsp_state,
                "last_activity_at": _iso(self._last_frame_at),
                "detail": rtsp_detail,
            },
            "detection": {
                "state": det_state,
                "last_activity_at": _iso(self._last_analyzer_cycle_at),
                "detail": det_detail,
            },
            "matching": {
                "state": match_state,
                "last_activity_at": _iso(self._last_match_at),
                "detail": match_detail,
            },
            "attendance": {
                "state": att_state,
                "last_activity_at": None,  # we don't track per-row here
                "detail": att_detail,
            },
        }

    def get_full_stats(self) -> dict[str, Any]:
        """P28.8 — full stats payload for the operations page.

        Differs from ``get_stats()`` (which keeps the legacy shape for
        the existing live-capture WS heartbeat) by adding pipeline
        stages, rolling counters, and the camera metadata snapshot.

        Stage states:

        * **rtsp**  — green if a frame arrived in the last 5 s, amber
          5-30 s, red over 30 s.
        * **detection** — green if the analyzer ticked in the last 30 s,
          amber 30-120 s, red over 120 s.
        * **matching** — conditional. ``unknown`` if detection is red.
          Otherwise green if a match landed in the last 10 min, amber
          10-60 min. Red **only** when detection is firing
          (frames_analyzed_60s > 0) but no match has happened in over
          an hour — that's a real failure mode (matcher cache stale,
          enrolled photos broken).
        * **attendance** — conditional. ``unknown`` if matching is red
          or unknown. Otherwise green if an attendance row was written
          in the last hour, amber 1-4 h. Red only when matches are
          happening (matches_60s > 0) but no attendance has been
          written for >4 h.
        """

        now = time.time()
        cutoff_60s = now - 60
        frames_60s = self._trim_window(
            self._frames_analyzed_window, cutoff=cutoff_60s
        )
        motion_60s = self._trim_window(
            self._frames_motion_skipped_window, cutoff=cutoff_60s
        )
        faces_60s = self._trim_window(
            self._faces_saved_window, cutoff=cutoff_60s
        )
        matches_60s = self._trim_window(self._matches_window, cutoff=cutoff_60s)

        with self._stats_lock:
            base = dict(self._stats)
        with self._metadata_lock:
            metadata = dict(self._detected_metadata)
        # Add the manual fields by querying the row. One small
        # SELECT — kept here so the operations page doesn't have to
        # join client-side. Failures fall back to None.
        try:
            with self._engine.begin() as conn:
                row = conn.execute(
                    select(
                        cameras.c.brand,
                        cameras.c.model,
                        cameras.c.mount_location,
                    ).where(
                        cameras.c.id == self.camera_id,
                        cameras.c.tenant_id == self._scope.tenant_id,
                    )
                ).first()
            if row is not None:
                metadata["brand"] = row.brand
                metadata["model"] = row.model
                metadata["mount_location"] = row.mount_location
        except Exception:  # noqa: BLE001
            metadata.setdefault("brand", None)
            metadata.setdefault("model", None)
            metadata.setdefault("mount_location", None)

        stages = self._compute_stage_states()
        # Surface a couple of stage-derived counters for tests.
        self._matches_60s_recent = matches_60s

        return {
            "tenant_id": self._scope.tenant_id,
            "camera_id": self.camera_id,
            "camera_name": self.camera_name,
            "status": base.get("status", "starting"),
            "started_at": datetime.fromtimestamp(
                self._started_at, tz=timezone.utc
            ).isoformat(timespec="seconds"),
            "uptime_sec": int(now - self._started_at),
            "stages": stages,
            "fps_reader": float(base.get("fps_reader", 0.0) or 0.0),
            "fps_analyzer": float(base.get("fps_analyzer", 0.0) or 0.0),
            "frames_analyzed_60s": frames_60s,
            "frames_motion_skipped_60s": motion_60s,
            "faces_saved_60s": faces_60s,
            "matches_60s": matches_60s,
            "errors_5min": self._error_count_5min,
            "recent_errors": list(self._recent_errors),
            "metadata": metadata,
        }
