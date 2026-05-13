"""Dedicated thread for offloading clip video encoding + writing.

Each ``CaptureWorker`` owns one ``ClipWorker``. The reader thread
collects frames when a person is present, then submits the collected
data to a thread-safe queue as soon as the person leaves the frame.
The clip worker thread drains the queue, assembles the video via
ffmpeg, encrypts it, writes to disk, and INSERTs a ``person_clips``
row — all without blocking the reader.

Why ffmpeg?
    OpenCV's ``VideoWriter`` with ``mp4v`` fourcc produces MP4 files
    that are missing the ``moov`` atom on many systems, making them
    unplayable in browsers. ffmpeg with ``libx264`` always produces
    proper H.264 MP4s with correct metadata.

Storage structure (post-migration-0048)::

    /clips/
        {YYYYMMDD}/
            camera_{id}/
                {YYYYMMDD}-{start_HHMMSS}-{end_HHMMSS}_{camera_id}.mp4

Example::

    /clips/20260512/camera_1/20260512-130200-130512_1.mp4

Legacy clips written before migration 0048 remain at their original
path (``person_clips_storage_path`` root) — they are still served
correctly because ``file_path`` in the DB row is absolute.
"""

from __future__ import annotations

import logging
import queue
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy.engine import Engine

from maugood.employees.photos import encrypt_bytes
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Minimum frames required for a valid clip. Fewer than this and the
# video would be too short to decode meaningfully in a browser.
_MIN_CLIP_FRAMES = 3


class ClipWorker:
    """Dedicated thread for finalizing person clips asynchronously.

    Usage::

        worker = ClipWorker(engine=..., scope=..., camera_id=1, ...)
        worker.start()
        worker.submit_clip({"frames": [...], "start_ts": ...})
        ...
        worker.stop()
    """

    def __init__(
        self,
        *,
        engine: Engine,
        scope: TenantScope,
        camera_id: int,
        camera_name: str,
    ) -> None:
        self._engine = engine
        self._scope = scope
        self._camera_id = camera_id
        self._camera_name = camera_name

        # Bounded queue prevents OOM if the worker falls behind.
        self._queue: queue.Queue = queue.Queue(maxsize=16)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name=f"clipwk-{self._camera_id}",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout)
        self._thread = None

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def queue_size(self) -> int:
        """Return the number of clips waiting in the queue."""
        return self._queue.qsize()

    # ------------------------------------------------------------------
    # Public: submit a clip for finalization
    # ------------------------------------------------------------------

    def submit_clip(self, clip_data: dict) -> bool:
        """Submit clip data for finalization.

        Non-blocking. Returns ``True`` if the data was queued, or
        ``False`` if the queue was full (the clip is dropped and a
        warning is logged).
        """

        try:
            self._queue.put_nowait(clip_data)
            return True
        except queue.Full:
            logger.warning(
                "clip worker queue full (camera=%s) — dropping clip",
                self._camera_id,
            )
            return False

    # ------------------------------------------------------------------
    # Internal: worker thread
    # ------------------------------------------------------------------

    def _run(self) -> None:
        from maugood.db import tenant_context  # noqa: PLC0415

        with tenant_context(self._scope.tenant_schema):
            while not self._stop.is_set():
                try:
                    clip_data = self._queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                try:
                    self._finalize_clip(clip_data)
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "clip finalization failed: camera=%s reason=%s",
                        self._camera_id,
                        type(exc).__name__,
                    )

    def _finalize_clip(self, clip_data: dict) -> None:
        """Encode the collected frames into an H.264 MP4, Fernet-encrypt
        it, persist to disk, and INSERT a ``person_clips`` row.

        Frames are already on disk in clip_data["tmpdir"] (a
        TemporaryDirectory object). This method calls tmpdir.cleanup()
        in its finally block so the disk space is freed after ffmpeg
        finishes regardless of success or failure.
        """

        import sqlalchemy as sa  # noqa: PLC0415
        from maugood.config import get_settings as _gs  # noqa: PLC0415
        from maugood.db import person_clips as _pc  # noqa: PLC0415

        settings = _gs()
        if not settings.clip_save_enabled:
            return

        tmpdir = clip_data.get("tmpdir")       # TemporaryDirectory object
        frame_count = int(clip_data.get("frame_count", 0))
        start_ts = float(clip_data.get("start_ts", 0.0))
        first_ts = float(clip_data.get("first_ts", 0.0))
        last_ts = float(clip_data.get("last_ts", 0.0))
        camera_fps = float(clip_data.get("fps", 25.0))
        person_count = int(clip_data.get("person_count", 0))
        matched_employees: list[int] = clip_data.get("matched_employees", [])
        resolution_w: Optional[int] = clip_data.get("resolution_w")
        resolution_h: Optional[int] = clip_data.get("resolution_h")

        try:
            if tmpdir is None or frame_count < _MIN_CLIP_FRAMES:
                logger.debug(
                    "clip too short (%d frames) skipping: camera=%s",
                    frame_count, self._camera_id,
                )
                return

            # Compute actual FPS from real wall-clock timestamps so
            # playback duration exactly matches the recorded duration.
            duration = last_ts - first_ts
            if duration > 0.5 and frame_count >= 2:
                actual_fps = frame_count / duration
                actual_fps = max(0.5, min(actual_fps, 120.0))
            else:
                actual_fps = camera_fps

            clip_start_dt = datetime.fromtimestamp(first_ts, tz=timezone.utc)
            clip_end_dt = datetime.fromtimestamp(last_ts, tz=timezone.utc)

            # --- New storage layout (post-0048) ----------------------------
            # /clips/{YYYYMMDD}/camera_{id}/{YYYYMMDD}-{start_HHMMSS}-{end_HHMMSS}_{camera_id}.mp4
            date_str = clip_start_dt.strftime("%Y%m%d")
            start_hms = clip_start_dt.strftime("%H%M%S")
            end_hms = clip_end_dt.strftime("%H%M%S")
            filename = f"{date_str}-{start_hms}-{end_hms}_{self._camera_id}.mp4"

            clip_dir = (
                Path(settings.clip_storage_root)
                / date_str
                / f"camera_{self._camera_id}"
            )
            file_path = clip_dir / filename
            thumb_path = file_path.with_suffix(".thumb.jpg")

            encoding_start_at = datetime.now(timezone.utc)
            filesize = 0
            try:
                clip_dir.mkdir(parents=True, exist_ok=True)

                plain_bytes = self._encode_from_tmpdir(
                    tmpdir_path=tmpdir.name,
                    fps=actual_fps,
                )
                if plain_bytes is None:
                    return

                encoding_end_at = datetime.now(timezone.utc)

                encrypted = encrypt_bytes(plain_bytes)
                file_path.write_bytes(encrypted)

                # Thumbnail: first frame already on disk.
                thumb_srcs = sorted(Path(tmpdir.name).glob("frame_*.jpg"))
                if thumb_srcs:
                    thumb_encrypted = encrypt_bytes(thumb_srcs[0].read_bytes())
                    thumb_path.write_bytes(thumb_encrypted)

                filesize = file_path.stat().st_size
                logger.info(
                    "clip saved: camera=%s frames=%d fps=%.2f "
                    "duration=%.1fs size=%d path=%s",
                    self._camera_id,
                    frame_count, actual_fps, duration, filesize, file_path,
                )

            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "clip write failed: camera=%s reason=%s",
                    self._camera_id, type(exc).__name__,
                )
                file_path.unlink(missing_ok=True)
                thumb_path.unlink(missing_ok=True)
                return

            clip_id: Optional[int] = None
            try:
                with self._engine.begin() as conn:
                    result = conn.execute(
                        sa.insert(_pc).values(
                            tenant_id=self._scope.tenant_id,
                            camera_id=self._camera_id,
                            employee_id=None,
                            track_id=None,
                            detection_event_id=None,
                            clip_start=clip_start_dt,
                            clip_end=clip_end_dt,
                            duration_seconds=duration,
                            file_path=str(file_path),
                            filesize_bytes=filesize,
                            frame_count=frame_count,
                            person_count=person_count,
                            matched_employees=matched_employees,
                            encoding_start_at=encoding_start_at,
                            encoding_end_at=encoding_end_at,
                            fps_recorded=round(actual_fps, 2),
                            resolution_w=int(resolution_w) if resolution_w else None,
                            resolution_h=int(resolution_h) if resolution_h else None,
                        )
                    )
                    clip_id = (  # type: ignore[arg-type]
                        result.inserted_primary_key[0]
                        if result.inserted_primary_key
                        else None
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "clip INSERT failed: camera=%s reason=%s",
                    self._camera_id, type(exc).__name__,
                )

            # Trigger asynchronous face matching. Fire-and-forget daemon
            # thread — never blocks the ClipWorker drain loop. Row starts
            # with matched_status='pending' (server_default).
            if clip_id is not None:
                _trigger_face_match(clip_id, self._scope)

        finally:
            # Always free temp disk space, regardless of success/failure.
            if tmpdir is not None:
                try:
                    tmpdir.cleanup()
                except Exception:  # noqa: BLE001
                    pass

    def _encode_from_tmpdir(
        self,
        tmpdir_path: str,
        fps: float = 25.0,
    ) -> Optional[bytes]:
        """Encode frames already on disk in ``tmpdir_path`` into H.264 MP4.

        Frame files are named ``frame_000000.jpg``, ``frame_000001.jpg``,
        etc. — as written by the reader thread. ffmpeg reads them via a
        glob pattern; ``output.mp4`` is written to the same directory
        (the glob only matches ``*.jpg`` so no collision).

        The ``fps`` argument must be the actual frame rate computed from
        real timestamps, not the camera-reported value, so that playback
        duration matches recorded duration exactly.
        """

        tmp_output = Path(tmpdir_path) / "output.mp4"

        cmd = [
            "ffmpeg", "-y",
            "-framerate", f"{fps:.6f}",
            "-pattern_type", "glob",
            "-i", "*.jpg",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "medium",
            "-crf", "18",
            "-movflags", "+faststart",
            str(tmp_output),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            cwd=tmpdir_path,
            timeout=300,  # 5 min — large clips take time to encode
        )

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[:500]
            logger.warning(
                "ffmpeg failed: camera=%s fps=%.2f returncode=%d stderr=%s",
                self._camera_id, fps, result.returncode, stderr,
            )
            return None

        if not tmp_output.exists() or tmp_output.stat().st_size == 0:
            logger.warning("ffmpeg output empty: camera=%s", self._camera_id)
            return None

        plain_bytes = tmp_output.read_bytes()
        return plain_bytes if plain_bytes else None


def _trigger_face_match(clip_id: int, scope: "TenantScope") -> None:
    """Launch a fire-and-forget daemon thread to process face matching
    for a single clip. Never blocks the caller — errors are logged at
    WARNING, never raised.
    """

    def _run() -> None:
        try:
            from maugood.person_clips.reprocess import (  # noqa: PLC0415
                process_single_clip,
            )
            process_single_clip(clip_id, scope)
        except Exception:  # noqa: BLE001
            logger.warning(
                "face-match trigger failed: clip=%s camera=%s",
                clip_id, scope.tenant_id,
                exc_info=True,
            )

    t = threading.Thread(
        target=_run,
        name=f"facematch-{clip_id}",
        daemon=True,
    )
    t.start()
