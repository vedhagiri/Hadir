"""Per-camera RTSP reader.

Opens a ``cv2.VideoCapture``, reads at a throttled rate (4 fps by
default — we're spending the CPU budget on face detection downstream),
and feeds each frame to the analyzer + tracker + event emitter.
Reconnects with backoff on read failure. The plaintext RTSP URL is held
only on this thread's stack frame; it never gets logged or persisted.

Health: a frame counter resets every 60 seconds, and a
``camera_health_snapshots`` row is written with ``frames_last_minute``
and a reachability flag.

This module is test-friendly — ``VideoCaptureFactory`` and ``Analyzer``
are both injectable, so ``tests/test_capture.py`` drives a fake feed
without OpenCV or InsightFace.
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
from hadir.capture.tracker import Bbox, IoUTracker
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


# --- Worker loop ----------------------------------------------------------


@dataclass
class ReaderConfig:
    """Tuning knobs for a single camera worker."""

    target_fps: float = 4.0
    iou_threshold: float = 0.3
    track_idle_timeout_s: float = 3.0
    reconnect_backoff_initial_s: float = 1.0
    reconnect_backoff_max_s: float = 30.0
    health_interval_s: float = 60.0
    # Hard cap so a sick loop doesn't spin forever. The manager resets
    # this on stop(), not on normal progress.
    max_iterations: Optional[int] = None


class CaptureWorker:
    """Owns one camera's read→detect→track→emit loop.

    The decrypted RTSP URL is passed in at construction and held only
    on this instance. Call ``start()`` to spawn the thread and
    ``stop()`` to ask it to unwind — the thread observes ``_stop``
    between iterations and releases its VideoCapture before returning.
    """

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
    ) -> None:
        self._engine = engine
        self._scope = scope
        self.camera_id = camera_id
        self.camera_name = camera_name
        self._rtsp_url_plain = rtsp_url_plain
        self._analyzer = analyzer
        self._capture_factory = capture_factory
        self._config = config or ReaderConfig()

        self._tracker = IoUTracker(
            iou_threshold=self._config.iou_threshold,
            idle_timeout_s=self._config.track_idle_timeout_s,
        )
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name=f"capture-{self.camera_id}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        self._thread = None

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ------------------------------------------------------------------

    def _run(self) -> None:
        """Outer reconnect loop + inner frame loop."""

        backoff = self._config.reconnect_backoff_initial_s
        iterations = 0
        while not self._stop.is_set():
            cap: Optional[FrameSource] = None
            try:
                cap = self._capture_factory(self._rtsp_url_plain)
                if not cap.isOpened():
                    self._record_unreachable("could not open stream")
                    backoff = self._bump_backoff(backoff)
                    self._sleep_interruptible(backoff)
                    continue

                # Loop reset — successful open counts as a fresh minute.
                frame_count_minute = 0
                last_health_ts = time.time()
                next_read_at = time.time()

                while not self._stop.is_set():
                    now = time.time()
                    if now < next_read_at:
                        self._sleep_interruptible(min(0.1, next_read_at - now))
                        continue
                    next_read_at = now + (1.0 / self._config.target_fps)

                    ok, frame = cap.read()
                    if not ok or frame is None:
                        logger.info(
                            "camera %s: read returned empty — reconnecting",
                            self.camera_name,
                        )
                        break
                    frame_count_minute += 1

                    # Detect → track → emit one event per NEW track only.
                    try:
                        detections = self._analyzer.detect(frame)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "camera %s: analyzer error: %s",
                            self.camera_name,
                            type(exc).__name__,
                        )
                        detections = []

                    if detections:
                        matches = self._tracker.update(
                            [d.bbox for d in detections], now
                        )
                        for match in matches:
                            if not match.is_new:
                                continue
                            try:
                                events_io.emit_detection_event(
                                    self._engine,
                                    self._scope,
                                    camera_id=self.camera_id,
                                    frame_bgr=frame,
                                    bbox=match.bbox,
                                    track_id=match.track_id,
                                )
                            except Exception as exc:  # noqa: BLE001
                                logger.warning(
                                    "camera %s: event emit failed: %s",
                                    self.camera_name,
                                    type(exc).__name__,
                                )
                    else:
                        # Still drive track expiry even on empty frames so
                        # idle tracks clear out on the next update.
                        self._tracker.update([], now)

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

                    iterations += 1
                    if (
                        self._config.max_iterations is not None
                        and iterations >= self._config.max_iterations
                    ):
                        # Flush the partial-minute bucket before exiting
                        # so the test harness sees a health row even on
                        # a truncated run.
                        if frame_count_minute > 0:
                            self._record_health(frame_count_minute, reachable=True)
                        return

                # Flush any remaining frames in the minute bucket (reached
                # when the inner while breaks on an empty read).
                if frame_count_minute > 0:
                    self._record_health(frame_count_minute, reachable=True)

            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "camera %s: capture loop error: %s",
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
            backoff = self._bump_backoff(backoff)
            self._sleep_interruptible(backoff)

    # ------------------------------------------------------------------

    def _sleep_interruptible(self, seconds: float) -> None:
        # Wait on the stop event so ``stop()`` wakes us up promptly.
        self._stop.wait(timeout=seconds)

    def _bump_backoff(self, current: float) -> float:
        return min(current * 2.0, self._config.reconnect_backoff_max_s)

    def _record_health(self, frames: int, *, reachable: bool, note: Optional[str] = None) -> None:
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
