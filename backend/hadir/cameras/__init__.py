"""Cameras feature package (P7).

Owns the ``cameras`` table plus the RTSP encryption helpers and the
on-demand single-frame preview. The background capture pipeline (P8)
reuses ``rtsp.decrypt_url`` + ``rtsp.rtsp_host`` from this module.

Red line (PROJECT_CONTEXT §12 + pilot-plan): the plain RTSP URL must
appear **nowhere** outside a decrypt-to-use scope — not in logs,
responses, audit rows, or error messages. The host string returned by
``rtsp.rtsp_host`` is the only public representation.
"""

from hadir.cameras.router import router

__all__ = ["router"]
