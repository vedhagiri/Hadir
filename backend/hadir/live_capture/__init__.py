"""Live Capture viewer (P28.5).

A read-only window onto the existing P8 capture pipeline. The
capture worker keeps producing detection events; this package adds
endpoints that fan out the latest frame (MJPEG) and the latest
detection (WebSocket JSON) to authorised viewers.

Public surface: ``router`` — mounted by ``hadir.main.create_app``.
"""

from hadir.live_capture.router import router

__all__ = ["router"]
