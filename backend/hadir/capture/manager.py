"""Capture supervisor.

Owns one ``CaptureWorker`` per enabled camera. Started by the FastAPI
lifespan on process boot, stopped on shutdown. The P7 cameras router
calls ``on_camera_created`` / ``on_camera_updated`` / ``on_camera_deleted``
to keep the running worker set in sync — no polling.

Pilot scope: single tenant (tenant_id=1). v1.0 iterates enabled cameras
per tenant; the API below is already ``TenantScope``-friendly so that
extension is additive.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from sqlalchemy.engine import Engine

from hadir.capture.analyzer import get_analyzer
from hadir.capture.reader import CaptureWorker, ReaderConfig
from hadir.cameras import repository as camera_repo
from hadir.cameras import rtsp as rtsp_io
from hadir.config import get_settings
from hadir.db import get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


class CaptureManager:
    """Process-wide supervisor. Thread-safe for CRUD callbacks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[int, CaptureWorker] = {}
        self._enabled = False
        self._config: Optional[ReaderConfig] = None

    # ------------------------------------------------------------------

    def start(self, *, config: Optional[ReaderConfig] = None) -> None:
        """Start workers for all enabled cameras in the pilot tenant."""

        with self._lock:
            if self._enabled:
                return
            self._enabled = True
            self._config = config
            tenant_id = get_settings().default_tenant_id
            scope = TenantScope(tenant_id=tenant_id)
            engine = get_engine()

            logger.info("capture manager starting (tenant_id=%s)", tenant_id)
            with engine.begin() as conn:
                cams = camera_repo.list_cameras(conn, scope)
            for cam in cams:
                if cam.enabled:
                    self._spawn_locked(cam.id)
            logger.info(
                "capture manager started with %d worker(s)", len(self._workers)
            )

    def stop(self) -> None:
        """Stop every worker. Blocks until all threads unwind (bounded)."""

        with self._lock:
            if not self._enabled:
                return
            self._enabled = False
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            try:
                worker.stop()
            except Exception:  # noqa: BLE001
                logger.warning(
                    "capture worker %s failed to stop cleanly", worker.camera_id
                )
        logger.info("capture manager stopped")

    # ------------------------------------------------------------------
    # CRUD hooks — called by the P7 router handlers.

    def on_camera_created(self, camera_id: int) -> None:
        self._reconcile(camera_id)

    def on_camera_updated(self, camera_id: int) -> None:
        # Easiest correct behaviour: stop the old worker (so any URL or
        # enabled change takes effect) and reconcile against the current
        # DB row.
        with self._lock:
            existing = self._workers.pop(camera_id, None)
        if existing is not None:
            existing.stop()
        self._reconcile(camera_id)

    def on_camera_deleted(self, camera_id: int) -> None:
        with self._lock:
            worker = self._workers.pop(camera_id, None)
        if worker is not None:
            worker.stop()

    # ------------------------------------------------------------------

    def active_camera_ids(self) -> list[int]:
        with self._lock:
            return [cid for cid, w in self._workers.items() if w.is_alive()]

    # ------------------------------------------------------------------

    def _reconcile(self, camera_id: int) -> None:
        """Bring the running worker set in sync with the DB row state."""

        with self._lock:
            if not self._enabled:
                return
            scope = TenantScope(tenant_id=get_settings().default_tenant_id)
            with get_engine().begin() as conn:
                cam = camera_repo.get_camera(conn, scope, camera_id)

            worker = self._workers.get(camera_id)

            if cam is None or not cam.enabled:
                if worker is not None:
                    self._workers.pop(camera_id, None)
                    # Stop outside the lock? Easier to just stop here —
                    # stop() itself joins with a timeout.
                    try:
                        worker.stop()
                    except Exception:  # noqa: BLE001
                        pass
                return

            # Camera exists and is enabled. If a worker is already
            # running, leave it alone (the caller was an update that
            # didn't rotate credentials or toggle enabled — or we
            # already stopped the old worker above before calling).
            if worker is not None and worker.is_alive():
                return

            self._spawn_locked(camera_id)

    def _spawn_locked(self, camera_id: int) -> None:
        """Assumes the caller holds ``self._lock``."""

        scope = TenantScope(tenant_id=get_settings().default_tenant_id)
        engine = get_engine()
        with engine.begin() as conn:
            cam = camera_repo.get_camera(conn, scope, camera_id)
        if cam is None or not cam.enabled:
            return

        try:
            plain_url = rtsp_io.decrypt_url(cam.rtsp_url_encrypted)
        except RuntimeError:
            logger.warning(
                "capture manager: could not decrypt URL for camera %s (%s)",
                cam.id,
                cam.rtsp_host,
            )
            return

        try:
            worker = CaptureWorker(
                engine=engine,
                scope=scope,
                camera_id=cam.id,
                camera_name=cam.name,
                rtsp_url_plain=plain_url,
                analyzer=get_analyzer(),
                config=self._config,
            )
        finally:
            # Don't keep the decrypted URL around in this scope longer
            # than needed — the worker holds its own reference.
            plain_url = ""  # noqa: F841
            del plain_url

        worker.start()
        self._workers[cam.id] = worker
        logger.info(
            "capture worker started for camera id=%s name=%r host=%s",
            cam.id,
            cam.name,
            cam.rtsp_host,
        )


# Process-wide singleton. The FastAPI lifespan calls ``start``/``stop``;
# the P7 router calls the ``on_*`` hooks.
capture_manager = CaptureManager()
