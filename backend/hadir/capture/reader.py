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

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

from sqlalchemy.engine import Engine

from hadir.capture import events as events_io
from hadir.capture.analyzer import Analyzer
from hadir.capture.annotate import AnnotationBox, annotate_frame, encode_jpeg
from hadir.capture.directory import employee_directory
from hadir.capture.tracker import Bbox, IoUTracker, TrackMatch
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


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
        "min_face_quality_to_save": 0.35,
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

                self._set_status("streaming", error=None)
                backoff = self._config.reconnect_backoff_initial_s

                last_fps_ts = time.time()
                frames_this_sec = 0
                frame_count_minute = 0
                last_health_ts = time.time()

                while not self._stop.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        logger.info(
                            "camera %s: read returned empty — reconnecting",
                            self.camera_name,
                        )
                        self._set_status("reconnecting", error="read failed")
                        break

                    # Hand the frame to the analyzer + count for fps.
                    with self._frame_lock:
                        self._latest_frame = frame
                        self._frame_seq += 1

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
                    detections = []
            else:
                with self._stats_lock:
                    cur = int(self._stats["motion_skipped"] or 0)
                    self._stats["motion_skipped"] = cur + 1

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
                per_detection_match.append(
                    (mm.employee_id, mm.score) if mm else None
                )

            # Build the annotation box list and publish it for the
            # reader to draw onto subsequent preview frames. We only
            # overwrite the cached list when we actually ran detection
            # — motion-skip cycles leave the previous boxes in place
            # so a still subject keeps their label.
            if moved or force:
                self._publish_cached_boxes(detections, matches, per_detection_match)

            # One detection_events row per NEW track, never per frame.
            # Snapshot the capture_config under the lock so a
            # mid-iteration update_config doesn't change values
            # half-way through the inner loop.
            current_capture_config = self.get_capture_config()
            for det, match, pm in zip(
                detections, matches, per_detection_match
            ):
                if not match.is_new:
                    continue
                try:
                    events_io.emit_detection_event(
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
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "camera %s: event emit failed: %s",
                        self.camera_name,
                        type(exc).__name__,
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
