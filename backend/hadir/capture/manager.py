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
        """Start workers for every enabled camera, across every tenant.

        Single-mode (pilot, ``HADIR_TENANT_MODE=single``): falls back
        to the configured default tenant id and reads from the
        legacy ``main`` schema. The SQLAlchemy ``checkout`` listener
        defaults to ``main`` when no contextvar is set in single
        mode, so a bare ``engine.begin()`` resolves correctly.

        Multi-mode (``HADIR_TENANT_MODE=multi``, P28): iterates
        ``public.tenants`` to discover every active tenant schema,
        then opens a per-tenant ``tenant_context(schema)`` to
        enumerate that tenant's cameras and spawn workers. Without
        this, the listener fails-closed and the FastAPI lifespan
        crashes during ``capture_manager.start()`` — the bug found
        on the P28 sign-off run.
        """

        with self._lock:
            if self._enabled:
                return
            self._enabled = True
            self._config = config

            settings = get_settings()
            engine = get_engine()
            tenants_to_scan: list[tuple[int, Optional[str]]]
            if settings.tenant_mode == "multi":
                from hadir.db import tenant_context, tenants  # noqa: PLC0415
                from sqlalchemy import select  # noqa: PLC0415

                with tenant_context("public"):
                    with engine.begin() as conn:
                        rows = conn.execute(
                            select(tenants.c.id, tenants.c.schema_name).where(
                                tenants.c.status == "active"
                            )
                        ).all()
                tenants_to_scan = [
                    (int(r.id), str(r.schema_name)) for r in rows
                ]
            else:
                tenants_to_scan = [(settings.default_tenant_id, None)]

            logger.info(
                "capture manager starting (mode=%s tenants=%d)",
                settings.tenant_mode,
                len(tenants_to_scan),
            )

            for tenant_id, schema in tenants_to_scan:
                scope = TenantScope(tenant_id=tenant_id)
                cams = self._list_cameras_for_tenant(
                    engine, scope, schema=schema
                )
                for cam in cams:
                    if cam.enabled:
                        # ``_spawn_locked`` already binds the
                        # camera+tenant via ``camera_repo.get_camera``
                        # inside its own per-tenant scope.
                        self._spawn_locked(cam.id, tenant_id=tenant_id, schema=schema)

            logger.info(
                "capture manager started with %d worker(s)", len(self._workers)
            )

    def _list_cameras_for_tenant(
        self,
        engine,
        scope: TenantScope,
        *,
        schema: Optional[str],
    ):
        """Read enabled cameras for one tenant, with the right
        per-schema search path applied when in multi-mode."""

        if schema is None:
            with engine.begin() as conn:
                return camera_repo.list_cameras(conn, scope)
        from hadir.db import tenant_context  # noqa: PLC0415

        with tenant_context(schema):
            with engine.begin() as conn:
                return camera_repo.list_cameras(conn, scope)

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

    def _spawn_locked(
        self,
        camera_id: int,
        *,
        tenant_id: Optional[int] = None,
        schema: Optional[str] = None,
    ) -> None:
        """Assumes the caller holds ``self._lock``.

        ``tenant_id`` + ``schema`` are P28 additions for multi-mode
        starts, where the caller has already enumerated tenants
        from ``public.tenants`` and knows which one this camera
        belongs to. Single-mode (and the legacy hot-reload paths
        in ``on_camera_*``) leave both at ``None`` so the call
        falls back to the default-tenant + listener-default-schema
        behaviour the pilot shipped.
        """

        if tenant_id is None:
            tenant_id = get_settings().default_tenant_id
        scope = TenantScope(tenant_id=tenant_id)
        engine = get_engine()

        if schema is not None:
            from hadir.db import tenant_context  # noqa: PLC0415

            with tenant_context(schema):
                with engine.begin() as conn:
                    cam = camera_repo.get_camera(conn, scope, camera_id)
        else:
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
