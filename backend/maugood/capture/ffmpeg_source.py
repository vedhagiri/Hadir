"""FFmpeg-subprocess frame source — low-CPU detection reader.

Drop-in replacement for ``cv2.VideoCapture`` on the capture reader's hot
path. Instead of decoding every frame at the camera's native resolution
and native fps (what ``cv2.VideoCapture`` + ``cap.read()`` does), this
spawns ONE ffmpeg subprocess per camera that decodes once and emits a
**downscaled, fps-capped** ``rawvideo`` stream over a pipe:

    ffmpeg -rtsp_transport tcp -i <url>
           -vf fps=<N>,scale=<W>:<H>:force_original_aspect_ratio=decrease,
                pad=<W>:<H>:-1:-1
           -f rawvideo -pix_fmt bgr24 pipe:1

Why this is dramatically cheaper for a multi-camera host:

* The capture pipeline only needs frames for **detection** (YOLO / face
  at det_size ≤ 640). It never needs the full 4 MP frame. With
  ``clip_saving_mode='stream_copy'`` (the default) the saved clip comes
  from the separate ``RtspSegmenter`` stream-copy ffmpeg, NOT from these
  frames — so downscaling here costs the pipeline nothing.
* ``cv2.read()`` does a full-resolution YUV→BGR ``sws_scale`` on EVERY
  decoded frame at native fps. This source does the scale once per
  *output* frame (e.g. 4 fps) at the small target size — eliminating
  ~native_fps/N × (full-res ÷ small-res) of color-convert work.
* Each frame handed to Python is ~900 KB (640×480) instead of ~12 MB
  (2688×1520). That is the bulk of the per-camera memory footprint and
  the per-frame memory-bandwidth cost across 21 cameras.

This is a direct port of the proven ``clips_preview_v2`` prototype reader
(``camera_worker.py``), which ran 21 × 4 MP HEVC cameras with stable CPU
and memory on the same client hardware where the native-fps ``cv2`` reader
saturated the box.

The class implements the same minimal surface the reader loop uses —
``isOpened()`` / ``read()`` / ``release()`` / ``get()`` — so it slots in
behind the existing ``FrameSource`` Protocol with no changes to the
reader/analyzer/tracker/clip logic.

Security: the plaintext RTSP URL is passed to ffmpeg via ``argv`` (not a
shell — ``shell=False``) and is never logged. ffmpeg stderr is discarded
so a credential-bearing error line can't leak. Only the stripped host is
ever surfaced by the caller.
"""

from __future__ import annotations

import logging
import os
import select
import signal
import subprocess
import threading
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


# OpenCV CAP_PROP_* integer constants we answer in ``get()`` without
# importing cv2 (kept in sync with cv2; values are stable ABI constants).
_CAP_PROP_FRAME_WIDTH = 3
_CAP_PROP_FRAME_HEIGHT = 4
_CAP_PROP_FPS = 5


class FfmpegFrameSource:
    """One ffmpeg subprocess → downscaled bgr24 frames over a pipe.

    Mirrors the ``FrameSource`` Protocol (``isOpened`` / ``read`` /
    ``release``) plus a ``get(prop)`` shim so ``_detect_camera_metadata``
    can probe it without special-casing.
    """

    def __init__(
        self,
        url: str,
        *,
        fps: int = 4,
        width: int = 640,
        height: int = 480,
        loglevel: str = "error",
        read_timeout_s: float = 15.0,
    ) -> None:
        self._url = url
        self._fps = max(1, int(fps))
        self._w = max(16, int(width))
        self._h = max(16, int(height))
        self._loglevel = loglevel
        self._read_timeout_s = float(read_timeout_s)
        self._frame_bytes = self._w * self._h * 3

        self._proc: Optional[subprocess.Popen] = None
        self._stdout_fd: int = -1
        self._closed = False
        self._lock = threading.Lock()

        self._spawn()

    # ------------------------------------------------------------------

    def _build_cmd(self) -> list[str]:
        # fps filter first (drop frames), then aspect-preserving downscale
        # into a fixed WxH box (pad keeps the output size constant so the
        # Python read is a fixed-size chunk). ``-an`` drops audio.
        vf = (
            f"fps={self._fps},"
            f"scale={self._w}:{self._h}:force_original_aspect_ratio=decrease,"
            f"pad={self._w}:{self._h}:-1:-1"
        )
        cmd = ["ffmpeg", "-nostdin", "-loglevel", self._loglevel]
        # Force TCP transport only for RTSP — the same default the cv2
        # reader uses (UDP drops corrupt H.264). For non-rtsp inputs
        # (e.g. a file feed in tests) the option is irrelevant + omitted.
        if self._url.lower().startswith(("rtsp://", "rtsps://")):
            cmd += ["-rtsp_transport", "tcp", "-fflags", "nobuffer",
                    "-flags", "low_delay", "-probesize", "1M",
                    "-analyzeduration", "1M"]
        cmd += [
            "-i", self._url,
            "-an",
            "-vf", vf,
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "pipe:1",
        ]
        return cmd

    def _spawn(self) -> None:
        # bufsize=0 → unbuffered raw pipe so select()+os.read see bytes
        # as ffmpeg writes them (no Python-side buffering to confuse the
        # timeout). stderr discarded so no credential line can leak.
        self._proc = subprocess.Popen(
            self._build_cmd(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            close_fds=True,
        )
        if self._proc.stdout is not None:
            self._stdout_fd = self._proc.stdout.fileno()

    # ------------------------------------------------------------------
    # FrameSource surface

    def isOpened(self) -> bool:  # noqa: N802 — mirrors cv2.VideoCapture
        p = self._proc
        return p is not None and p.poll() is None and self._stdout_fd >= 0

    def read(self):  # type: ignore[no-untyped-def]
        """Return ``(ok, frame)`` like ``cv2.VideoCapture.read()``.

        ``ok=False, frame=None`` on EOF (ffmpeg exited / stream dropped)
        or read-timeout (mid-stream stall) — the reader loop treats that
        as a read failure and reconnects, exactly as with cv2.
        """

        raw = self._read_exact(self._frame_bytes)
        if raw is None:
            return False, None
        try:
            frame = np.frombuffer(raw, dtype=np.uint8).reshape(
                (self._h, self._w, 3)
            )
        except ValueError:
            return False, None
        return True, frame

    def _read_exact(self, n: int) -> Optional[bytes]:
        fd = self._stdout_fd
        if fd < 0:
            return None
        buf = bytearray()
        while len(buf) < n:
            if self._closed:
                return None
            try:
                ready, _, _ = select.select([fd], [], [], self._read_timeout_s)
            except (OSError, ValueError):
                return None
            if not ready:
                # No bytes within the timeout → mid-stream stall. Bail so
                # the worker reconnects rather than blocking forever.
                return None
            try:
                chunk = os.read(fd, n - len(buf))
            except OSError:
                return None
            if not chunk:
                return None  # EOF — ffmpeg exited
            buf += chunk
        return bytes(buf)

    def get(self, prop: int) -> float:  # noqa: D401 — cv2-compatible shim
        """cv2-compatible ``get`` shim.

        Always returns 0.0 ("unknown"). The frames this source delivers
        are *downscaled* (e.g. 640×480) — reporting those as the camera's
        detected resolution/fps would be misleading. ``_detect_camera_
        metadata`` treats 0 as unknown and skips it, so the camera row's
        true metadata (from a prior cv2 probe, or NULL) is left intact.
        The constants are kept for documentation / future use.
        """

        _ = (_CAP_PROP_FRAME_WIDTH, _CAP_PROP_FRAME_HEIGHT, _CAP_PROP_FPS)
        return 0.0

    def release(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            p, self._proc = self._proc, None
        if p is None or p.poll() is not None:
            return
        # SIGTERM lets ffmpeg close the RTSP session cleanly; SIGKILL if
        # it doesn't comply within 2 s.
        try:
            p.terminate()
            p.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                p.kill()
                p.wait(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            try:
                p.send_signal(signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
        finally:
            if p.stdout is not None:
                try:
                    p.stdout.close()
                except Exception:  # noqa: BLE001
                    pass
