"""RTSP helpers: encrypt + decrypt URLs, parse host, grab single frame.

The encryption path is Fernet-based (same ``MAUGOOD_FERNET_KEY`` as the
photo-on-disk encryption in P6). Callers store the ciphertext as TEXT;
the plaintext URL only exists in memory for the life of a decrypt-to-use
block.

``rtsp_host`` is the only "safe" representation ever returned to a
client or written to a log. It strips credentials (userinfo) and keeps
the host (+ port if non-default).

``grab_single_frame`` opens the RTSP stream with OpenCV, grabs one
frame, and releases — with a hard wall-clock timeout so a dead camera
doesn't wedge the request. Used by the on-demand preview endpoint; the
P8 capture pipeline uses its own long-running reader.
"""

from __future__ import annotations

import concurrent.futures
import logging
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse, urlunparse

from cryptography.fernet import Fernet, InvalidToken

from maugood.config import get_settings

logger = logging.getLogger(__name__)

# 5-second wall clock for the single-frame grab. Long enough for an
# RTSP handshake + keyframe wait on a reasonable LAN, short enough that
# an unreachable camera doesn't hold the request thread hostage.
PREVIEW_TIMEOUT_SECONDS = 5.0


# --- Fernet helpers ---------------------------------------------------------


def _fernet() -> Fernet:
    settings = get_settings()
    try:
        return Fernet(settings.fernet_key.encode("utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "MAUGOOD_FERNET_KEY is missing or malformed for RTSP encryption."
        ) from exc


def encrypt_url(plain_url: str) -> str:
    """Return the Fernet ciphertext token (urlsafe-base64 text)."""

    return _fernet().encrypt(plain_url.encode("utf-8")).decode("ascii")


def decrypt_url(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("stored RTSP URL could not be decrypted") from exc


# --- Host extraction --------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RtspParts:
    """Safe-to-expose view of an RTSP URL."""

    host: str  # ``host`` or ``host:port`` — never includes credentials


def rtsp_host(url: str) -> str:
    """Return ``host[:port]`` from an RTSP URL, stripping credentials.

    If the URL is unparseable or has no host we return ``"unknown"`` so
    downstream formatters don't blow up — the scheme itself is rejected
    earlier by ``parse_rtsp_url``.
    """

    try:
        parts = urlparse(url)
    except Exception:
        return "unknown"

    host = parts.hostname or "unknown"
    # Keep the port when present and non-default (554 is the RTSP default).
    if parts.port is not None and parts.port != 554:
        return f"{host}:{parts.port}"
    return host


def parse_rtsp_url(url: str) -> RtspParts:
    """Validate + parse an RTSP URL. Raises ``ValueError`` if malformed.

    This is the only place that inspects the plaintext URL. Callers
    should discard ``url`` immediately after and keep only ``RtspParts``.
    """

    parsed = urlparse(url.strip())
    # P27: dropped ``http``/``https`` from the allowlist. Cameras
    # speak RTSP/RTSPS in every Maugood tenant we've seen; allowing
    # http(s) opened a real SSRF surface (an Admin could point the
    # preview-grab at ``http://169.254.169.254/...`` or any
    # internal HTTP service). Operators with an HTTP-MJPEG camera
    # bridge it through an RTSP proxy.
    if parsed.scheme not in ("rtsp", "rtsps"):
        raise ValueError("URL must be rtsp[s]://")
    if not parsed.hostname:
        raise ValueError("URL has no host")
    return RtspParts(host=rtsp_host(urlunparse(parsed)))


# --- Preview grab -----------------------------------------------------------


def _grab_frame_blocking(plain_url: str) -> bytes:
    """Blocking: open stream → read one frame → JPEG bytes. No caching.

    Imports OpenCV lazily so environments without the wheel (CI unit
    tests that monkeypatch this function) don't pay the import cost.
    """

    import cv2  # noqa: PLC0415 — see docstring

    cap = cv2.VideoCapture(plain_url)
    try:
        # OPEN_TIMEOUT is honoured by some backends (FFMPEG) and ignored
        # by others — the concurrent.futures wall clock below is the
        # actual guarantee. Setting it here is belt-and-braces.
        if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, int(PREVIEW_TIMEOUT_SECONDS * 1000))
        if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, int(PREVIEW_TIMEOUT_SECONDS * 1000))

        if not cap.isOpened():
            raise RuntimeError("could not open stream")
        ok, frame = cap.read()
        if not ok or frame is None:
            raise RuntimeError("could not read a frame from stream")
        ok, jpeg = cv2.imencode(".jpg", frame)
        if not ok:
            raise RuntimeError("could not JPEG-encode frame")
        return bytes(jpeg.tobytes())
    finally:
        # Always release so the stream closes immediately — we never
        # keep an open handle past the single grab.
        cap.release()


def grab_single_frame(plain_url: str, *, host_label: str) -> bytes:
    """Thread-guarded single-frame grab with a hard wall-clock timeout.

    ``host_label`` is the stripped host/port used for logging — we never
    log the plaintext URL, even in errors.
    """

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_grab_frame_blocking, plain_url)
        try:
            return future.result(timeout=PREVIEW_TIMEOUT_SECONDS)
        except concurrent.futures.TimeoutError as exc:
            logger.warning("preview timeout for host=%s", host_label)
            raise RuntimeError("preview timed out") from exc
        except Exception as exc:
            logger.warning("preview failed for host=%s: %s", host_label, type(exc).__name__)
            raise


# Exposed for tests — they monkeypatch this to return canned JPEG bytes
# without needing OpenCV or a real camera.
def _test_stub_grab(_plain_url: str, *, host_label: str) -> bytes:  # pragma: no cover
    raise RuntimeError("preview stub not configured")


_stubbed: Optional[callable] = None  # type: ignore[valid-type]


def set_preview_stub(fn) -> None:
    """Replace the grab implementation with a test stub (pytest only)."""

    global _stubbed
    _stubbed = fn


def clear_preview_stub() -> None:
    global _stubbed
    _stubbed = None


def dispatched_grab(plain_url: str, *, host_label: str) -> bytes:
    """Entrypoint used by the router — goes through the stub if set."""

    if _stubbed is not None:
        return _stubbed(plain_url, host_label=host_label)
    return grab_single_frame(plain_url, host_label=host_label)
