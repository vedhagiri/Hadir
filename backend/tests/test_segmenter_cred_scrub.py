"""Regression test for the RTSP-credential log leak (Issue #3).

ffmpeg echoes the full input URL (incl. ``user:pass@``) on stderr; the
segmenter logged it verbatim, leaking plaintext RTSP credentials into
app logs + the diagnostics ring. ``_scrub_rtsp_creds`` masks the
userinfo before any log/ring/exception use.
"""

from __future__ import annotations

from maugood.capture.segmenter import (
    _ffmpeg_socket_timeout_flag,
    _scrub_rtsp_creds,
)


def test_scrub_masks_rtsp_credentials() -> None:
    s = ("Error opening input file "
         "rtsp://admin:S3cretPass@192.168.0.4:554/Streaming/Channels/101")
    out = _scrub_rtsp_creds(s)
    assert "S3cretPass" not in out
    assert "admin:" not in out
    assert "rtsp://***@192.168.0.4:554/Streaming/Channels/101" in out


def test_scrub_handles_rtsps_no_creds_and_empty() -> None:
    assert _scrub_rtsp_creds("rtsps://user:pw@host/path") == "rtsps://***@host/path"
    assert _scrub_rtsp_creds("Connection timed out") == "Connection timed out"
    assert _scrub_rtsp_creds("") == ""


def test_scrub_masks_multiple_urls_in_one_line() -> None:
    s = "tried rtsp://a:b@h1/x then rtsp://c:d@h2/y"
    out = _scrub_rtsp_creds(s)
    assert "a:b" not in out and "c:d" not in out
    assert out.count("***@") == 2


def test_scrub_masks_password_containing_at_signs() -> None:
    # The exact shape that leaked on a client host: a password with
    # embedded ``@`` chars. The first-``@`` regex masked only ``admin:F``
    # and left ``ncee@myHome9020@…`` exposed; the greedy form masks the
    # whole userinfo up to the last ``@`` before the host.
    s = ("Error opening input file "
         "rtsp://admin:F@ncee@myHome9020@10.10.10.212:554/cam/realmonitor")
    out = _scrub_rtsp_creds(s)
    assert "ncee" not in out
    assert "myHome9020" not in out
    assert "admin" not in out
    assert "rtsp://***@10.10.10.212:554/cam/realmonitor" in out


def test_ffmpeg_socket_timeout_flag_is_supported_or_none() -> None:
    # Whatever the test image's ffmpeg ships, the probe must return one
    # of the known flags or None — never a flag the build would reject.
    flag = _ffmpeg_socket_timeout_flag()
    assert flag in (None, "-rw_timeout", "-timeout", "-stimeout")
