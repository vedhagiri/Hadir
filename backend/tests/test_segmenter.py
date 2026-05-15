"""Unit tests for RtspSegmenter — Option B stream-copy.

The ffmpeg subprocess is not exercised here (real RTSP isn't
available in a unit test). Instead we cover:

* Segment-file parsing: ``get_segments_in_range`` correctly maps
  filename timestamps → wall-clock and selects overlapping segments.
* Janitor purge: files older than RETENTION_SECONDS get unlinked,
  newer ones survive.
* Lifecycle: start/stop is idempotent + stop doesn't hang.
* ffmpeg arg construction: the produced argv carries the
  load-bearing flags (``-c copy``, ``-segment_time``, RTSP transport,
  strftime filename pattern).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from maugood.capture.segmenter import (
    RETENTION_SECONDS,
    SEGMENT_SECONDS,
    RtspSegmenter,
    Segment,
)


# ---- get_segments_in_range ------------------------------------------------


def _make_seg_file(dir_path: Path, ts: float) -> Path:
    """Create an empty segment file whose filename encodes ``ts``."""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    name = f"seg_{dt.strftime('%Y%m%d_%H%M%S')}.mp4"
    p = dir_path / name
    p.write_bytes(b"")
    return p


def test_get_segments_in_range_picks_overlapping_files(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    base = 1_700_000_000.0  # arbitrary fixed epoch
    _make_seg_file(tmp_path, base + 0)
    _make_seg_file(tmp_path, base + SEGMENT_SECONDS)
    _make_seg_file(tmp_path, base + SEGMENT_SECONDS * 2)
    _make_seg_file(tmp_path, base + SEGMENT_SECONDS * 3)

    # Window: 5 s into seg 1 → 5 s into seg 2 → overlaps seg 1 + seg 2.
    out = seg.get_segments_in_range(
        base + 5.0, base + SEGMENT_SECONDS + 5.0,
    )
    assert len(out) == 2
    assert out[0].start_ts == base + 0
    assert out[1].start_ts == base + SEGMENT_SECONDS


def test_get_segments_in_range_skips_outside_window(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    base = 1_700_000_000.0
    _make_seg_file(tmp_path, base + 0)
    _make_seg_file(tmp_path, base + 1000)  # far future
    # Empty window — no overlap with either.
    out = seg.get_segments_in_range(base + 500.0, base + 510.0)
    assert out == []


def test_get_segments_in_range_skips_malformed_filenames(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    base = 1_700_000_000.0
    _make_seg_file(tmp_path, base + 0)
    # ffmpeg partial-write garbage / unrelated file.
    (tmp_path / "ffmpeg.tmp").write_bytes(b"junk")
    (tmp_path / "seg_garbage.mp4").write_bytes(b"")
    out = seg.get_segments_in_range(base, base + SEGMENT_SECONDS)
    assert len(out) == 1
    assert out[0].path.name.startswith("seg_")


def test_get_segments_returns_sorted_ascending(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    base = 1_700_000_000.0
    # Create out-of-order on disk.
    _make_seg_file(tmp_path, base + 30)
    _make_seg_file(tmp_path, base + 0)
    _make_seg_file(tmp_path, base + 20)
    _make_seg_file(tmp_path, base + 10)
    out = seg.get_segments_in_range(base, base + 50)
    starts = [s.start_ts for s in out]
    assert starts == sorted(starts)


# ---- janitor / purge ------------------------------------------------------


def test_purge_expired_unlinks_old_segments(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    now = time.time()
    fresh = _make_seg_file(tmp_path, now - 30)
    stale = _make_seg_file(tmp_path, now - RETENTION_SECONDS - 60)
    seg._purge_expired()  # noqa: SLF001
    assert fresh.exists()
    assert not stale.exists()


# ---- lifecycle ------------------------------------------------------------


def test_start_stop_idempotent(tmp_path: Path) -> None:
    """Double-start is a no-op; stop without start is a no-op.
    ffmpeg spawn will fail (no real RTSP) but the watchdog catches
    that and the thread loops — ``stop`` must still unwind cleanly."""
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://nonexistent.invalid/x",
        segments_dir=tmp_path,
    )
    seg.start()
    # Second start does not spawn a second watchdog.
    seg.start()
    assert seg.is_running()
    # Stop unwinds even when the subprocess never opened successfully.
    seg.stop(timeout_s=3.0)
    assert not seg.is_running()
    # Idempotent stop.
    seg.stop(timeout_s=1.0)


# ---- ffmpeg arg construction ---------------------------------------------


def test_ffmpeg_args_carry_load_bearing_flags(tmp_path: Path) -> None:
    seg = RtspSegmenter(
        tenant_id=1, camera_id=42,
        rtsp_url_plain="rtsp://example/stream",
        segments_dir=tmp_path,
    )
    args = seg._build_ffmpeg_args()  # noqa: SLF001
    # Must NOT contain ``-c:v libx264`` or similar — that would be
    # an encode, defeating the whole design.
    joined = " ".join(args)
    assert "libx264" not in joined
    assert "libx265" not in joined
    # Load-bearing flags.
    assert "ffmpeg" == args[0]
    assert "-c" in args and "copy" in args
    assert "-rtsp_transport" in args and "tcp" in args
    assert "-f" in args and "segment" in args
    assert "-segment_time" in args
    assert str(SEGMENT_SECONDS) in args
    # The RTSP URL is on the command line — exactly once and only
    # behind ``-i``.
    assert "rtsp://example/stream" in args
    # strftime filename — segment name pattern is the last positional.
    assert "seg_%Y%m%d_%H%M%S.mp4" in args[-1]


# ---- stats payload --------------------------------------------------------


def test_stats_payload_shape(tmp_path: Path) -> None:
    """Dashboard reads ``stats()`` — make sure the keys it needs are
    always present."""
    seg = RtspSegmenter(
        tenant_id=1, camera_id=99,
        rtsp_url_plain="rtsp://fake/test",
        segments_dir=tmp_path,
    )
    now = time.time()
    _make_seg_file(tmp_path, now - 20)
    _make_seg_file(tmp_path, now - 10)
    snap = seg.stats()
    assert {
        "running", "segment_count", "latest_segment_age_s",
        "disk_bytes", "restart_count", "segments_dir",
    } <= set(snap.keys())
    assert snap["segment_count"] == 2
    assert snap["restart_count"] == 0


def test_segment_dataclass_end_ts():
    s = Segment(path=Path("/tmp/whatever"), start_ts=100.0)
    assert s.end_ts_estimate == 100.0 + SEGMENT_SECONDS
