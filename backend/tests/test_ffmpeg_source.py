"""Tests for the low-CPU ffmpeg detection reader.

Two surfaces:

* ``FfmpegFrameSource`` end-to-end against a generated file (skipped when
  ffmpeg isn't installed) — proves it pipes downscaled bgr24 frames and
  satisfies the cv2-compatible ``isOpened``/``read``/``release`` surface.
* ``CaptureWorker._use_ffmpeg_reader`` selection logic — proves the
  opt-in flag + per-mode gating without spawning anything.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest

from maugood.capture.ffmpeg_source import FfmpegFrameSource
from maugood.capture.reader import CaptureWorker, ReaderConfig, default_capture_factory
from maugood.db import get_engine
from maugood.tenants.scope import TenantScope

TENANT = TenantScope(tenant_id=1)
_HAVE_FFMPEG = shutil.which("ffmpeg") is not None


class _DummyAnalyzer:
    """Minimal analyzer stand-in — the worker only stores it; the
    selection tests never call detection."""

    def detect(self, _frame):  # pragma: no cover - unused in these tests
        return []


def _make_worker(*, recording_mode: str, capture_factory) -> CaptureWorker:
    return CaptureWorker(
        engine=get_engine(),
        scope=TENANT,
        camera_id=99001,
        camera_name="ffmpeg-reader-test",
        rtsp_url_plain="rtsp://fake/stream",
        analyzer=_DummyAnalyzer(),
        capture_factory=capture_factory,
        config=ReaderConfig(),
        recording_mode=recording_mode,
    )


# --- FfmpegFrameSource (integration) ---------------------------------------


@pytest.mark.skipif(not _HAVE_FFMPEG, reason="ffmpeg not installed")
def test_ffmpeg_source_pipes_downscaled_frames(tmp_path):
    clip = tmp_path / "src.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=2:size=1280x720:rate=15",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip),
        ],
        check=True,
    )

    src = FfmpegFrameSource(str(clip), fps=4, width=320, height=240)
    try:
        assert src.isOpened()
        frames = 0
        first_shape = None
        while True:
            ok, frame = src.read()
            if not ok or frame is None:
                break
            if first_shape is None:
                first_shape = frame.shape
            assert frame.dtype == np.uint8
            frames += 1
    finally:
        src.release()

    # Downscaled to the requested box (320x240x3 BGR).
    assert first_shape == (240, 320, 3)
    # fps=4 over ~2 s of video → a handful of frames, far below the
    # source's 30 native frames. Exact count is encoder-dependent; just
    # assert the throttle clearly engaged.
    assert 3 <= frames <= 12


@pytest.mark.skipif(not _HAVE_FFMPEG, reason="ffmpeg not installed")
def test_ffmpeg_source_eof_returns_false(tmp_path):
    clip = tmp_path / "tiny.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=640x480:rate=10",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip),
        ],
        check=True,
    )
    src = FfmpegFrameSource(str(clip), fps=4, width=160, height=120)
    try:
        while True:
            ok, frame = src.read()
            if not ok:
                break
        # After EOF, subsequent reads keep returning the sentinel.
        ok2, frame2 = src.read()
        assert ok2 is False and frame2 is None
    finally:
        src.release()


# --- Selection logic -------------------------------------------------------


def test_use_ffmpeg_reader_disabled_by_default():
    """Default settings.detection_reader='cv2' → never use ffmpeg."""
    w = _make_worker(
        recording_mode="logs_only", capture_factory=default_capture_factory
    )
    assert w._use_ffmpeg_reader() is False


def test_use_ffmpeg_reader_gating(monkeypatch):
    import maugood.capture.reader as rdr

    # Build the worker under real settings first (construction reads
    # clip_saving_mode), THEN patch get_settings for the gating call.
    w = _make_worker(
        recording_mode="logs_only", capture_factory=default_capture_factory
    )

    class _S:
        detection_reader = "ffmpeg"

    monkeypatch.setattr(rdr, "get_settings", lambda: _S())

    # logs_only → detection-only frames → ffmpeg reader.
    assert w._use_ffmpeg_reader() is True

    # save_clips + stream_copy → clip comes from the segmenter → ffmpeg ok.
    w._recording_mode = "save_clips"
    w._clip_saving_mode = "stream_copy"
    assert w._use_ffmpeg_reader() is True

    # save_clips + encode → reader frames build the MP4 → must stay cv2.
    w._clip_saving_mode = "encode"
    assert w._use_ffmpeg_reader() is False


def test_use_ffmpeg_reader_requires_default_factory(monkeypatch):
    """A test/injected factory is always honoured (never replaced by
    the ffmpeg reader) so scripted-feed tests keep working."""
    import maugood.capture.reader as rdr

    w = _make_worker(
        recording_mode="logs_only",
        capture_factory=lambda _url: None,  # injected (non-default)
    )

    class _S:
        detection_reader = "ffmpeg"

    monkeypatch.setattr(rdr, "get_settings", lambda: _S())

    assert w._use_ffmpeg_reader() is False
