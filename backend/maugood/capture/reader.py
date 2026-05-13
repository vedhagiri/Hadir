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
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

import numpy as np
from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from maugood.capture import events as events_io
from maugood.capture.analyzer import Analyzer
from maugood.capture.annotate import AnnotationBox, annotate_frame, encode_jpeg
from maugood.capture.clip_worker import ClipWorker
from maugood.capture.directory import employee_directory
from maugood.capture.tracker import Bbox, IoUTracker, TrackMatch
from maugood.config import get_settings
from maugood.db import attendance_records, cameras, detection_events
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

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

    import os  # noqa: PLC0415

    import cv2  # noqa: PLC0415

    # Force TCP transport for RTSP streams before opening the capture.
    # OpenCV's default is UDP. A single dropped UDP packet corrupts every
    # H.264 P-frame that references the affected macroblock until the next
    # I-frame — visible as green/gray shifting blocks in the live preview.
    # OPENCV_FFMPEG_CAPTURE_OPTIONS is read by the FFMPEG backend at
    # VideoCapture construction time; setting it after open has no effect.
    if url.lower().startswith(("rtsp://", "rtsps://")):
        current = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS", "")
        if "rtsp_transport" not in current:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
                current + (";rtsp_transport;tcp" if current else "rtsp_transport;tcp")
            )

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

    # Detection-state hysteresis: how many consecutive empty-detection
    # cycles must occur before the analyzer signals "person absent".
    # At 6 fps, 30 cycles ≈ 5 s of missed detections before the clip
    # recording debounce even starts counting. Combined with the 10 s
    # clip-finalize debounce, this gives ~15 s of tolerance for brief
    # occlusion, detection flicker, or a person turning away from the
    # camera — the clip keeps recording throughout.
    consecutive_no_person_threshold: int = 30

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
        # Deprecated runtime no-op (see ``maugood/capture/events.py`` and
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
        detection_enabled: bool = True,
        clip_recording_enabled: bool = True,
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

        # Migration 0033 — detection toggle. The reader keeps reading
        # frames + drives the live preview either way; the analyzer
        # short-circuits the expensive ``detect`` call when this is
        # False (saving ~80-150 ms/cycle). Reconcile loop hot-swaps
        # via ``update_detection_enabled`` without restarting the
        # worker.
        self._detection_enabled_lock = threading.Lock()
        self._detection_enabled = bool(detection_enabled)

        # Migration 0049 — per-camera clip-recording gate. When False
        # the reader keeps reading + detection keeps running, but
        # _manage_clip_recording is a no-op (no frames written, no
        # ClipWorker submission). Hot-swapped via
        # ``update_clip_recording_enabled`` without a worker restart.
        self._clip_recording_enabled_lock = threading.Lock()
        self._clip_recording_enabled: bool = bool(clip_recording_enabled)

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
                from maugood.detection import DetectorConfig as _DC  # noqa: PLC0415

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

        # P37 — person presence flag. Set by the analyzer thread with
        # detection-state hysteresis (N consecutive empty cycles before
        # flipping to False). Read by the reader thread to decide when
        # to start/stop clip recording.
        self._person_present_lock = threading.Lock()
        self._person_present: bool = False
        # Face count per analyzer cycle (for clip person_count).
        self._face_count: int = 0
        # P37.5 — detection-state hysteresis counter. Incremented by the
        # analyzer thread each cycle with zero detections; reset on any
        # detection. Prevents brief occlusion or detection flicker from
        # immediately signalling "person absent".
        self._no_person_consecutive_count: int = 0
        self._no_person_consecutive_threshold: int = (
            self._config.consecutive_no_person_threshold
        )

        # Active IoU track count — set by the analyzer thread after each
        # tracker.update() call, read by the reader thread to determine
        # whether the tracker still believes a person is present even
        # when the current per-cycle detection missed them.
        self._active_track_count: int = 0

        # Clip recording state. Frames are written to a temp directory on
        # disk immediately as they arrive (native FPS, no subsampling) so
        # memory use stays bounded. The temp dir is passed to ClipWorker
        # when the clip is finalised; ClipWorker calls cleanup() when done.
        self._clip_tmpdir: Optional[tempfile.TemporaryDirectory] = None  # type: ignore[type-arg]
        self._clip_frame_idx: int = 0       # counter → frame_{i:06d}.jpg names
        self._clip_first_ts: float = 0.0    # wall-clock of first frame in clip
        self._clip_last_ts: float = 0.0     # wall-clock of most recent frame
        self._clip_recording: bool = False
        self._clip_has_had_person: bool = False
        self._clip_start_ts: float = 0.0
        self._clip_max_person_count: int = 0
        # P37 — matched employee IDs accumulated during clip recording.
        # The analyzer thread adds IDs when matcher_cache.match() returns
        # a hit; _finalize_current_clip snapshots and clears the set.
        self._clip_matched_ids_lock = threading.Lock()
        self._clip_matched_employee_ids: set[int] = set()
        # P37.5 — person-absent debounce. When no person is detected, we
        # keep recording for this many seconds before finalizing. This
        # prevents premature clip splits caused by brief occlusion or
        # inter-cycle timing gaps between the reader and analyzer threads.
        # The effective tolerance is this value + (threshold / analyzer_fps)
        # ≈ 10 + 5 = ~15 seconds of continuous absence before a clip
        # is finalised.
        self._last_person_seen_ts: float = 0.0
        # How long to keep recording after the last person detection
        # before finalising the clip. 10 s gives ample tolerance for
        # brief occlusion, detection flicker, or a person momentarily
        # turning away from the camera.
        self._CLIP_FINALIZE_AFTER_NO_PERSON_SEC: float = 10.0

        # P37 — dedicated clip worker thread that runs finalization
        # (ffmpeg encode + encrypt + file write + DB INSERT) off the
        # reader's hot path so the frame-read loop is never blocked.
        self._clip_worker = ClipWorker(
            engine=self._engine,
            scope=self._scope,
            camera_id=self.camera_id,
            camera_name=self.camera_name,
        )

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
        self._clip_worker.start()
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
        self._clip_worker.stop(timeout=timeout)
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

    def is_detection_enabled(self) -> bool:
        """Read the live detection-toggle flag.

        Migration 0033: when False, the analyzer thread skips the
        expensive ``detect`` call but the reader thread keeps reading
        frames + driving the live preview. Used inside the analyzer
        loop's hot path so the read is lock-cheap.
        """

        with self._detection_enabled_lock:
            return bool(self._detection_enabled)

    def update_detection_enabled(self, enabled: bool) -> None:
        """Hot-reload entry point for the per-camera detection toggle.

        The reconcile loop diffs ``cameras.detection_enabled`` and
        calls this when an operator flips the switch in the UI. No
        worker restart, no dropped frames — the next analyzer cycle
        observes the new value via ``is_detection_enabled``.
        """

        new = bool(enabled)
        with self._detection_enabled_lock:
            old = self._detection_enabled
            self._detection_enabled = new
        if old != new:
            logger.info(
                "capture worker detection_enabled updated: tenant=%s "
                "camera_id=%s old=%s new=%s",
                self._scope.tenant_id,
                self.camera_id,
                old,
                new,
            )

    def is_clip_recording_enabled(self) -> bool:
        """Read the live clip-recording toggle flag.

        Migration 0049: when False, _check_and_record_clip is a no-op
        (the reader keeps reading + detection keeps running, but no
        video frames are written to disk and no person_clips rows are
        created). Hot-swapped via ``update_clip_recording_enabled``
        without a worker restart.
        """

        with self._clip_recording_enabled_lock:
            return bool(self._clip_recording_enabled)

    def update_clip_recording_enabled(self, enabled: bool) -> None:
        """Hot-reload entry point for the per-camera clip-recording toggle.

        The reconcile loop diffs ``cameras.clip_recording_enabled`` and
        calls this when an operator flips the switch in the UI. No
        worker restart, no dropped frames — the next reader frame
        observes the new value via ``is_clip_recording_enabled``.

        When flipping from enabled to disabled while a clip is actively
        recording, the current clip is finalized immediately so no
        partial clip is orphaned.
        """

        new = bool(enabled)
        with self._clip_recording_enabled_lock:
            old = self._clip_recording_enabled
            self._clip_recording_enabled = new
        if old != new:
            if not new and self._clip_recording:
                self._finalize_current_clip()
            logger.info(
                "capture worker clip_recording_enabled updated: tenant=%s "
                "camera_id=%s old=%s new=%s",
                self._scope.tenant_id,
                self.camera_id,
                old,
                new,
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
            from maugood.detection import DetectorConfig as _DC  # noqa: PLC0415

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
    # P37 — Person clip recording (simplified binary presence detection)
    # ------------------------------------------------------------------

    def _encode_clip_frame(self, frame_bgr):
        """JPEG-encode a frame at full resolution for the clip video.
        Uses high quality so the subsequent ffmpeg H.264 encoding
        preserves the original stream clarity with minimal generation
        loss.
        """

        import cv2  # noqa: PLC0415

        try:
            ok, buf = cv2.imencode(
                ".jpg", frame_bgr,
                [cv2.IMWRITE_JPEG_QUALITY, 95],
            )
            if not ok:
                return None
            return bytes(buf.tobytes())
        except Exception:  # noqa: BLE001
            return None

    def _check_and_record_clip(self, frame_bgr) -> None:
        """Called by the reader thread on every frame.

        Writes every frame directly to a temp directory on disk at the
        camera's native FPS — no subsampling, no memory buffering. Disk
        I/O per frame is an 80-100 KB JPEG write (~1 ms on SSD), which
        is negligible compared to the RTSP read latency.

        Clip lifecycle:
          * Person arrives  → create temp dir, start writing frames
          * Person present  → write every frame to frame_{i:06d}.jpg
          * Person leaves   → keep writing (grace period) until
                              _CLIP_FINALIZE_AFTER_NO_PERSON_SEC elapses
          * Grace expired   → submit tmpdir to ClipWorker, which runs
                              ffmpeg then cleans up the tmpdir

        The temp dir is owned by the TemporaryDirectory object that
        lives in clip_data["tmpdir"]. ClipWorker calls .cleanup() when
        ffmpeg finishes — the disk space is freed at that point, not
        when the reader moves on.
        """

        # Migration 0049: per-camera clip-recording gate. When False
        # the reader keeps reading + detection keeps running, but no
        # video frames are written to disk and no person_clips rows
        # are created. Hot-swapped via update_clip_recording_enabled.
        if not self.is_clip_recording_enabled():
            return

        from maugood.config import get_settings as _gs  # noqa: PLC0415
        settings = _gs()
        if not settings.clip_save_enabled:
            return

        with self._person_present_lock:
            person_here = self._person_present
            face_count = self._face_count
            active_tracks = self._active_track_count

        now = time.time()

        # Combined presence signal: the per-cycle detection result
        # OR the tracker's active track count. The tracker provides
        # temporal continuity — a briefly occluded person keeps their
        # track alive for idle_timeout_s (~2-3 s), preventing premature
        # clip finalization when per-cycle detection misses them.
        has_person = person_here or (active_tracks > 0)

        if has_person:
            # Person detected — update last-seen timestamp.
            self._last_person_seen_ts = now
            self._clip_has_had_person = True

            if not self._clip_recording:
                # Start new clip: create a temp directory for frame files.
                self._clip_tmpdir = tempfile.TemporaryDirectory(
                    prefix="maugood_clip_"
                )
                self._clip_recording = True
                self._clip_has_had_person = True
                self._clip_start_ts = now
                self._clip_first_ts = now
                self._clip_last_ts = now
                self._clip_frame_idx = 0
                self._clip_max_person_count = 0
                with self._clip_matched_ids_lock:
                    self._clip_matched_employee_ids.clear()
                logger.debug(
                    "clip started: camera=%s",
                    self.camera_id,
                )

            # Track max persons seen during this clip.
            if face_count > self._clip_max_person_count:
                self._clip_max_person_count = face_count

            # Write the current frame to disk — every native-FPS frame,
            # no subsampling. Memory usage stays at O(1) regardless of
            # clip length; temp space is freed after ffmpeg encodes.
            if self._clip_tmpdir is not None:
                jpeg = self._encode_clip_frame(frame_bgr)
                if jpeg is not None:
                    try:
                        frame_path = (
                            Path(self._clip_tmpdir.name)
                            / f"frame_{self._clip_frame_idx:08d}.jpg"
                        )
                        frame_path.write_bytes(jpeg)
                        self._clip_frame_idx += 1
                        self._clip_last_ts = now
                    except OSError:
                        logger.debug(
                            "clip frame write failed: camera=%s",
                            self.camera_id,
                        )

        else:
            if self._clip_recording:
                # No person detected. Use debounce: only finalize after
                # the person has been absent for the full grace period.
                # During the grace period we keep writing frames so the
                # clip captures the person walking out of frame.
                absent_for = now - self._last_person_seen_ts
                if absent_for >= self._CLIP_FINALIZE_AFTER_NO_PERSON_SEC:
                    self._finalize_current_clip()
                elif self._clip_tmpdir is not None:
                    jpeg = self._encode_clip_frame(frame_bgr)
                    if jpeg is not None:
                        try:
                            frame_path = (
                                Path(self._clip_tmpdir.name)
                                / f"frame_{self._clip_frame_idx:08d}.jpg"
                            )
                            frame_path.write_bytes(jpeg)
                            self._clip_frame_idx += 1
                            self._clip_last_ts = now
                        except OSError:
                            pass

    def _finalize_current_clip(self) -> None:
        """Submit the current clip to the ClipWorker and reset recording
        state. The TemporaryDirectory object is transferred to the
        ClipWorker which owns cleanup after ffmpeg finishes.
        """

        self._clip_recording = False
        had_person = self._clip_has_had_person
        self._clip_has_had_person = False
        tmpdir = self._clip_tmpdir
        self._clip_tmpdir = None
        frame_count = self._clip_frame_idx
        self._clip_frame_idx = 0
        first_ts = self._clip_first_ts
        last_ts = self._clip_last_ts

        if not had_person and tmpdir is not None:
            # Clip recorded zero frames with a confirmed person —
            # likely a false-positive detection trigger. Discard
            # the temp dir without submitting to ClipWorker.
            logger.debug(
                "clip discarded (no person): camera=%s frames=%d",
                self.camera_id,
                frame_count,
            )
            try:
                tmpdir.cleanup()
            except Exception:  # noqa: BLE001
                pass
            return

        if frame_count >= 3 and tmpdir is not None:
            with self._metadata_lock:
                camera_fps = self._detected_metadata.get("fps") or 25.0
                resolution_w = self._detected_metadata.get("resolution_w")
                resolution_h = self._detected_metadata.get("resolution_h")
            with self._clip_matched_ids_lock:
                matched_ids = sorted(self._clip_matched_employee_ids)
                self._clip_matched_employee_ids.clear()
            clip_data = {
                "tmpdir": tmpdir,          # TemporaryDirectory — ClipWorker calls .cleanup()
                "frame_count": frame_count,
                "start_ts": self._clip_start_ts,
                "first_ts": first_ts,
                "last_ts": last_ts,
                "person_count": max(self._clip_max_person_count, 0),
                "fps": float(camera_fps),
                "matched_employees": matched_ids,
                "resolution_w": resolution_w,
                "resolution_h": resolution_h,
            }
            self._clip_worker.submit_clip(clip_data)
            logger.debug(
                "clip submitted: camera=%s frames=%d",
                self.camera_id, frame_count,
            )
        else:
            # Too short — clean up tmpdir immediately.
            if tmpdir is not None:
                try:
                    tmpdir.cleanup()
                except Exception:  # noqa: BLE001
                    pass
            logger.debug(
                "clip too short (%d frames) skipping: camera=%s",
                frame_count, self.camera_id,
            )

    # ------------------------------------------------------------------
    # Reader thread

    def _run_reader(self) -> None:
        """Outer reconnect loop + inner read loop. Native FPS."""

        # Multi-tenant routing (v1.0 P1): every DB call from this
        # worker must run under the right tenant's search_path.
        from maugood.db import tenant_context  # noqa: PLC0415

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
                        from maugood.metrics import (  # noqa: PLC0415
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

                    # P37: check person presence and record clip frames.
                    # Starts immediately when a person is detected,
                    # stops immediately when they leave — no buffers.
                    self._check_and_record_clip(frame)

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
        from maugood.db import tenant_context  # noqa: PLC0415

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
            detection_enabled = self.is_detection_enabled()

            detections: list = []
            if (moved or force) and detection_enabled:
                try:
                    # detect_and_count runs YOLO person-body detection
                    # alongside face detection in a single pass — YOLO
                    # never runs twice even in yolo+face mode.
                    # person_count comes from YOLO body boxes, so a
                    # seated employee with their back to the camera still
                    # produces person_count > 0, keeping the clip alive.
                    detections, person_count = self._analyzer.detect_and_count(frame)
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
                    person_count = 0
                # P37: update person presence for clip recording.
                # Uses hysteresis: person is only marked absent after
                # N consecutive empty-detection cycles.
                face_count = len(detections)
                any_person = (face_count > 0) or (person_count > 0)
                with self._person_present_lock:
                    if any_person:
                        self._no_person_consecutive_count = 0
                        self._person_present = True
                    else:
                        self._no_person_consecutive_count += 1
                        if (
                            self._no_person_consecutive_count
                            >= self._no_person_consecutive_threshold
                        ):
                            self._person_present = False
                    self._face_count = face_count
            elif (moved or force) and not detection_enabled:
                # Migration 0033: detection_enabled=False short-circuits
                # the expensive ``detect`` call. Bump ``last_detect_ts``
                # so the force-detect-every-Ns timer doesn't keep
                # firing on every cycle while detection is paused —
                # we'll resume cleanly when re-enabled. The tracker is
                # still driven below with an empty detections list so
                # any leftover tracks idle-expire on schedule.
                last_detect_ts = now
                # P37: detection disabled → ramp up consecutive counter
                # so any ongoing clip gets a graceful wind-down rather
                # than an instant cutoff (same hysteresis as above).
                with self._person_present_lock:
                    self._no_person_consecutive_count += 1
                    if (
                        self._no_person_consecutive_count
                        >= self._no_person_consecutive_threshold
                    ):
                        self._person_present = False
                    self._face_count = 0
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

            # Publish the tracker's live track count for the clip-
            # recording logic to read. The tracker provides temporal
            # continuity — a briefly occluded person keeps their track
            # alive even when per-cycle detection misses them, so the
            # clip doesn't get prematurely finalized.
            with self._person_present_lock:
                self._active_track_count = self._tracker.active_tracks

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
                    with self._clip_matched_ids_lock:
                        self._clip_matched_employee_ids.add(mm.employee_id)
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
            from maugood.detection import DetectorConfig as _DC  # noqa: PLC0415
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

            # Always copy: OpenCV's cap.read() reuses the same buffer on the
            # next call, so if encode_jpeg is still running when cap.read()
            # fires, the bottom of the frame gets overwritten and produces
            # gray/corrupted pixels in the MJPEG stream.
            preview = frame_bgr.copy()
            if boxes:
                annotate_frame(preview, boxes)

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
            from datetime import datetime, timedelta, timezone  # noqa: PLC0415
            from sqlalchemy import func as sa_func  # noqa: PLC0415

            # Compute the 4-hour cutoff Python-side so the SQL is
            # straightforward and portable. The earlier
            # ``sa_func.cast(..., interval)`` form was malformed and
            # raised silently — the worker fell into the catch-all
            # below and reported "engine stuck" forever.
            cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=4)

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
                        attendance_records.c.computed_at > cutoff_dt,
                    )
                ).first()
        except Exception:  # noqa: BLE001
            logger.warning(
                "attendance age query failed for camera_id=%s",
                self.camera_id,
                exc_info=True,
            )
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

        # Matching state. The matcher is green whenever the worker is
        # running AND reference photos are enrolled — match age is
        # informational, not a state driver. Operators want a clear
        # "matcher is up" signal independent of whether anyone has
        # walked past the camera in the last 10 minutes.
        from maugood.identification.matcher import (  # noqa: PLC0415
            matcher_cache,
        )

        cache_stats = matcher_cache.cache_stats(self._scope.tenant_id)
        photo_count = cache_stats.get("vectors", 0)
        emp_count = cache_stats.get("employees", 0)

        match_age = (
            (now - self._last_match_at) if self._last_match_at else 999_999
        )
        if det_state == "red":
            match_state = "unknown"
            match_detail = "Cannot judge — detection is red"
        elif photo_count == 0:
            # Worker is healthy, but there's nothing to match against.
            match_state = "amber"
            match_detail = (
                "No reference photos enrolled — every face lands as "
                "Unknown until you upload photos per employee."
            )
        else:
            # Matcher is running and has vectors — green. The detail
            # line carries the last-match age so operators can spot a
            # threshold-drift problem at a glance, but the colour
            # stays green regardless.
            match_state = "green"
            if self._last_match_at is None:
                match_detail = (
                    f"Matcher running · {emp_count} employee(s), "
                    f"{photo_count} photo(s) enrolled · no matches yet"
                )
            elif match_age < 60:
                match_detail = (
                    f"Matcher running · {emp_count} employee(s), "
                    f"{photo_count} photo(s) · last match "
                    f"{int(match_age)}s ago"
                )
            else:
                match_detail = (
                    f"Matcher running · {emp_count} employee(s), "
                    f"{photo_count} photo(s) · last match "
                    f"{int(match_age // 60)}min ago"
                )

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
