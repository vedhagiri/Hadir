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

Storage structure::

    /person_clips/
        camera_{id}/
            {YYYY-MM-DD}_{HH-MM-SS}.mp4
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
        """Assemble collected frames into an MP4 video using ffmpeg,
        Fernet-encrypt it, persist to disk, and INSERT a
        ``person_clips`` row.

        Called from the clip worker thread — never blocks the reader.
        """

        from maugood.config import get_settings as _gs  # noqa: PLC0415
        import sqlalchemy as sa  # noqa: PLC0415
        from maugood.db import person_clips as _pc  # noqa: PLC0415

        settings = _gs()
        if not settings.clip_save_enabled:
            return

        frames: list = clip_data.get("frames", [])
        start_ts: float = clip_data.get("start_ts", 0.0)
        person_count: int = clip_data.get("person_count", 0)
        fps: float = float(clip_data.get("fps", 10.0))
        matched_employees: list[int] = clip_data.get("matched_employees", [])

        if len(frames) < _MIN_CLIP_FRAMES:
            logger.debug(
                "clip too short (%d frames) skipping: camera=%s",
                len(frames), self._camera_id,
            )
            return

        first_ts: float = frames[0][0]
        last_ts: float = frames[-1][0]
        clip_start_dt = datetime.fromtimestamp(first_ts, tz=timezone.utc)
        clip_end_dt = datetime.fromtimestamp(last_ts, tz=timezone.utc)
        duration = last_ts - first_ts

        # Build the file path.
        # Structure: person_clips_storage_path / camera_{id} / {timestamp}.mp4
        clip_dir = Path(settings.person_clips_storage_path) / f"camera_{self._camera_id}"
        start_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
        filename = f"{start_dt.strftime('%Y-%m-%d_%H-%M-%S')}.mp4"
        file_path = clip_dir / filename

        plain_bytes: Optional[bytes] = None
        try:
            clip_dir.mkdir(parents=True, exist_ok=True)

            # Write frames as temp JPEGs and encode via ffmpeg for a
            # reliable H.264 MP4 with a proper moov atom. The plain
            # bytes are returned in-memory — ffmpeg writes to a temp
            # file inside the tmpdir, never to the final path.
            plain_bytes = self._encode_ffmpeg(frames, fps=fps)
            if plain_bytes is None:
                return

            encrypted = encrypt_bytes(plain_bytes)
            file_path.write_bytes(encrypted)

            # Save thumbnail (first frame) alongside the MP4.
            thumb_path = file_path.with_suffix(".thumb.jpg")
            thumb_encrypted = encrypt_bytes(frames[0][1])
            thumb_path.write_bytes(thumb_encrypted)

            filesize = file_path.stat().st_size
            logger.info(
                "clip saved: camera=%s frames=%d "
                "duration=%.1fs size=%d path=%s",
                self._camera_id,
                len(frames), duration, filesize, file_path,
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
                        frame_count=len(frames),
                        person_count=person_count,
                        matched_employees=matched_employees,
                    )
                )
                clip_id = result.inserted_primary_key[0] if result.inserted_primary_key else None  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "clip INSERT failed: camera=%s reason=%s",
                self._camera_id, type(exc).__name__,
            )

        # Face crop extraction is NOT triggered automatically — the
        # user manually initiates it from the Face Crops tab. The clip
        # row starts with face_crops_status='pending'.

    def _encode_ffmpeg(
        self,
        frames: list[tuple[float, bytes]],
        fps: float = 10.0,
    ) -> Optional[bytes]:
        """Encode a list of ``(timestamp, jpeg_bytes)`` into an H.264 MP4
        using ffmpeg.

        Args:
            frames: list of ``(timestamp, jpeg_bytes)`` tuples.
            fps: playback framerate. Uses the camera's detected FPS
                 when available; falls back to 10.0.

        Returns the plain MP4 bytes on success, or ``None`` on failure.
        The output is written to a temporary file inside the temp dir
        and read back into memory — no plaintext ever touches the
        final output path.
        """

        with tempfile.TemporaryDirectory() as tmpdir:
            # Write each frame as a numbered JPEG file.
            for i, (_ts, jpeg_bytes) in enumerate(frames):
                frame_path = Path(tmpdir) / f"frame_{i:06d}.jpg"
                frame_path.write_bytes(jpeg_bytes)

            tmp_output = Path(tmpdir) / "output.mp4"

            # ffmpeg command: read the JPEG sequence and encode to H.264.
            # -y: overwrite output without asking
            # -framerate: matches the source camera FPS so playback speed
            #   and timing match the original stream exactly
            # -pattern_type glob -i '*.jpg': read all JPEGs in sequence
            # -c:v libx264: H.264 video codec
            # -pix_fmt yuv420p: ensure maximum compatibility
            # -preset medium: good compression efficiency without
            #   sacrificing encoding speed
            # -crf 18: high quality (visually lossless), preserves
            #   the original stream clarity
            # -movflags +faststart: moov atom at front for streaming
            cmd = [
                "ffmpeg", "-y",
                "-framerate", str(fps),
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
                cwd=tmpdir,
                timeout=60,
            )

            if result.returncode != 0:
                stderr = result.stderr.decode("utf-8", errors="replace")[:500]
                logger.warning(
                    "ffmpeg failed: camera=%s returncode=%d stderr=%s",
                    self._camera_id, result.returncode, stderr,
                )
                return None

            if not tmp_output.exists() or tmp_output.stat().st_size == 0:
                logger.warning(
                    "ffmpeg output empty: camera=%s", self._camera_id,
                )
                return None

            plain_bytes = tmp_output.read_bytes()
            if len(plain_bytes) == 0:
                return None

            return plain_bytes
