"""Capture supervisor (P28.5b — reconcile loop + worker/display split).

Owns one ``CaptureWorker`` per ``worker_enabled`` camera *per tenant*.
Started by the FastAPI lifespan on process boot, stopped on shutdown.
The P7 cameras router calls ``on_camera_created`` /
``on_camera_updated`` / ``on_camera_deleted`` for synchronous reactions
(visible to the operator on the next API response). On top of that,
P28.5b adds a 2-second **reconciliation tick** that catches drift —
out-of-band camera-row mutations (psql, scripts, future replication
follower writes), worker crashes, capture_config changes that should
hot-reload without restart.

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
  tenant + start the reconcile scheduler. Idempotent.
* ``stop()`` — stop every worker + the scheduler.
* ``start_camera(..., capture_config=None)`` — explicit start used by
  the boot loop and CRUD-side reactions. Returns True on success.
* ``stop_camera(tenant_id, camera_id)`` — explicit stop.
* ``reconcile_all()`` — one pass of the full diff: discover desired
  worker set from DB, compare to running set, start/stop/update_config
  to converge. Called every 2 s by the scheduler; safe to call
  ad-hoc from tests for deterministic timing.
* ``on_camera_*`` — synchronous CRUD reactions (defer to reconcile_all
  shape for the heavy lift).
* ``get_preview`` / ``is_preview_fresh`` / ``get_worker_stats`` —
  consumed by the live-capture router.

P28.5b knobs:

* ``worker_enabled`` controls whether the worker runs at all (CPU + DB).
* ``display_enabled`` is read by the live-capture router; the manager
  doesn't care — workers run regardless of display, so an operator
  can hide the feed without losing recordings.
* ``capture_config`` (JSONB) carries per-camera face-save knobs;
  changes propagate via ``CaptureWorker.update_config`` without a
  worker restart so a tweak doesn't drop frames.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from apscheduler.schedulers.background import BackgroundScheduler
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


# How often the reconcile tick fires. Two seconds is the prompt's
# "visible to operator within 5 seconds" requirement minus a safety
# margin for the work the tick itself does (DB scan + per-row
# decrypt + diff). On a typical office stack with single-digit
# camera counts the tick takes <50 ms.
RECONCILE_INTERVAL_SECONDS = 2

logger = logging.getLogger(__name__)


WorkerKey = tuple[int, int]  # (tenant_id, camera_id)


class CaptureManager:
    """Process-wide supervisor. Thread-safe for CRUD callbacks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[WorkerKey, CaptureWorker] = {}
        self._enabled = False
        self._config: Optional[ReaderConfig] = None
        # P28.5b: 2-second reconcile loop catches drift the synchronous
        # CRUD hooks can't (out-of-band row mutations, worker crashes,
        # config-only changes). Lazy — only created in start().
        self._reconcile_scheduler: Optional[BackgroundScheduler] = None

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

        # P28.5b: start the periodic reconcile tick. The scheduler is
        # daemon-threaded so a SIGTERM unwinds cleanly. ``coalesce=True``
        # collapses missed ticks (e.g. the reconcile pass took longer
        # than the interval) into a single follow-up call instead of
        # backing up.
        self._start_reconcile_scheduler()

    def stop(self) -> None:
        """Stop every worker + the reconcile scheduler. Blocks until
        all threads unwind (bounded)."""

        with self._lock:
            if not self._enabled:
                return
            self._enabled = False
            workers = list(self._workers.values())
            self._workers.clear()
            scheduler = self._reconcile_scheduler
            self._reconcile_scheduler = None

        # Stop the scheduler first so a tick mid-shutdown can't re-add
        # workers we're about to drop.
        if scheduler is not None:
            try:
                scheduler.shutdown(wait=False)
            except Exception:  # noqa: BLE001
                logger.warning("capture manager: scheduler shutdown failed")
        for worker in workers:
            try:
                worker.stop()
            except Exception:  # noqa: BLE001
                logger.warning(
                    "capture worker %s failed to stop cleanly", worker.camera_id
                )
        logger.info("capture manager stopped")

    def _start_reconcile_scheduler(self) -> None:
        """Spin up the BackgroundScheduler that drives ``reconcile_all``.

        ``coalesce=True`` + ``max_instances=1`` keep tick calls from
        stacking up if a slow tick overruns the interval — the next
        tick just runs once when the previous returns.
        """

        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(
            self._reconcile_tick,
            "interval",
            seconds=RECONCILE_INTERVAL_SECONDS,
            id="capture-manager-reconcile",
            coalesce=True,
            max_instances=1,
            replace_existing=True,
        )
        scheduler.start()
        with self._lock:
            self._reconcile_scheduler = scheduler
        logger.info(
            "capture manager: reconcile scheduler started "
            "(interval=%ds)",
            RECONCILE_INTERVAL_SECONDS,
        )

    def _reconcile_tick(self) -> None:
        """APScheduler-side wrapper around ``reconcile_all`` that swallows
        exceptions — a single bad tick must not poison the scheduler."""

        try:
            self.reconcile_all()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "capture manager reconcile tick failed: %s",
                type(exc).__name__,
            )

    # ------------------------------------------------------------------
    # Explicit per-camera control (used by the boot loop + CRUD hooks)

    def start_camera(
        self,
        *,
        tenant_id: int,
        camera_id: int,
        name: str,
        decrypted_url: str,
        capture_config: Optional[dict[str, Any]] = None,
        tracker_config: Optional[dict[str, Any]] = None,
        detection_config: Optional[dict[str, Any]] = None,
        schema: Optional[str] = None,
    ) -> bool:
        """Start a worker for ``(tenant_id, camera_id)`` with the given
        decrypted URL. Returns True if a worker is now running for that
        key, False on failure. Failures audit-log as
        ``capture.worker.start_failed`` with the failure reason.

        ``capture_config`` (P28.5b) is the per-camera face-save knob bag.
        ``tracker_config`` + ``detection_config`` (P28.5c) are the
        tenant-level config blobs from ``tenant_settings``. When any
        is ``None`` the worker falls back to its built-in defaults.

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
                capture_config=capture_config,
                tracker_config=tracker_config,
                detection_config=detection_config,
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

    # ------------------------------------------------------------------
    # P28.8 — operations endpoints helpers

    def get_full_worker_stats(
        self, tenant_id: int, camera_id: int
    ) -> Optional[dict]:
        """Full operations payload (4-stage pipeline + counters +
        metadata). Returns None when the worker isn't running for the
        key — operations router uses that to fall back to the camera
        row's last-known metadata + a synthetic ``stopped`` payload."""

        with self._lock:
            worker = self._workers.get((tenant_id, camera_id))
        if worker is None:
            return None
        return worker.get_full_stats()

    def get_worker(
        self, tenant_id: int, camera_id: int
    ) -> Optional["CaptureWorker"]:
        """Direct access to a running worker. Used by the operations
        router for the View Errors drawer (recent_errors deque)."""

        with self._lock:
            return self._workers.get((tenant_id, camera_id))

    def workers_for_tenant(self, tenant_id: int) -> list[tuple[int, "CaptureWorker"]]:
        """Snapshot of every (camera_id, worker) running for a tenant.
        Order: stable by camera_id ascending so the operations page
        UI stays visually stable across polls.
        """

        with self._lock:
            items = [
                (cid, w)
                for (t, cid), w in self._workers.items()
                if t == tenant_id and w.is_alive()
            ]
        items.sort(key=lambda pair: pair[0])
        return items

    def restart_camera(
        self, *, tenant_id: int, camera_id: int
    ) -> bool:
        """Stop + restart one worker. Returns True if the camera now has
        a running worker (idempotent: starts even if no worker was
        running before, as long as the camera row says
        worker_enabled=true).

        Re-reads the camera row inside the same call — picks up any
        URL or capture-config change without a separate
        ``on_camera_updated`` step. The fresh metadata-detection cycle
        runs naturally on the new worker's first frame.
        """

        # Re-read the row to pick up any DB-side changes (URL rotation,
        # capture_config update). The worker spawn pulls the row's
        # decrypted URL via the same path as boot-time auto-start.
        engine = get_engine()
        try:
            from hadir.db import tenant_context  # noqa: PLC0415
            from hadir.db import tenants as tenants_table  # noqa: PLC0415

            with tenant_context("public"):
                with engine.begin() as conn:
                    row = conn.execute(
                        select(
                            tenants_table.c.schema_name,
                            tenants_table.c.status,
                        ).where(tenants_table.c.id == tenant_id)
                    ).first()
            if row is None or row.status != "active":
                logger.warning(
                    "restart_camera: tenant %s not active — refusing", tenant_id
                )
                return False
            schema = str(row.schema_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "restart_camera: tenant lookup failed: %s", type(exc).__name__
            )
            return False

        with tenant_context(schema):
            try:
                with engine.begin() as conn:
                    cam_row = conn.execute(
                        select(
                            cameras_table.c.id,
                            cameras_table.c.name,
                            cameras_table.c.rtsp_url_encrypted,
                            cameras_table.c.worker_enabled,
                            cameras_table.c.capture_config,
                        ).where(
                            cameras_table.c.tenant_id == tenant_id,
                            cameras_table.c.id == camera_id,
                        )
                    ).first()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "restart_camera: camera lookup failed: %s",
                    type(exc).__name__,
                )
                return False

        if cam_row is None:
            return False

        # Stop first regardless of whether worker_enabled. The next
        # branch decides whether to start back up.
        self.stop_camera(tenant_id=tenant_id, camera_id=camera_id)

        if not bool(cam_row.worker_enabled):
            # The operator can restart a disabled camera explicitly via
            # the UI; we honour the persisted flag (don't auto-spawn).
            return False

        try:
            decrypted = rtsp_io.decrypt_url(cam_row.rtsp_url_encrypted)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "restart_camera: decrypt failed: %s", type(exc).__name__
            )
            return False

        # Reuse the existing tenant_settings detection / tracker
        # config so a restart doesn't drop the tenant's choices.
        tracker_cfg, detection_cfg = self._read_tenant_configs(
            tenant_id=tenant_id, schema=schema
        )

        return self.start_camera(
            tenant_id=tenant_id,
            camera_id=camera_id,
            name=str(cam_row.name),
            decrypted_url=decrypted,
            capture_config=cam_row.capture_config,
            tracker_config=tracker_cfg,
            detection_config=detection_cfg,
            schema=schema,
        )

    def restart_all_for_tenant(self, tenant_id: int) -> dict:
        """Sequential restart of every worker in a tenant. Returns
        ``{restarted: N, failed: M, total: N+M}``.

        Sequential by design — keeps detector lock contention sane on
        a busy box. The reconcile loop (P28.5b) will pick up any
        worker that fails this restart on the next 2 s tick anyway,
        so a single failure here doesn't strand an enabled camera.
        """

        with self._lock:
            keys = [
                (t, cid) for (t, cid) in self._workers.keys() if t == tenant_id
            ]

        # Also include cameras that have ``worker_enabled=true`` but
        # don't currently have a running worker — restart-all means
        # "make every enabled camera fresh", not just "kick the ones
        # that are running". This catches the case where one worker
        # crashed half a minute ago + the operator hits Restart all.
        try:
            from hadir.db import tenant_context  # noqa: PLC0415
            from hadir.db import tenants as tenants_table  # noqa: PLC0415

            with tenant_context("public"):
                with get_engine().begin() as conn:
                    schema_row = conn.execute(
                        select(tenants_table.c.schema_name).where(
                            tenants_table.c.id == tenant_id
                        )
                    ).first()
            schema = str(schema_row.schema_name) if schema_row else None
            if schema is not None:
                with tenant_context(schema):
                    with get_engine().begin() as conn:
                        enabled_rows = conn.execute(
                            select(cameras_table.c.id).where(
                                cameras_table.c.tenant_id == tenant_id,
                                cameras_table.c.worker_enabled.is_(True),
                            )
                        ).all()
                seen = {cid for (_t, cid) in keys}
                for r in enabled_rows:
                    if int(r.id) not in seen:
                        keys.append((tenant_id, int(r.id)))
        except Exception:  # noqa: BLE001
            pass

        restarted = 0
        failed = 0
        for tid, cid in keys:
            try:
                ok = self.restart_camera(tenant_id=tid, camera_id=cid)
                if ok:
                    restarted += 1
                else:
                    failed += 1
            except Exception:  # noqa: BLE001
                failed += 1

        return {
            "restarted": restarted,
            "failed": failed,
            "total": restarted + failed,
        }

    def get_subscriber_counts(self) -> dict[str, int]:
        """Live-capture subscriber counts for the Super-Admin page.

        Uses the existing ``hadir.capture.event_bus`` + the live-capture
        router's MJPEG viewer registry. Defensive — returns zeros if
        either module isn't available.
        """

        mjpeg = 0
        ws = 0
        try:
            from hadir.live_capture import router as lc_router  # noqa: PLC0415

            counter = getattr(lc_router, "active_mjpeg_count", None)
            if callable(counter):
                mjpeg = int(counter())
        except Exception:  # noqa: BLE001
            pass
        try:
            from hadir.capture.event_bus import event_bus  # noqa: PLC0415

            counter = getattr(event_bus, "subscriber_count", None)
            if callable(counter):
                ws = int(counter())
        except Exception:  # noqa: BLE001
            pass
        return {"mjpeg": mjpeg, "ws": ws}

    def _read_tenant_configs(
        self, *, tenant_id: int, schema: str
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Read the tenant's ``tracker_config`` + ``detection_config`` for
        a fresh worker spawn. Returns ``(None, None)`` on failure so the
        worker uses its built-in defaults."""

        try:
            from hadir.db import tenant_context  # noqa: PLC0415
            from hadir.db import tenant_settings as ts_table  # noqa: PLC0415

            with tenant_context(schema):
                with get_engine().begin() as conn:
                    row = conn.execute(
                        select(
                            ts_table.c.tracker_config,
                            ts_table.c.detection_config,
                        ).where(ts_table.c.tenant_id == tenant_id)
                    ).first()
            if row is None:
                return None, None
            return (
                dict(row.tracker_config) if row.tracker_config else None,
                dict(row.detection_config) if row.detection_config else None,
            )
        except Exception:  # noqa: BLE001
            return None, None

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
            rows = self._select_active_cameras(
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

        # P28.5c: tenant-level detection + tracker settings shared
        # across this tenant's workers.
        detection_config, tracker_config = self._load_tenant_capture_settings(
            engine, tenant_id=tenant_id, schema=schema
        )

        spawned = 0
        for row in rows:
            cam_id = int(row.id)
            cam_name = str(row.name)
            cam_config = camera_repo._normalise_capture_config(
                row.capture_config
            )
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
                capture_config=cam_config,
                tracker_config=tracker_config,
                detection_config=detection_config,
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
                    payload={"name": cam_name, "capture_config": cam_config},
                )

        return spawned

    def _select_active_cameras(
        self,
        engine,
        *,
        tenant_id: int,
        schema: Optional[str],
    ):
        """Raw SELECT for cameras with ``worker_enabled=true`` under a
        tenant. Bypasses the repository's full row hydration (which
        decrypts every row's URL to surface ``rtsp_host``) so a single
        bad ciphertext can't fail the listing for the whole tenant.

        Returns the columns needed to construct/maintain a
        ``CaptureWorker``: id, name, rtsp_url_encrypted, capture_config.
        ``display_enabled`` is intentionally not selected here — the
        manager doesn't care about it; the live-capture router reads
        it directly per request.
        """

        stmt = select(
            cameras_table.c.id,
            cameras_table.c.name,
            cameras_table.c.rtsp_url_encrypted,
            cameras_table.c.capture_config,
        ).where(
            cameras_table.c.tenant_id == tenant_id,
            cameras_table.c.worker_enabled.is_(True),
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

        ``payload`` may carry the special keys ``before`` and ``after``;
        when present they're routed to the native ``audit_log.before`` /
        ``audit_log.after`` JSONB columns rather than nested under
        ``after``. This keeps config-update audit rows queryable as
        ``audit_log.after->'max_faces_per_event'`` per the standard
        audit contract.
        """

        before_payload: Optional[dict] = None
        after_payload: Optional[dict] = payload
        if (
            isinstance(payload, dict)
            and "before" in payload
            and "after" in payload
            and len(payload) == 2
        ):
            before_payload = payload["before"]
            after_payload = payload["after"]

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
                        before=before_payload,
                        after=after_payload,
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
                        before=before_payload,
                        after=after_payload,
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

        if cam is None or not cam.worker_enabled:
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
            capture_config=dict(cam.capture_config),
            schema=schema,
        )
        plain_url = ""  # noqa: F841
        del plain_url

    # ------------------------------------------------------------------
    # P28.5b: periodic reconcile

    def reconcile_all(self) -> dict[str, int]:
        """One full pass: bring the running worker set in sync with the
        DB row state, across every active tenant.

        Returns a dict ``{started, stopped, config_updated, errors}``
        for observability; tests use the return value for explicit
        timing assertions.

        Concurrency: discovers tenants + cameras OUTSIDE the manager
        lock (DB calls can be slow) and only reaches under the lock to
        snapshot ``_workers`` and to mutate the dict via the helper
        methods (``start_camera`` / ``stop_camera``). A request thread
        that fires ``on_camera_*`` simultaneously is safe — both paths
        funnel through ``start_camera``/``stop_camera`` which use the
        same lock.
        """

        report = {"started": 0, "stopped": 0, "config_updated": 0, "errors": 0}
        with self._lock:
            if not self._enabled:
                return report

        tenants = self._discover_tenants()
        # desired[(t, c)] = (name, plain_url, capture_config, tracker_config,
        #                    detection_config, schema)
        desired: dict[
            WorkerKey,
            tuple[
                str, str, dict[str, Any],
                dict[str, Any], dict[str, Any], Optional[str],
            ],
        ] = {}
        for tenant_id, schema in tenants:
            try:
                rows = self._select_active_cameras(
                    get_engine(), tenant_id=tenant_id, schema=schema
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "reconcile: listing failed tenant=%s schema=%s: %s",
                    tenant_id,
                    schema,
                    type(exc).__name__,
                )
                report["errors"] += 1
                continue

            # P28.5c: tenant-level detection + tracker settings.
            tenant_detection, tenant_tracker = (
                self._load_tenant_capture_settings(
                    get_engine(), tenant_id=tenant_id, schema=schema
                )
            )

            for row in rows:
                cam_id = int(row.id)
                cam_name = str(row.name)
                cam_config = camera_repo._normalise_capture_config(
                    row.capture_config
                )
                try:
                    plain_url = rtsp_io.decrypt_url(
                        str(row.rtsp_url_encrypted)
                    )
                except Exception:  # noqa: BLE001
                    # Per-row decrypt failure was audited by the boot
                    # path; the reconcile tick swallows silently to
                    # avoid spamming the audit log every 2 s.
                    report["errors"] += 1
                    continue
                desired[(tenant_id, cam_id)] = (
                    cam_name, plain_url, cam_config,
                    tenant_tracker, tenant_detection, schema,
                )

        with self._lock:
            current_keys = set(self._workers.keys())
        desired_keys = set(desired.keys())

        # Stop workers whose camera is no longer ``worker_enabled`` (or
        # the row was deleted). The CRUD ``on_camera_*`` hooks fire
        # synchronously on the request thread; this pass catches the
        # cases where the hook didn't run (out-of-band DB write, hook
        # crash) or where the worker died and needs restart.
        for key in current_keys - desired_keys:
            tid, cid = key
            if self.stop_camera(tenant_id=tid, camera_id=cid):
                report["stopped"] += 1

        # Start workers for desired keys not currently running. This
        # also catches the case where ``_workers[key]`` exists but
        # ``is_alive()`` is False — start_camera's idempotency check
        # only short-circuits on a *live* worker.
        with self._lock:
            current_workers = dict(self._workers)
        for key in desired_keys:
            (
                name,
                plain_url,
                config,
                tenant_tracker,
                tenant_detection,
                schema,
            ) = desired[key]
            tid, cid = key
            existing = current_workers.get(key)
            if existing is None or not existing.is_alive():
                # If we have a stale-dead entry, drop it before spawn.
                if existing is not None and not existing.is_alive():
                    with self._lock:
                        self._workers.pop(key, None)
                if self.start_camera(
                    tenant_id=tid,
                    camera_id=cid,
                    name=name,
                    decrypted_url=plain_url,
                    capture_config=config,
                    tracker_config=tenant_tracker,
                    detection_config=tenant_detection,
                    schema=schema,
                ):
                    report["started"] += 1
                continue

            # Worker is alive — check for config drift across the
            # three knob bags. Each compares the worker's snapshot to
            # what the DB says now.
            try:
                current_config = existing.get_capture_config()
                if current_config != config:
                    existing.update_config(config)
                    report["config_updated"] += 1
                    self._audit_worker_event(
                        tenant_id=tid,
                        schema=schema,
                        action="capture.worker.config_updated",
                        entity_id=str(cid),
                        payload={
                            "before": current_config,
                            "after": config,
                        },
                    )

                # P28.5c: tenant-level tracker_config drift.
                current_tracker = existing.get_tracker_config()
                if current_tracker != tenant_tracker:
                    existing.update_tracker_config(tenant_tracker)
                    report["config_updated"] += 1
                    self._audit_worker_event(
                        tenant_id=tid,
                        schema=schema,
                        action="capture.worker.tracker_config_updated",
                        entity_id=str(cid),
                        payload={
                            "before": current_tracker,
                            "after": tenant_tracker,
                        },
                    )

                # P28.5c: tenant-level detection_config drift.
                current_detection = existing.get_detection_config()
                if current_detection != tenant_detection:
                    existing.update_detection_config(tenant_detection)
                    report["config_updated"] += 1
                    self._audit_worker_event(
                        tenant_id=tid,
                        schema=schema,
                        action="capture.worker.detection_config_updated",
                        entity_id=str(cid),
                        payload={
                            "before": current_detection,
                            "after": tenant_detection,
                        },
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "reconcile: config update failed tenant=%s "
                    "camera_id=%s reason=%s",
                    tid,
                    cid,
                    type(exc).__name__,
                )
                report["errors"] += 1

        return report

    # ------------------------------------------------------------------
    # P28.5c: tenant-level detection + tracker config loader

    # Mirror the migration's defaults so a tenant with no row, or a
    # row missing keys, falls back cleanly.
    _DEFAULT_DETECTION_CONFIG: dict = {
        "mode": "insightface",
        "det_size": 320,
        "min_det_score": 0.5,
        "min_face_pixels": 3600,
        "yolo_conf": 0.35,
        "show_body_boxes": False,
    }
    _DEFAULT_TRACKER_CONFIG: dict = {
        "iou_threshold": 0.3,
        "timeout_sec": 2.0,
        "max_duration_sec": 60.0,
    }

    def _load_tenant_capture_settings(
        self,
        engine,
        *,
        tenant_id: int,
        schema: Optional[str],
    ) -> tuple[dict, dict]:
        """Return ``(detection_config, tracker_config)`` for one tenant.

        Both fall back to module-level defaults when the row is
        missing or a key is absent — defence in depth on top of the
        migration's server_default. The reconcile tick calls this
        every pass; cheap raw SELECT, no model state involved.
        """

        from sqlalchemy import select  # noqa: PLC0415

        from hadir.db import tenant_settings  # noqa: PLC0415

        stmt = select(
            tenant_settings.c.detection_config,
            tenant_settings.c.tracker_config,
        ).where(tenant_settings.c.tenant_id == tenant_id)

        try:
            if schema is None:
                with engine.begin() as conn:
                    row = conn.execute(stmt).first()
            else:
                from hadir.db import tenant_context  # noqa: PLC0415

                with tenant_context(schema):
                    with engine.begin() as conn:
                        row = conn.execute(stmt).first()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "tenant_settings load failed tenant=%s schema=%s: %s",
                tenant_id,
                schema,
                type(exc).__name__,
            )
            return (
                dict(self._DEFAULT_DETECTION_CONFIG),
                dict(self._DEFAULT_TRACKER_CONFIG),
            )

        detection = dict(self._DEFAULT_DETECTION_CONFIG)
        tracker = dict(self._DEFAULT_TRACKER_CONFIG)
        if row is not None:
            if isinstance(row.detection_config, dict):
                detection.update(row.detection_config)
            if isinstance(row.tracker_config, dict):
                tracker.update(row.tracker_config)
        return detection, tracker

    # ------------------------------------------------------------------

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
