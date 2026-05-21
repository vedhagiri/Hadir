"""Frame Diagnostics — TEMP-DIAGNOSTIC-2026-05-20.

Temporary, anomaly-triggered telemetry for investigating Live Capture
frame drops + low FPS. Stays OFF by default; an operator with Admin
turns it on from the ``Frame Diagnostics`` tab in the UI, lets the
system run for 1-2 hours, inspects the events, then turns it off.

Removal: every file in this package + every call to its public API is
tagged ``TEMP-DIAGNOSTIC-2026-05-20`` for an easy ``grep -r`` cleanup.

Why in-memory rather than a DB table:
  * No Alembic migration (this is temporary).
  * Bounded memory (deque ``maxlen=2000``) regardless of how long the
    session runs.
  * Backend restart drops the ring — acceptable for a 1-2 hour
    investigation; the UI surfaces ``session_started_at`` so the
    operator can tell when the data starts.

Why anomaly-triggered:
  * The hot path (reader inner loop) fires 25× per second per camera.
    Logging every frame is what we're trying to avoid — that's
    exactly the kind of overhead that hides the actual bottleneck.
  * Each ``record_*`` helper checks ``is_enabled()`` first and bails
    in O(1) when off. The instrumentation cost on the hot path when
    diagnostics is OFF is four ``time.monotonic()`` calls per frame
    (~200 ns each — invisible at 25 fps).
"""

from maugood.diagnostics.recorder import (
    clear,
    is_enabled,
    record_detection_slow,
    record_ffmpeg_restart,
    record_frame_slow,
    record_reader_read_failed,
    record_rtsp_reconnect,
    record_segmenter_thrashing,
    session_started_at,
    set_enabled,
    snapshot,
)

__all__ = [
    "clear",
    "is_enabled",
    "record_detection_slow",
    "record_ffmpeg_restart",
    "record_frame_slow",
    "record_reader_read_failed",
    "record_rtsp_reconnect",
    "record_segmenter_thrashing",
    "session_started_at",
    "set_enabled",
    "snapshot",
]
