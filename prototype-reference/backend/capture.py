"""
capture.py — per-camera capture with a split reader/analyzer pipeline.

Architecture (Round 4 — speed rewrite):

  ┌─────────────────┐    latest_frame ref     ┌────────────────────┐
  │  Reader thread  │────────(lock)──────────▶│  Analyzer thread   │
  │                 │                         │                    │
  │  read RTSP      │                         │  get latest frame  │
  │  as fast as     │                         │  motion check      │
  │  possible       │                         │  detect (if motion)│
  │  downscale to   │                         │  save faces        │
  │  preview size   │                         │  update stats      │
  │  update preview │                         │                    │
  │  JPEG too       │                         │                    │
  └─────────────────┘                         └────────────────────┘

Why two threads?
  Before: reading + detection + saving were all in one loop. Detection
  takes 100-300ms on CPU, so the loop could only process ~3-4 frames/sec.
  Preview flicked at that rate too, which felt laggy.

  Now: reader runs at the camera's native FPS (~15-30 fps), keeping preview
  smooth. Analyzer runs at whatever the CPU can manage. Decoupled.

Why motion skip?
  Most CCTV footage is static for most of the time. A cheap grayscale
  frame-difference lets us skip the expensive detection call when nothing
  has changed. Empty hallway → near-zero CPU use.
"""

import cv2
import json
import numpy as np
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from db import init_db, get_conn
from detectors import DetectorConfig, DetectorMode, detect, quality_score
from tracker import IoUTracker, Track


# ---------------------------------------------------------------
# Tuning (Round 4 — speed)
# ---------------------------------------------------------------
CAPTURES_ROOT = Path("captures")
CAPTURES_ROOT.mkdir(exist_ok=True)

MAX_FACES_PER_EVENT = 10
MAX_EVENT_DURATION_SEC = 60.0
TRACK_TIMEOUT_SEC = 2.0

# Analyzer target rate. Reader runs at native camera rate.
# The analyzer actually runs as fast as CPU allows — this is only an upper
# bound to avoid burning CPU if detection happens to be faster than needed.
ANALYZER_MAX_FPS = 6
ANALYZER_MIN_INTERVAL = 1.0 / ANALYZER_MAX_FPS

# Preview is downscaled to this width before JPEG encoding. Cuts bandwidth
# and encoding time roughly in half vs. native 1080p.
PREVIEW_MAX_WIDTH = 640
JPEG_QUALITY_PREVIEW = 65     # lower quality is fine for live preview

# Saved face crop quality
JPEG_QUALITY_SAVE = 88

# Motion detection — skip expensive face detection when nothing is moving.
# We compare 160-wide grayscale frames (cheap) and count pixels that changed
# by more than MOTION_PIXEL_THRESHOLD intensity. If fewer than MOTION_MIN_PIXELS
# pixels changed, we skip detection this cycle.
MOTION_GRAY_WIDTH = 160
MOTION_PIXEL_THRESHOLD = 25     # 0..255
MOTION_MIN_PIXELS = 80          # out of MOTION_GRAY_WIDTH x (proportional) pixels

# Even if no motion, re-run detection every N seconds anyway so we don't
# get stuck on cached results if motion detection misfires.
FORCE_DETECT_EVERY_SEC = 3.0


# ---------------------------------------------------------------
# Shared runtime settings
# ---------------------------------------------------------------
class Settings:
    def __init__(self):
        self._lock = threading.Lock()
        self.detector_mode: DetectorMode = "insightface"
        self.show_body_boxes: bool = False
        self.det_size: int = 320       # detector input size, tunable at runtime

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "detector_mode": self.detector_mode,
                "show_body_boxes": self.show_body_boxes,
                "det_size": self.det_size,
            }

    def set_mode(self, mode: DetectorMode):
        if mode not in ("insightface", "yolo+face"):
            raise ValueError(f"invalid detector_mode: {mode}")
        with self._lock:
            self.detector_mode = mode

    def set_show_body_boxes(self, value: bool):
        with self._lock:
            self.show_body_boxes = bool(value)

    def set_det_size(self, value: int):
        value = int(value)
        if value not in (160, 224, 320, 480, 640):
            raise ValueError("det_size must be one of 160, 224, 320, 480, 640")
        with self._lock:
            self.det_size = value


settings = Settings()


# ---------------------------------------------------------------
# CameraWorker — one per active stream, split into reader + analyzer
# ---------------------------------------------------------------
class CameraWorker:
    def __init__(self, camera_id: int, camera_name: str, url: str):
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.url = url

        self.shutdown_event = threading.Event()
        self.reader_thread: Optional[threading.Thread] = None
        self.analyzer_thread: Optional[threading.Thread] = None

        self.tracker = IoUTracker(
            iou_threshold=0.3,
            timeout_sec=TRACK_TIMEOUT_SEC,
            max_duration_sec=MAX_EVENT_DURATION_SEC,
        )

        # Frame hand-off between reader and analyzer
        self._frame_lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None  # most recent raw frame from reader
        self._frame_seq: int = 0                          # incremented each read
        self._last_analyzed_seq: int = -1

        # Motion detection state (lives on analyzer side)
        self._prev_motion_gray: Optional[np.ndarray] = None
        self._last_detect_time: float = 0.0
        # Cached detections reused when motion is absent — we still draw them
        # on the preview so tracked boxes stay visible on a stationary subject
        self._cached_detections: list[dict] = []

        # Preview JPEG for MJPEG stream
        self._preview_lock = threading.Lock()
        self.latest_jpeg: Optional[bytes] = None

        self.state_lock = threading.Lock()
        self.stats = {
            "fps_reader": 0.0,
            "fps_analyzer": 0.0,
            "faces_in_frame": 0,
            "active_tracks": 0,
            "status": "starting",
            "total_events": 0,
            "total_faces_saved": 0,
            "motion_skipped": 0,
            "last_error": None,
        }

    # -----------------------------------------------------------
    # Public control
    # -----------------------------------------------------------
    def start(self):
        if self.reader_thread and self.reader_thread.is_alive():
            return
        self.shutdown_event.clear()
        self.reader_thread = threading.Thread(
            target=self._reader_loop, daemon=True, name=f"read-{self.camera_id}",
        )
        self.analyzer_thread = threading.Thread(
            target=self._analyzer_loop, daemon=True, name=f"ana-{self.camera_id}",
        )
        self.reader_thread.start()
        self.analyzer_thread.start()

    def stop(self, timeout: float = 5.0):
        self.shutdown_event.set()
        for t in (self.reader_thread, self.analyzer_thread):
            if t:
                t.join(timeout=timeout)
        self._close_all_tracks()

    def get_stats(self) -> dict:
        with self.state_lock:
            return dict(self.stats)

    def get_preview(self) -> Optional[bytes]:
        with self._preview_lock:
            return self.latest_jpeg

    # -----------------------------------------------------------
    # Reader thread: reads RTSP as fast as it can, keeps latest frame
    # -----------------------------------------------------------
    def _reader_loop(self):
        backoff = 1.0
        while not self.shutdown_event.is_set():
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not cap.isOpened():
                with self.state_lock:
                    self.stats["status"] = "reconnecting"
                    self.stats["last_error"] = "failed to open stream"
                self.shutdown_event.wait(backoff)
                backoff = min(backoff * 2, 30.0)
                continue

            with self.state_lock:
                self.stats["status"] = "streaming"
                self.stats["last_error"] = None
            backoff = 1.0

            last_fps_time = time.time()
            frames_this_sec = 0

            while not self.shutdown_event.is_set():
                ok, frame = cap.read()
                if not ok or frame is None:
                    with self.state_lock:
                        self.stats["status"] = "reconnecting"
                        self.stats["last_error"] = "read failed"
                    break

                # Stash latest frame (cheap assignment behind a lock)
                with self._frame_lock:
                    self._latest_frame = frame
                    self._frame_seq += 1

                # Build + store preview JPEG immediately so the MJPEG stream
                # is smooth even while the analyzer is busy.
                self._update_preview(frame)

                frames_this_sec += 1
                now = time.time()
                if now - last_fps_time >= 1.0:
                    with self.state_lock:
                        self.stats["fps_reader"] = round(
                            frames_this_sec / (now - last_fps_time), 1,
                        )
                    frames_this_sec = 0
                    last_fps_time = now

            cap.release()

        with self.state_lock:
            self.stats["status"] = "stopped"

    # -----------------------------------------------------------
    # Analyzer thread: pulls latest frame, runs detection + saves
    # -----------------------------------------------------------
    def _analyzer_loop(self):
        last_run = 0.0
        last_fps_time = time.time()
        frames_this_sec = 0

        while not self.shutdown_event.is_set():
            # Grab the latest frame (don't re-analyze the same one)
            with self._frame_lock:
                frame = self._latest_frame
                seq = self._frame_seq
            if frame is None or seq == self._last_analyzed_seq:
                time.sleep(0.02)
                continue

            # Throttle to ANALYZER_MAX_FPS
            now = time.time()
            if now - last_run < ANALYZER_MIN_INTERVAL:
                time.sleep(ANALYZER_MIN_INTERVAL - (now - last_run))
                now = time.time()
            last_run = now
            self._last_analyzed_seq = seq

            # Motion check
            motion = self._check_motion(frame)
            force = (now - self._last_detect_time) >= FORCE_DETECT_EVERY_SEC

            if motion or force:
                # Detect
                cfg = self._current_cfg()
                try:
                    detections = detect(frame, cfg)
                    self._cached_detections = detections
                    self._last_detect_time = now
                except Exception as e:
                    with self.state_lock:
                        self.stats["last_error"] = f"detect: {e}"[:100]
                    detections = self._cached_detections
            else:
                # Reuse cached detections — tracker gets nothing new this cycle
                detections = []
                with self.state_lock:
                    self.stats["motion_skipped"] += 1

            # Tracker update + event management
            pairs = self.tracker.update(detections, now=now)
            for track, det in pairs:
                if track.event_id is None:
                    self._open_event(track, now)
                self._handle_face(track, det, frame, now)

            # Retire expired tracks → close events
            for track in self.tracker.retire_expired(now=now):
                self._close_track(track)

            # Redraw preview with current boxes (overwrites reader's plain preview)
            # so the boxes appear stable while we're idle-skipping motion.
            self._update_preview(frame, pairs=pairs)

            # Stats
            frames_this_sec += 1
            if now - last_fps_time >= 1.0:
                with self.state_lock:
                    self.stats["fps_analyzer"] = round(
                        frames_this_sec / (now - last_fps_time), 1,
                    )
                frames_this_sec = 0
                last_fps_time = now
            with self.state_lock:
                self.stats["faces_in_frame"] = len(detections)
                self.stats["active_tracks"] = len(self.tracker.tracks)

    # -----------------------------------------------------------
    # Motion detection
    # -----------------------------------------------------------
    def _check_motion(self, frame) -> bool:
        """Return True if there's meaningful motion vs. the last analyzer frame.

        Uses downscaled grayscale for speed. Takes ~3ms on a typical frame,
        vs. 100-300ms for real face detection.
        """
        h, w = frame.shape[:2]
        if w == 0:
            return False
        scale = MOTION_GRAY_WIDTH / w
        gray = cv2.cvtColor(
            cv2.resize(frame, (MOTION_GRAY_WIDTH, max(1, int(h * scale)))),
            cv2.COLOR_BGR2GRAY,
        )
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        prev = self._prev_motion_gray
        self._prev_motion_gray = gray
        if prev is None or prev.shape != gray.shape:
            return True  # first frame — run detection

        diff = cv2.absdiff(prev, gray)
        changed = int(np.count_nonzero(diff > MOTION_PIXEL_THRESHOLD))
        return changed >= MOTION_MIN_PIXELS

    # -----------------------------------------------------------
    # Event management (unchanged from Round 2)
    # -----------------------------------------------------------
    def _current_cfg(self) -> DetectorConfig:
        s = settings.to_dict()
        return DetectorConfig(mode=s["detector_mode"], det_size=s["det_size"])

    def _open_event(self, track: Track, now: float):
        started_at = datetime.fromtimestamp(now)
        date_str = started_at.strftime("%Y-%m-%d")
        time_str = started_at.strftime("%H%M%S")

        with get_conn() as conn:
            cur = conn.execute(
                """INSERT INTO events
                   (camera_id, camera_name, folder, started_at, date,
                    frames_seen, faces_saved)
                   VALUES (?, ?, ?, ?, ?, 0, 0)""",
                (self.camera_id, self.camera_name, "(pending)",
                 started_at.isoformat(timespec="milliseconds"), date_str),
            )
            event_id = cur.lastrowid

            safe_cam = "".join(c if c.isalnum() or c in "-_" else "_"
                               for c in self.camera_name)
            folder_rel = Path(date_str) / safe_cam / f"event_{event_id:06d}_{time_str}"
            folder_abs = CAPTURES_ROOT / folder_rel
            folder_abs.mkdir(parents=True, exist_ok=True)

            conn.execute("UPDATE events SET folder = ? WHERE id = ?",
                         (str(folder_rel), event_id))

        track.event_id = event_id
        track.folder = str(folder_abs)
        with self.state_lock:
            self.stats["total_events"] += 1

    def _handle_face(self, track: Track, det: dict, frame, now: float):
        with get_conn() as conn:
            conn.execute(
                "UPDATE events SET frames_seen = frames_seen + 1 WHERE id = ?",
                (track.event_id,),
            )

        if track.max_duration_hit:
            return

        quality = quality_score(det)
        x1, y1, x2, y2 = det["bbox"]
        face_crop = frame[y1:y2, x1:x2]
        if face_crop.size == 0:
            return

        folder = Path(track.folder)
        save_this = False
        remove_path = None

        with get_conn() as conn:
            existing = conn.execute(
                """SELECT id, file_path, quality FROM faces
                   WHERE event_id = ? ORDER BY quality ASC""",
                (track.event_id,),
            ).fetchall()
            if len(existing) < MAX_FACES_PER_EVENT:
                save_this = True
            elif existing and quality > existing[0]["quality"]:
                save_this = True
                remove_path = existing[0]["file_path"]
                conn.execute("DELETE FROM faces WHERE id = ?", (existing[0]["id"],))

        if not save_this:
            return

        if remove_path:
            try:
                Path(remove_path).unlink(missing_ok=True)
            except OSError:
                pass

        fname = f"face_{track.faces_saved + 1:02d}_q{quality:.2f}.jpg"
        fpath = folder / fname
        cv2.imwrite(str(fpath), face_crop,
                    [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY_SAVE])

        emb_bytes = None
        if det["embedding"] is not None:
            emb_bytes = det["embedding"].astype(np.float32).tobytes()

        with get_conn() as conn:
            conn.execute(
                """INSERT INTO faces
                   (event_id, file_path, quality, det_score,
                    face_width, face_height, embedding)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (track.event_id, str(fpath), quality, det["det_score"],
                 det["face_width"], det["face_height"], emb_bytes),
            )
            conn.execute(
                "UPDATE events SET faces_saved = faces_saved + 1 WHERE id = ?",
                (track.event_id,),
            )

        track.faces_saved += 1
        with self.state_lock:
            self.stats["total_faces_saved"] += 1

    def _close_track(self, track: Track):
        if track.event_id is None:
            return
        ended_at = datetime.fromtimestamp(track.last_seen_at)
        duration = track.duration_sec
        with get_conn() as conn:
            conn.execute(
                """UPDATE events
                   SET ended_at = ?, duration_sec = ?, max_duration_hit = ?
                   WHERE id = ?""",
                (ended_at.isoformat(timespec="milliseconds"),
                 duration, 1 if track.max_duration_hit else 0,
                 track.event_id),
            )
        if track.folder:
            meta = {
                "event_id": track.event_id,
                "camera_id": self.camera_id,
                "camera_name": self.camera_name,
                "started_at": datetime.fromtimestamp(track.started_at).isoformat(timespec="milliseconds"),
                "ended_at": ended_at.isoformat(timespec="milliseconds"),
                "duration_sec": round(duration, 2),
                "faces_saved": track.faces_saved,
                "max_duration_hit": track.max_duration_hit,
            }
            try:
                with open(Path(track.folder) / "meta.json", "w") as f:
                    json.dump(meta, f, indent=2)
            except OSError:
                pass

    def _close_all_tracks(self):
        for track in self.tracker.retire_all():
            self._close_track(track)

    # -----------------------------------------------------------
    # Preview rendering — downscaled, encoded to JPEG
    # -----------------------------------------------------------
    def _update_preview(self, frame, pairs=None):
        """Encode a preview JPEG. If pairs is provided, draw tracked boxes on it."""
        preview = frame
        cfg = settings.to_dict()
        show_body = cfg.get("show_body_boxes", False)

        # Draw boxes first on the original then downscale, so coordinates match.
        if pairs:
            preview = frame.copy()
            H, W = preview.shape[:2]
            for track, det in pairs:
                x1, y1, x2, y2 = det["bbox"]
                fw, fh = x2 - x1, y2 - y1
                color = (0, 220, 0) if not track.max_duration_hit else (0, 220, 220)

                if show_body:
                    body_w = int(fw * 3.0)
                    body_h = int(fh * 7.5)
                    cx = (x1 + x2) // 2
                    bx1 = max(0, cx - body_w // 2)
                    bx2 = min(W, cx + body_w // 2)
                    by1 = max(0, y1 - int(fh * 0.4))
                    by2 = min(H, by1 + body_h)
                    body_col = (160, 220, 160) if not track.max_duration_hit else (200, 200, 160)
                    cv2.rectangle(preview, (bx1, by1), (bx2, by2), body_col, 1)

                cv2.rectangle(preview, (x1, y1), (x2, y2), color, 2)
                label = f"#{track.id} {track.duration_sec:.0f}s"
                if track.max_duration_hit:
                    label += " (max)"
                (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                cv2.rectangle(preview, (x1, y1 - th - 6),
                              (x1 + tw + 4, y1), color, -1)
                cv2.putText(preview, label, (x1 + 2, y1 - 3),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

        # Downscale for bandwidth + encoding speed
        h, w = preview.shape[:2]
        if w > PREVIEW_MAX_WIDTH:
            scale = PREVIEW_MAX_WIDTH / w
            preview = cv2.resize(preview, (PREVIEW_MAX_WIDTH, int(h * scale)),
                                 interpolation=cv2.INTER_AREA)

        # Footer (draw AFTER downscale so text stays crisp)
        ph, pw = preview.shape[:2]
        mode = cfg["detector_mode"]
        footer = f"{self.camera_name} | {datetime.now().strftime('%H:%M:%S')} | {mode} | {cfg['det_size']}"
        if show_body:
            footer += " | body"
        cv2.putText(preview, footer, (6, ph - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)

        ok, buf = cv2.imencode(".jpg", preview,
                               [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY_PREVIEW])
        if ok:
            with self._preview_lock:
                self.latest_jpeg = buf.tobytes()


# ---------------------------------------------------------------
# CaptureManager — enforces "one camera at a time"
# ---------------------------------------------------------------
class CaptureManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.current_worker: Optional[CameraWorker] = None
        init_db()

    def start_camera(self, camera_id: int, camera_name: str, url: str) -> dict:
        with self._lock:
            if self.current_worker:
                if self.current_worker.camera_id == camera_id:
                    return {"ok": True, "already_running": True,
                            "camera_id": camera_id}
                self.current_worker.stop()
                self.current_worker = None

            worker = CameraWorker(camera_id, camera_name, url)
            worker.start()
            self.current_worker = worker
            return {"ok": True, "camera_id": camera_id,
                    "camera_name": camera_name}

    def stop_current(self) -> dict:
        with self._lock:
            if not self.current_worker:
                return {"ok": True, "was_running": False}
            self.current_worker.stop()
            self.current_worker = None
            return {"ok": True, "was_running": True}

    def get_state(self) -> dict:
        with self._lock:
            if not self.current_worker:
                return {"running": False}
            w = self.current_worker
            return {
                "running": True,
                "camera_id": w.camera_id,
                "camera_name": w.camera_name,
                "stats": w.get_stats(),
            }

    def get_preview(self) -> Optional[bytes]:
        with self._lock:
            if not self.current_worker:
                return None
            return self.current_worker.get_preview()

    def current_camera_id(self) -> Optional[int]:
        with self._lock:
            return self.current_worker.camera_id if self.current_worker else None