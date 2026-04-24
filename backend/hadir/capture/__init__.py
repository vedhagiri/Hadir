"""Capture pipeline (P8).

Per-camera background workers that read RTSP frames at a throttled rate,
run face detection, assign IoU-based track ids, and emit one
``detection_events`` row per track entry (not per frame). Face crops are
Fernet-encrypted on disk under ``/data/faces/captures/``.

Public surface: ``capture_manager`` — a process-wide singleton used by
the FastAPI lifespan to start/stop workers and by the P7 cameras router
to hot-reload workers on CRUD events. Internal modules are imported
directly by the manager and shouldn't be touched from handlers.
"""

from hadir.capture.manager import capture_manager

__all__ = ["capture_manager"]
