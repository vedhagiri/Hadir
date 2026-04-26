"""Capture supervisor (P28.5a — multi-tenant + boot-time auto-start).

Owns one ``CaptureWorker`` per enabled camera *per tenant*. Started by
the FastAPI lifespan on process boot, stopped on shutdown. The P7
cameras router calls ``on_camera_created`` / ``on_camera_updated`` /
``on_camera_deleted`` to keep the running worker set in sync — no
polling.

**Boot-time auto-start** (P28.5a fix): on ``start()`` the manager
**always** iterates ``public.tenants`` (independent of
``HADIR_TENANT_MODE`` — the mode flag governs runtime tenant
*routing*, not worker *discovery*). For each ``status='active'``
tenant we open a ``tenant_context(schema)`` and SELECT every
``cameras WHERE enabled=true``, decrypt the RTSP URL with Fernet,
and spin up a worker for it. A single decrypt failure or RTSP error
on one camera **does not** prevent other cameras from starting —
each spawn is wrapped in a try/except and an audit row records the
failure under ``capture.worker.start_failed``. Successful starts
audit as ``capture.worker.started_at_boot``. The final log line
states the actual worker count.

Multi-tenant keying: the ``_workers`` dict is keyed by
``(tenant_id, camera_id)``. Two tenants both happening to mint a
camera with id=7 (yes, they can — ids are per-schema sequences) get
two distinct workers. Cross-tenant ``get_preview`` returns ``None``
regardless of how the camera_id guess lines up — defence in depth on
top of the router's ``WHERE tenant_id = …`` filter.

Per-worker preview JPEG (P28.5a): the live-capture MJPEG endpoint
asks this manager for the latest annotated frame via
``get_preview(tenant_id, camera_id)``; the manager looks up the
worker and forwards to ``CaptureWorker.get_latest_jpeg``. There is
no process-global frame buffer — each worker holds its own slot.
When a worker is stopped the slot drops with it, so a stale frame
can never outlive the worker that produced it.

Public surface:

* ``start(*, config=None)`` — boot-time auto-start over every active
  tenant. Idempotent (second call is a no-op).
* ``stop()`` — stop every worker.
* ``start_camera(tenant_id, camera_id, name, decrypted_url)`` —
  explicit start used by the boot loop and CRUD-side reactions.
  Returns True on success, False on failure.
* ``stop_camera(tenant_id, camera_id)`` — explicit stop. No-op if no
  worker is running.
* ``on_camera_created`` / ``on_camera_updated`` / ``on_camera_deleted``
  — synchronous reactions to the cameras CRUD endpoints (re-fetches
  the current row + reconciles).
* ``get_preview`` / ``is_preview_fresh`` / ``get_worker_stats`` —
  consumed by the live-capture router.

The full reconciliation loop (every-2-second poll that handles
out-of-band camera-row mutations) is scoped for P28.5b.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from sqlalchemy import select
from sqlalchemy.engine import Engine

from hadir.auth.audit import write_audit
from hadir.capture.analyzer import get_analyzer
from hadir.capture.reader import CaptureWorker, ReaderConfig
from hadir.cameras import repository as camera_repo
from hadir.cameras import rtsp as rtsp_io
from hadir.config import get_settings
from hadir.db import cameras as cameras_table
from hadir.db import get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


WorkerKey = tuple[int, int]  # (tenant_id, camera_id)


class CaptureManager:
    """Process-wide supervisor. Thread-safe for CRUD callbacks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[WorkerKey, CaptureWorker] = {}
        self._enabled = False
        self._config: Optional[ReaderConfig] = None

    # ------------------------------------------------------------------
    # Lifecycle

    def start(self, *, config: Optional[ReaderConfig] = None) -> None:
        """Boot-time auto-start: iterate every active tenant, spawn one
        worker per enabled camera. Continues past per-camera failures.

        Idempotent: second call is a no-op (the singleton's state guards
        against re-entry from a second FastAPI lifespan, e.g. tests).
        """

        with self._lock:
            if self._enabled:
                return
            self._enabled = True
            self._config = config

        # Discover tenants OUTSIDE the lock — DB calls can be slow and
        # we don't need the lock until we mutate ``_workers``.
        tenants_to_scan = self._discover_tenants()
        logger.info(
            "capture manager: scanning %d active tenant(s) for enabled cameras",
            len(tenants_to_scan),
        )

        spawn_count = 0
        for tenant_id, schema in tenants_to_scan:
            spawn_count += self._auto_start_for_tenant(
                tenant_id=tenant_id, schema=schema
            )

        logger.info("capture manager started with %d worker(s)", spawn_count)

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
    # Explicit per-camera control (used by the boot loop + CRUD hooks)

    def start_camera(
        self,
        *,
        tenant_id: int,
        camera_id: int,
        name: str,
        decrypted_url: str,
        schema: Optional[str] = None,
    ) -> bool:
        """Start a worker for ``(tenant_id, camera_id)`` with the given
        decrypted URL. Returns True if a worker is now running for that
        key, False on failure. Failures audit-log as
        ``capture.worker.start_failed`` with the failure reason.

        Idempotent: if a live worker already exists for the key,
        returns True without restarting.
        """

        with self._lock:
            if not self._enabled:
                # Refuse to spawn while the manager is in the stopped
                # state. The CRUD path goes via ``on_camera_*`` which
                # does its own ``_enabled`` check, so this guards the
                # explicit-start path against the same race.
                return False
            existing = self._workers.get((tenant_id, camera_id))
            if existing is not None and existing.is_alive():
                return True

        scope = TenantScope(tenant_id=tenant_id, tenant_schema=schema)
        try:
            worker = CaptureWorker(
                engine=get_engine(),
                scope=scope,
                camera_id=camera_id,
                camera_name=name,
                rtsp_url_plain=decrypted_url,
                analyzer=get_analyzer(),
                config=self._config,
            )
            worker.start()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture worker spawn failed: tenant=%s camera_id=%s name=%r reason=%s",
                tenant_id,
                camera_id,
                name,
                type(exc).__name__,
            )
            self._audit_worker_event(
                tenant_id=tenant_id,
                schema=schema,
                action="capture.worker.start_failed",
                entity_id=str(camera_id),
                payload={"name": name, "reason": type(exc).__name__},
            )
            return False
        finally:
            # Don't keep the decrypted URL on this stack frame longer
            # than needed — the worker holds its own reference.
            decrypted_url = ""  # noqa: F841
            del decrypted_url

        with self._lock:
            self._workers[(tenant_id, camera_id)] = worker

        logger.info(
            "capture worker started: tenant=%s camera_id=%s name=%r",
            tenant_id,
            camera_id,
            name,
        )
        return True

    def stop_camera(self, *, tenant_id: int, camera_id: int) -> bool:
        """Stop the worker for ``(tenant_id, camera_id)``. Returns True
        if a worker was running and is now stopped, False if no worker
        was running for that key.
        """

        with self._lock:
            worker = self._workers.pop((tenant_id, camera_id), None)
        if worker is None:
            return False
        try:
            worker.stop()
        except Exception:  # noqa: BLE001
            logger.warning(
                "capture worker stop_camera: stop failed for tenant=%s camera_id=%s",
                tenant_id,
                camera_id,
            )
        logger.info(
            "capture worker stopped: tenant=%s camera_id=%s",
            tenant_id,
            camera_id,
        )
        return True

    # ------------------------------------------------------------------
    # CRUD hooks — called by the P7 router handlers (synchronous).

    def on_camera_created(
        self, camera_id: int, *, tenant_id: Optional[int] = None
    ) -> None:
        self._reconcile(camera_id=camera_id, tenant_id=tenant_id)

    def on_camera_updated(
        self, camera_id: int, *, tenant_id: Optional[int] = None
    ) -> None:
        # Easiest correct behaviour: stop the old worker (so any URL or
        # enabled change takes effect) and reconcile against the current
        # DB row.
        if tenant_id is None:
            tenant_id = get_settings().default_tenant_id
        self.stop_camera(tenant_id=tenant_id, camera_id=camera_id)
        self._reconcile(camera_id=camera_id, tenant_id=tenant_id)

    def on_camera_deleted(
        self, camera_id: int, *, tenant_id: Optional[int] = None
    ) -> None:
        if tenant_id is None:
            tenant_id = get_settings().default_tenant_id
        self.stop_camera(tenant_id=tenant_id, camera_id=camera_id)

    # ------------------------------------------------------------------
    # Public reads

    def get_preview(
        self, tenant_id: int, camera_id: int
    ) -> Optional[tuple[bytes, float]]:
        """Return ``(jpeg, ts)`` for the worker, or ``None``.

        The (tenant_id, camera_id) tuple must match a running worker
        exactly. A camera_id that exists in another tenant returns
        None — the live-capture router relies on that as a defence-
        in-depth check on top of its ``WHERE tenant_id = …`` filter.
        """

        with self._lock:
            worker = self._workers.get((tenant_id, camera_id))
        if worker is None:
            return None
        return worker.get_latest_jpeg()

    def is_preview_fresh(
        self, tenant_id: int, camera_id: int, *, max_age_s: float = 5.0
    ) -> bool:
        with self._lock:
            worker = self._workers.get((tenant_id, camera_id))
        if worker is None:
            return False
        return worker.is_preview_fresh(max_age_s=max_age_s)

    def get_worker_stats(
        self, tenant_id: int, camera_id: int
    ) -> Optional[dict]:
        with self._lock:
            worker = self._workers.get((tenant_id, camera_id))
        if worker is None:
            return None
        return worker.get_stats()

    def active_camera_ids(
        self, *, tenant_id: Optional[int] = None
    ) -> list[int]:
        """Return camera ids for the live workers, optionally tenant-scoped.

        Test compat: callers from the existing test_capture.py pass no
        tenant_id and expect "the running cameras". When the caller
        scopes by tenant_id, only that tenant's running workers count.
        """

        with self._lock:
            keys = list(self._workers.keys())
            alive = {key for key in keys if self._workers[key].is_alive()}
        if tenant_id is None:
            return [cid for (_t, cid) in alive]
        return [cid for (t, cid) in alive if t == tenant_id]

    def workers_snapshot(self) -> list[WorkerKey]:
        """Return every running worker's (tenant_id, camera_id). Used by
        tests for explicit assertions on the worker set; production
        code should prefer the read accessors above."""

        with self._lock:
            return [
                key for key, w in self._workers.items() if w.is_alive()
            ]

    # ------------------------------------------------------------------
    # Internal helpers

    def _discover_tenants(self) -> list[tuple[int, Optional[str]]]:
        """Return ``[(tenant_id, schema_name), …]`` for every active
        tenant. Always reads ``public.tenants`` regardless of
        ``HADIR_TENANT_MODE`` — the mode flag governs runtime tenant
        routing for HTTP requests, not worker discovery at boot.

        On the rare clean-slate fresh boot where ``public.tenants``
        doesn't exist yet (e.g. between the schema-creating migration
        and the seed step), the manager falls back to the configured
        default tenant against the legacy ``main`` schema so existing
        single-tenant pilot deployments keep working.
        """

        engine = get_engine()
        try:
            from hadir.db import tenant_context  # noqa: PLC0415
            from hadir.db import tenants as tenants_table  # noqa: PLC0415

            with tenant_context("public"):
                with engine.begin() as conn:
                    rows = conn.execute(
                        select(
                            tenants_table.c.id, tenants_table.c.schema_name
                        ).where(tenants_table.c.status == "active")
                    ).all()
            tenants_to_scan = [
                (int(r.id), str(r.schema_name)) for r in rows
            ]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture manager: tenants discovery failed (%s) — "
                "falling back to default tenant",
                type(exc).__name__,
            )
            tenants_to_scan = []

        if not tenants_to_scan:
            settings = get_settings()
            tenants_to_scan = [(settings.default_tenant_id, None)]

        return tenants_to_scan

    def _auto_start_for_tenant(
        self, *, tenant_id: int, schema: Optional[str]
    ) -> int:
        """Spawn workers for every enabled camera in this tenant.
        Returns the number of workers actually started.

        Per-camera errors (decrypt failure, worker spawn exception) are
        caught and audited as ``capture.worker.start_failed``; the next
        camera in the loop continues regardless. A single bad camera
        must not block all others.

        Uses a raw SELECT (id, name, rtsp_url_encrypted) rather than
        the repository's ``list_cameras`` because the repo decrypts
        every row to surface ``rtsp_host`` in the response shape — a
        single corrupt ciphertext would fail the entire listing.
        Per-row decrypt happens here, with try/except catching the
        bad row.
        """

        engine = get_engine()

        try:
            rows = self._select_enabled_cameras(
                engine, tenant_id=tenant_id, schema=schema
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture manager: camera listing failed for tenant=%s schema=%s (%s)",
                tenant_id,
                schema,
                type(exc).__name__,
            )
            return 0

        spawned = 0
        for row in rows:
            cam_id = int(row.id)
            cam_name = str(row.name)
            try:
                plain_url = rtsp_io.decrypt_url(str(row.rtsp_url_encrypted))
            except (RuntimeError, ValueError, Exception) as exc:  # noqa: BLE001
                logger.warning(
                    "capture manager: could not decrypt URL for "
                    "tenant=%s camera_id=%s name=%r: %s",
                    tenant_id,
                    cam_id,
                    cam_name,
                    type(exc).__name__,
                )
                self._audit_worker_event(
                    tenant_id=tenant_id,
                    schema=schema,
                    action="capture.worker.start_failed",
                    entity_id=str(cam_id),
                    payload={
                        "name": cam_name,
                        "reason": "decrypt_failed",
                    },
                )
                continue

            ok = self.start_camera(
                tenant_id=tenant_id,
                camera_id=cam_id,
                name=cam_name,
                decrypted_url=plain_url,
                schema=schema,
            )
            plain_url = ""  # noqa: F841
            del plain_url

            if ok:
                spawned += 1
                # rtsp_host is derived from the decrypted URL; we can't
                # safely re-derive it after deleting plain_url, so the
                # boot audit just records (name) — the host shows up on
                # the camera.created audit row anyway.
                self._audit_worker_event(
                    tenant_id=tenant_id,
                    schema=schema,
                    action="capture.worker.started_at_boot",
                    entity_id=str(cam_id),
                    payload={"name": cam_name},
                )

        return spawned

    def _select_enabled_cameras(
        self,
        engine,
        *,
        tenant_id: int,
        schema: Optional[str],
    ):
        """Raw SELECT for enabled cameras under a tenant. Bypasses the
        repository's full row hydration (which decrypts every row's
        URL to surface ``rtsp_host``) so a single bad ciphertext can't
        fail the listing for the whole tenant.
        """

        stmt = select(
            cameras_table.c.id,
            cameras_table.c.name,
            cameras_table.c.rtsp_url_encrypted,
        ).where(
            cameras_table.c.tenant_id == tenant_id,
            cameras_table.c.enabled.is_(True),
        )

        if schema is None:
            with engine.begin() as conn:
                return list(conn.execute(stmt).all())

        from hadir.db import tenant_context  # noqa: PLC0415

        with tenant_context(schema):
            with engine.begin() as conn:
                return list(conn.execute(stmt).all())

    def _list_cameras_for_tenant(
        self,
        engine,
        scope: TenantScope,
        *,
        schema: Optional[str],
    ):
        """Read enabled cameras for one tenant, with the right per-schema
        search path applied when in multi-mode."""

        if schema is None:
            with engine.begin() as conn:
                return camera_repo.list_cameras(conn, scope)
        from hadir.db import tenant_context  # noqa: PLC0415

        with tenant_context(schema):
            with engine.begin() as conn:
                return camera_repo.list_cameras(conn, scope)

    def _audit_worker_event(
        self,
        *,
        tenant_id: int,
        schema: Optional[str],
        action: str,
        entity_id: str,
        payload: dict,
    ) -> None:
        """Write one audit row from the manager (system actor: no user).

        Boot-time and decrypt-failure events both go through here.
        Failures inside the audit write itself are swallowed at WARN —
        we'd rather start workers than crash the manager because the
        audit_log is unavailable.
        """

        engine = get_engine()
        try:
            if schema is None:
                with engine.begin() as conn:
                    write_audit(
                        conn,
                        tenant_id=tenant_id,
                        actor_user_id=None,
                        action=action,
                        entity_type="camera",
                        entity_id=entity_id,
                        after=payload,
                    )
                return
            from hadir.db import tenant_context  # noqa: PLC0415

            with tenant_context(schema):
                with engine.begin() as conn:
                    write_audit(
                        conn,
                        tenant_id=tenant_id,
                        actor_user_id=None,
                        action=action,
                        entity_type="camera",
                        entity_id=entity_id,
                        after=payload,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture manager: audit write failed for tenant=%s "
                "camera_id=%s action=%s reason=%s",
                tenant_id,
                entity_id,
                action,
                type(exc).__name__,
            )

    def _reconcile(
        self, *, camera_id: int, tenant_id: Optional[int]
    ) -> None:
        """Re-fetch the camera row and bring the worker set in sync.

        Used by the CRUD hooks. If the row is gone or disabled, ensure
        no worker is running. If it's enabled, ensure a worker IS
        running (decrypting the URL on demand).
        """

        with self._lock:
            if not self._enabled:
                return

        if tenant_id is None:
            tenant_id = get_settings().default_tenant_id

        # Find the tenant's schema so we can look up the camera under
        # the right search_path. In single-mode we expect schema=None
        # (listener defaults to ``main``); in multi-mode we look it up.
        schema = self._schema_for_tenant(tenant_id)

        scope = TenantScope(tenant_id=tenant_id, tenant_schema=schema)
        engine = get_engine()
        try:
            if schema is not None:
                from hadir.db import tenant_context  # noqa: PLC0415

                with tenant_context(schema):
                    with engine.begin() as conn:
                        cam = camera_repo.get_camera(conn, scope, camera_id)
            else:
                with engine.begin() as conn:
                    cam = camera_repo.get_camera(conn, scope, camera_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture manager reconcile: camera fetch failed "
                "tenant=%s camera_id=%s reason=%s",
                tenant_id,
                camera_id,
                type(exc).__name__,
            )
            return

        if cam is None or not cam.enabled:
            self.stop_camera(tenant_id=tenant_id, camera_id=camera_id)
            return

        try:
            plain_url = rtsp_io.decrypt_url(cam.rtsp_url_encrypted)
        except RuntimeError:
            logger.warning(
                "capture manager reconcile: could not decrypt URL for "
                "tenant=%s camera_id=%s host=%s",
                tenant_id,
                camera_id,
                cam.rtsp_host,
            )
            return

        self.start_camera(
            tenant_id=tenant_id,
            camera_id=cam.id,
            name=cam.name,
            decrypted_url=plain_url,
            schema=schema,
        )
        plain_url = ""  # noqa: F841
        del plain_url

    def _schema_for_tenant(self, tenant_id: int) -> Optional[str]:
        """Resolve a tenant's schema name from ``public.tenants``.

        Single-mode pilot uses ``main`` for tenant_id=1; we still look
        it up here rather than hardcoding so any non-default tenant in
        a single-mode dev DB still works. Returns None on any lookup
        failure — callers fall back to listener defaults.
        """

        try:
            from hadir.db import tenant_context, tenants as tenants_table  # noqa: PLC0415

            with tenant_context("public"):
                with get_engine().begin() as conn:
                    row = conn.execute(
                        select(tenants_table.c.schema_name).where(
                            tenants_table.c.id == tenant_id
                        )
                    ).first()
            if row is None:
                return None
            return str(row[0])
        except Exception:  # noqa: BLE001
            return None


# Process-wide singleton. The FastAPI lifespan calls ``start``/``stop``;
# the P7 router calls the ``on_*`` hooks.
capture_manager = CaptureManager()
