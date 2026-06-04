"""Per-camera RTSP stream-copy segmenter.

Option B from the encoding-elimination design: each camera spawns one
``ffmpeg`` subprocess that reads the RTSP stream and writes fixed-
duration MP4 segments with ``-c copy``. **No encoding is performed**
— the H.264 packets flow straight from the network to disk.

When a person-present clip is finalized, the ClipWorker selects the
segment files that cover the [t_start, t_end] window and concat-copies
them into the final encrypted MP4 — also zero encode.

This runs **in parallel** with the existing ``cv2.VideoCapture`` reader
thread. The cost is one extra RTSP connection per camera; the win is
~5–10× less CPU on the clip-save path.

Lifecycle:
* ``start()`` spawns the ffmpeg subprocess and a watchdog thread that
  monitors the process + restarts it on crash with exponential backoff.
* ``stop()`` terminates the subprocess and joins the watchdog.
* ``get_segments_in_range(t_start, t_end)`` returns the list of
  segment files that cover the requested window.
* A periodic janitor purges segments older than the rolling retention
  window so disk doesn't grow unbounded.
"""

from __future__ import annotations

import functools
import logging
import os
import re
import shutil
import subprocess
import collections
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# Strip credentials from any rtsp(s) URL before it can reach a log line,
# the diagnostics ring, or an exception message. ffmpeg echoes the full
# input URL (incl. ``user:pass@``) on its stderr; logging it verbatim
# leaked plaintext RTSP credentials (Issue #3). The reader path already
# redacts — this closes the segmenter path. Matches the whole userinfo
# segment between ``://`` and the LAST ``@`` before the host, so a
# password containing ``@`` (e.g. ``admin:F@ncee@9020@host``) is fully
# masked — the earlier ``[^/\s@]+`` form stopped at the first ``@`` and
# leaked the rest. ``[^/\s]*`` is greedy and can't cross ``/`` (path) or
# whitespace, so it stays inside the authority component.
_RTSP_CRED_RE = re.compile(r"(rtsps?://)[^/\s]*@", re.IGNORECASE)


def _scrub_rtsp_creds(text: str) -> str:
    """Replace ``rtsp://user:pass@host`` with ``rtsp://***@host``.

    Defensive: never raises (returns the input unchanged on any error)
    so the redaction can sit on the hot logging path safely.
    """

    if not text:
        return text
    try:
        return _RTSP_CRED_RE.sub(r"\1***@", text)
    except Exception:  # noqa: BLE001
        return "<redaction-error>"


@functools.lru_cache(maxsize=1)
def _ffmpeg_socket_timeout_flag() -> Optional[str]:
    """Return the ffmpeg input flag THIS build accepts for an RTSP
    socket read/write timeout (microseconds), or ``None`` if the build
    supports none of them.

    Why this exists: ffmpeg renamed the socket-timeout option across
    versions — recent builds expose ``-rw_timeout`` (generic avio) and
    ``-timeout`` (rtsp demuxer); older builds (≤4.x) only have
    ``-stimeout``. Hardcoding ``-rw_timeout`` meant a deployed image
    whose ffmpeg lacked it aborted *every* segmenter spawn with
    ``Option rw_timeout not found`` (rc=8) before opening the stream —
    so no segments were ever written and every clip finalize failed.
    Probing the actual binary once (cached) makes stream-copy work on
    whatever ffmpeg the image ships, and degrades to "no flag" rather
    than crashing if none is found (the load-bearing connect-phase
    bound already lives in the reader's pre-flight, so omitting the
    segmenter's own timeout is safe defence-in-depth, not a regression).
    """

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    help_text = ""
    # ``-h full`` lists every option incl. protocol/demuxer AVOptions.
    # Combine stdout+stderr; never raise — probing must not break boot.
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-h", "full"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        help_text = (proc.stdout or "") + (proc.stderr or "")
    except Exception:  # noqa: BLE001
        return None
    # Preference order: the RTSP demuxer's own ``-timeout`` (microseconds)
    # FIRST, then the legacy ``-stimeout`` (≤4.x), and ``-rw_timeout`` LAST.
    # ``-rw_timeout`` shows up in ``-h full`` on modern ffmpeg (7.x) but is
    # an AVIO/protocol-only option — the rtsp demuxer REJECTS it as an input
    # option ("Option rw_timeout not found", rc=8), which aborts every
    # segmenter spawn and breaks all stream-copy clip recording. Picking
    # ``-timeout`` for rtsp:// inputs is correct on both modern and old
    # builds. Match on the bare token so a word-boundary check isn't fooled
    # by substrings.
    for flag in ("timeout", "stimeout", "rw_timeout"):
        if re.search(rf"(?<![\w-])-{flag}\b", help_text):
            return f"-{flag}"
    return None


# ----- Configuration knobs --------------------------------------------------
#
# All overrideable via env so an operator can tune without code change.
# Defaults are conservative for the typical office-camera deployment.
#
# SEGMENT_SECONDS — duration of each rolling segment file. Smaller =
#   sharper clip boundaries but more files on disk. Stream-copy can
#   only cut on keyframes, so this is also the minimum keyframe gap
#   we honor; 10 s matches typical camera keyframe intervals.
#
# RETENTION_SECONDS — how long to keep segments on disk before the
#   janitor purges them. Must be >= the longest possible person-clip
#   so a clip finalize doesn't find its segments already deleted.
#   Default 600 s = 10 min.
#
# RESTART_BACKOFF_INITIAL_S / MAX_S — exponential backoff for crash
#   recovery.

SEGMENT_SECONDS = int(os.environ.get("MAUGOOD_RTSP_SEGMENT_SECONDS", "10"))
RETENTION_SECONDS = int(os.environ.get("MAUGOOD_RTSP_SEGMENT_RETENTION_S", "600"))
RESTART_BACKOFF_INITIAL_S = 1.0
RESTART_BACKOFF_MAX_S = 30.0

# A spawned ffmpeg that streamed at least this long is treated as a
# genuinely-working process that hit a transient blip → its respawn
# backoff resets to INITIAL (quick recovery). A *fast-fail* (dead
# camera: ffmpeg spawns successfully then exits in ~1-2 s with "No route
# to host") runs for far less than this, so the backoff keeps GROWING
# instead of resetting — this is what prevents the ~1-2 s respawn storm
# that previously flooded logs + churned CPU on offline cameras.
_HEALTHY_RUN_S = max(30.0, float(SEGMENT_SECONDS) * 2.0)


def _next_backoff(ran_for: float, current_backoff: float) -> float:
    """Decide the respawn backoff after an ffmpeg run of ``ran_for`` s.

    * ran_for >= ``_HEALTHY_RUN_S`` → genuine streaming, transient exit:
      reset to ``RESTART_BACKOFF_INITIAL_S``.
    * otherwise (fast-fail / dead camera) → exponential growth capped at
      ``RESTART_BACKOFF_MAX_S``.
    """

    if ran_for >= _HEALTHY_RUN_S:
        return RESTART_BACKOFF_INITIAL_S
    return min(current_backoff * 2.0, RESTART_BACKOFF_MAX_S)

# Janitor scans every N seconds for expired segments.
JANITOR_INTERVAL_S = 30.0


# Segment filename format. ``%Y%m%d_%H%M%S`` is UTC; we parse it back
# in ``get_segments_in_range`` to derive each segment's start time.
# ``-strftime 1`` tells ffmpeg's segment muxer to evaluate the format.
_SEGMENT_NAME_FORMAT = "seg_%Y%m%d_%H%M%S.mp4"
_SEGMENT_NAME_RE = re.compile(r"^seg_(\d{8}_\d{6})\.mp4$")


@dataclass
class Segment:
    """One on-disk segment file."""

    path: Path
    start_ts: float  # Unix epoch seconds (UTC), parsed from filename.

    @property
    def end_ts_estimate(self) -> float:
        """End time is start + SEGMENT_SECONDS; actual on-disk duration
        may differ by ~50 ms due to ffmpeg's segmenter alignment."""
        return self.start_ts + SEGMENT_SECONDS


class RtspSegmenter:
    """Owns one ffmpeg subprocess per camera + a rolling segment dir.

    Not started by default — the ``CaptureWorker`` constructs this
    only when ``MAUGOOD_CLIP_SAVING_MODE=stream_copy``. The existing
    encoding-based path stays available behind the same flag for
    rollback.
    """

    def __init__(
        self,
        *,
        tenant_id: int,
        camera_id: int,
        rtsp_url_plain: str,
        segments_dir: Path,
    ) -> None:
        self._tenant_id = tenant_id
        self._camera_id = camera_id
        self._rtsp_url_plain = rtsp_url_plain
        self._segments_dir = Path(segments_dir)
        self._stop = threading.Event()
        self._proc: Optional[subprocess.Popen] = None
        self._watchdog_thread: Optional[threading.Thread] = None
        self._janitor_thread: Optional[threading.Thread] = None
        # Track when ffmpeg first emits a non-zero-size segment so the
        # operator's Pipeline Monitor row can show "warming up" vs
        # "live".
        self._first_segment_at: Optional[float] = None
        self._last_segment_at: Optional[float] = None
        self._restart_count = 0
        # TEMP-DIAGNOSTIC-2026-05-20 — track restart timestamps so we
        # can emit ``segmenter_thrashing`` when N restarts happen in a
        # short window. Bounded; only the most-recent 60 timestamps
        # are kept.
        self._restart_ts_window: "collections.deque[float]" = collections.deque(
            maxlen=60
        )

    # ---- lifecycle --------------------------------------------------

    def start(self) -> None:
        """Create the segments dir + spawn ffmpeg + watchdog."""

        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            return
        try:
            self._segments_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning(
                "rtsp segmenter: cannot create segments dir %s: %s",
                self._segments_dir, type(exc).__name__,
            )
            return
        self._stop.clear()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            name=f"rtsp-seg-watchdog-{self._camera_id}",
            daemon=True,
        )
        self._janitor_thread = threading.Thread(
            target=self._janitor_loop,
            name=f"rtsp-seg-janitor-{self._camera_id}",
            daemon=True,
        )
        self._watchdog_thread.start()
        self._janitor_thread.start()
        logger.info(
            "rtsp segmenter started: camera=%s segments_dir=%s segment_seconds=%s",
            self._camera_id,
            self._segments_dir,
            SEGMENT_SECONDS,
        )

    def stop(self, timeout_s: float = 5.0) -> None:
        """Signal stop, kill ffmpeg, join threads."""

        self._stop.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        for t in (self._watchdog_thread, self._janitor_thread):
            if t is not None and t.is_alive():
                t.join(timeout=timeout_s)
        self._watchdog_thread = None
        self._janitor_thread = None
        self._proc = None
        logger.info("rtsp segmenter stopped: camera=%s", self._camera_id)

    def is_running(self) -> bool:
        return (
            self._watchdog_thread is not None
            and self._watchdog_thread.is_alive()
        )

    # ---- subprocess management --------------------------------------

    def _build_ffmpeg_args(self) -> list[str]:
        """ffmpeg command for stream-copy segmentation.

        Key flags:
        * ``-rtsp_transport tcp`` — more reliable than UDP for most
          cameras on a LAN.
        * ``-fflags +nobuffer`` — surface frames to disk fast; no
          internal buffering to mask network jitter.
        * ``-c copy`` — the heart of the design: stream-copy, no
          re-encode.
        * ``-f segment`` + ``-segment_time SEGMENT_SECONDS`` — rolling
          fixed-duration segments.
        * ``-segment_format mp4`` + ``-movflags +faststart`` — each
          segment is a self-contained playable MP4.
        * ``-reset_timestamps 1`` — each segment's internal PTS starts
          at zero, so downstream tools see consistent timing.
        * ``-strftime 1`` — evaluate ``%Y%m%d_%H%M%S`` in the output
          filename → easy to map segment file to wall-clock time.
        """
        # Bound the segmenter's own socket I/O so a dead camera can't
        # leave its ffmpeg subprocess hanging on a silent connection.
        # ``-rw_timeout`` (microseconds, applied before ``-i``) covers
        # read/write stalls. The subprocess is already isolated from the
        # backend event loop, so this is defence-in-depth — the load-
        # bearing connect-phase bound lives in the reader's pre-flight
        # (``CaptureWorker._preflight_connect``). Sourced from the same
        # ``rtsp_read_timeout_sec`` setting as the OpenCV reader path.
        from maugood.config import get_settings  # noqa: PLC0415

        rw_us = int(max(1.0, get_settings().rtsp_read_timeout_sec) * 1_000_000)
        # Use whichever socket-timeout flag THIS ffmpeg build accepts
        # (rw_timeout / timeout / stimeout). If the build supports none,
        # omit it — the segmenter still runs and the connect-phase bound
        # in the reader pre-flight still protects against dead cameras.
        # Hardcoding a flag a given build rejects aborts every spawn
        # (rc=8 "Option not found") and breaks all clip recording.
        timeout_flag = _ffmpeg_socket_timeout_flag()
        timeout_args = [timeout_flag, str(rw_us)] if timeout_flag else []
        return [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            *timeout_args,
            "-fflags", "+nobuffer",
            "-i", self._rtsp_url_plain,
            "-c", "copy",
            "-an",  # no audio — surveillance cameras' audio rarely useful
            "-f", "segment",
            "-segment_time", str(SEGMENT_SECONDS),
            "-segment_format", "mp4",
            "-segment_atclocktime", "1",
            "-reset_timestamps", "1",
            "-strftime", "1",
            "-movflags", "+faststart+frag_keyframe+empty_moov",
            str(self._segments_dir / _SEGMENT_NAME_FORMAT),
        ]

    def _spawn(self) -> Optional[subprocess.Popen]:
        try:
            proc = subprocess.Popen(  # noqa: S603
                self._build_ffmpeg_args(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
            )
            return proc
        except FileNotFoundError:
            logger.error(
                "rtsp segmenter: ffmpeg not found on PATH — install ffmpeg"
            )
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "rtsp segmenter: ffmpeg spawn failed camera=%s: %s",
                self._camera_id, type(exc).__name__,
            )
            return None

    def _watchdog_loop(self) -> None:
        """Spawn, monitor, restart with exponential backoff."""

        backoff = RESTART_BACKOFF_INITIAL_S
        while not self._stop.is_set():
            proc = self._spawn()
            if proc is None:
                # Hard failure (e.g. ffmpeg missing). Sleep then retry
                # with exponential backoff so the log doesn't flood.
                self._sleep_interruptible(backoff)
                backoff = min(backoff * 2, RESTART_BACKOFF_MAX_S)
                continue
            self._proc = proc
            spawn_ts = time.time()
            # NOTE: backoff is intentionally NOT reset here. Resetting on
            # every successful spawn was the restart-storm bug — a dead
            # camera's ffmpeg spawns fine then exits in ~1-2 s, so the
            # reset undid the exponential growth and we respawned every
            # ~1-2 s forever. We now reset only after a *healthy run*
            # (see ``_next_backoff`` below).
            # Block until the subprocess exits OR stop is signalled.
            # We poll every 0.5 s so a stop signal doesn't wait for
            # the subprocess to finish.
            while not self._stop.is_set():
                if proc.poll() is not None:
                    rc = proc.returncode
                    stderr_tail = ""
                    try:
                        if proc.stderr is not None:
                            stderr_tail = proc.stderr.read(2048).decode(
                                "utf-8", errors="replace"
                            )[-500:]
                    except Exception:  # noqa: BLE001
                        pass
                    # Issue #3 — scrub RTSP credentials before this text
                    # touches the log line OR the diagnostics ring (the
                    # ``short_reason`` below is derived from it).
                    stderr_tail = _scrub_rtsp_creds(stderr_tail)
                    logger.warning(
                        "rtsp segmenter: ffmpeg exit camera=%s rc=%s stderr=%r",
                        self._camera_id, rc, stderr_tail,
                    )
                    self._restart_count += 1
                    # TEMP-DIAGNOSTIC-2026-05-20 — anomaly emit.
                    try:
                        from maugood.diagnostics import (  # noqa: PLC0415
                            record_ffmpeg_restart,
                            record_segmenter_thrashing,
                        )
                        # Trim stderr to the first non-empty line — the
                        # signal is "No route to host" / "Connection
                        # timed out" / "EOF", not the full traceback.
                        short_reason = next(
                            (ln.strip() for ln in stderr_tail.splitlines()
                             if ln.strip()),
                            f"exit rc={rc}",
                        )[:160]
                        record_ffmpeg_restart(
                            tenant_id=self._tenant_id,
                            camera_id=self._camera_id,
                            camera_name=None,
                            exit_code=rc,
                            short_reason=short_reason,
                        )
                        # Thrashing detector: > 5 restarts in last 30 s.
                        now_ts = time.time()
                        self._restart_ts_window.append(now_ts)
                        restarts_30s = sum(
                            1 for t in self._restart_ts_window
                            if (now_ts - t) <= 30.0
                        )
                        if restarts_30s >= 5:
                            record_segmenter_thrashing(
                                tenant_id=self._tenant_id,
                                camera_id=self._camera_id,
                                camera_name=None,
                                restarts_30s=restarts_30s,
                            )
                    except Exception:  # noqa: BLE001
                        pass
                    break
                time.sleep(0.5)
            # Make sure the subprocess is dead before respawning.
            if proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
            self._proc = None
            if self._stop.is_set():
                break
            # Backoff before respawn. A healthy run resets to INITIAL
            # (quick recovery from a transient blip); a fast-fail keeps
            # the backoff growing toward MAX so an offline camera settles
            # into a 30 s respawn cadence instead of a 1-2 s storm.
            ran_for = time.time() - spawn_ts
            backoff = _next_backoff(ran_for, backoff)
            self._sleep_interruptible(backoff)

    def _sleep_interruptible(self, seconds: float) -> None:
        """Sleep that wakes immediately when stop is signalled."""
        self._stop.wait(timeout=seconds)

    # ---- segment queries (called by ClipWorker on finalize) ---------

    def get_segments_in_range(
        self, t_start: float, t_end: float
    ) -> list[Segment]:
        """Return segments whose [start, start+SEGMENT_SECONDS] window
        overlaps the requested [t_start, t_end] range.

        Sorted by start_ts ascending. The first segment will likely
        cover earlier-than-t_start footage because ``-c copy`` can
        only cut at keyframes; this is documented behaviour.
        """

        segments = self._list_segments()
        out: list[Segment] = []
        for seg in segments:
            if seg.end_ts_estimate < t_start:
                continue
            if seg.start_ts > t_end:
                continue
            out.append(seg)
        out.sort(key=lambda s: s.start_ts)
        return out

    def _list_segments(self) -> list[Segment]:
        """Scan the segments dir, parse filenames into Segment objects.

        Files that don't match the expected naming pattern are
        skipped (e.g. partial writes ffmpeg hasn't renamed yet).
        """
        out: list[Segment] = []
        try:
            for p in self._segments_dir.iterdir():
                m = _SEGMENT_NAME_RE.match(p.name)
                if m is None:
                    continue
                try:
                    dt = datetime.strptime(m.group(1), "%Y%m%d_%H%M%S")
                    start_ts = dt.replace(tzinfo=timezone.utc).timestamp()
                except ValueError:
                    continue
                out.append(Segment(path=p, start_ts=start_ts))
        except (OSError, FileNotFoundError):
            return []
        return out

    # ---- janitor ----------------------------------------------------

    def _janitor_loop(self) -> None:
        """Purge segments older than the retention window."""

        while not self._stop.is_set():
            self._sleep_interruptible(JANITOR_INTERVAL_S)
            if self._stop.is_set():
                break
            try:
                self._purge_expired()
            except Exception:  # noqa: BLE001
                logger.exception(
                    "rtsp segmenter janitor failed: camera=%s",
                    self._camera_id,
                )

    def _purge_expired(self) -> None:
        cutoff = time.time() - RETENTION_SECONDS
        purged = 0
        for seg in self._list_segments():
            if seg.start_ts < cutoff:
                try:
                    seg.path.unlink(missing_ok=True)
                    purged += 1
                except OSError:
                    pass
        if purged:
            logger.debug(
                "rtsp segmenter janitor: camera=%s purged=%d segments",
                self._camera_id, purged,
            )

    # ---- observability ----------------------------------------------

    def stats(self) -> dict:
        """Surfaced on the Pipeline Monitor Clip Saving row when in
        stream_copy mode. Cheap to call — just scans the segments dir."""

        segs = self._list_segments()
        now = time.time()
        latest = max((s.start_ts for s in segs), default=None)
        latest_age = (now - latest) if latest is not None else None
        total_bytes = 0
        for s in segs:
            try:
                total_bytes += s.path.stat().st_size
            except OSError:
                pass
        return {
            "running": self.is_running(),
            "segment_count": len(segs),
            "latest_segment_age_s": (
                round(latest_age, 1) if latest_age is not None else None
            ),
            "disk_bytes": total_bytes,
            "restart_count": self._restart_count,
            "segments_dir": str(self._segments_dir),
        }
