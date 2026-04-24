"""Cameras feature package (P7 + P8 wiring).

Owns the ``cameras`` table plus the RTSP encryption helpers and the
on-demand single-frame preview. The background capture pipeline (P8)
reuses ``rtsp.decrypt_url`` + ``rtsp.rtsp_host`` from this package.

Red line (PROJECT_CONTEXT §12 + pilot-plan): the plain RTSP URL must
appear **nowhere** outside a decrypt-to-use scope — not in logs,
responses, audit rows, or error messages. The host string returned by
``rtsp.rtsp_host`` is the only public representation.

Note: we don't re-export ``router`` here on purpose. ``main.py`` imports
``hadir.cameras.router`` directly so that importing ``hadir.cameras``
from the capture package (which the router depends on) doesn't create
a circular loop at package-init time.
"""
