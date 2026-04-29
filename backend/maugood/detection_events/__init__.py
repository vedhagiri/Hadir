"""Read-only access to ``detection_events`` (P11 Camera Logs).

Pilot exposes one list endpoint and one auth-gated crop-fetch endpoint
to power the Admin "Camera Logs" page. The ingestion path stays in
``maugood.capture.events`` — this module never inserts.
"""

from maugood.detection_events.router import router

__all__ = ["router"]
