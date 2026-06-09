"""Two-stage clip-processing pipeline orchestrator.

Always-on cropping + matching workers driven by in-memory queues.
Each ``(clip, use_case)`` pair is one job that flows:

    [submit] → CroppingQueue → cropping worker
                                    ↓ (emits MatchJob, carrying
                                       the in-memory frame_results
                                       so the matcher doesn't have
                                       to re-decode + re-detect)
                              MatchingQueue → matching worker
                                    ↓
                            clip_processing_results
                            + face_crops backfill
                            + batch tracker bookkeeping

Reuses the existing helpers in ``maugood.person_clips.reprocess`` so
behaviour stays parity with the legacy ``ReprocessFaceMatchWorker``
on a per-clip/per-UC basis.
"""

from __future__ import annotations

import logging
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import select as sa_select
from sqlalchemy import update as sa_update

from maugood.clip_pipeline.batches import BatchTracker
from maugood.clip_pipeline.jobs import (
    BatchSubmission,
    CropJob,
    MatchJob,
)
from maugood.clip_pipeline.stage import StageQueue
from maugood.db import (
    clip_processing_results,
    get_engine,
    person_clips,
    tenant_context,
)
from maugood.employees.photos import decrypt_bytes
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


# Worker counts. Both stages run a single always-on worker for v1 —
# matches the recommended architecture from the design conversation
# (cropping is detector-lock-bound; matching against the read-only
# matcher_cache is cheap and one worker can keep up). Configurable via
# env so an operator can scale up if profiling justifies it.
import os  # noqa: E402  (deliberately late so the module top is config-free)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        v = int(raw)
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


CROPPING_WORKERS = _env_int("MAUGOOD_CLIP_PIPELINE_CROPPING_WORKERS", 1)
MATCHING_WORKERS = _env_int("MAUGOOD_CLIP_PIPELINE_MATCHING_WORKERS", 1)
QUEUE_MAX_DEPTH = _env_int("MAUGOOD_CLIP_PIPELINE_QUEUE_MAX_DEPTH", 4096)


# ---- clip-pipeline use-case enable set ------------------------------------
#
# ``MAUGOOD_CLIP_PIPELINE_USE_CASES`` (CSV, default "uc1,uc2,uc3") is the
# env-layer source of truth for which use cases run process-wide. A
# per-tenant override lives in ``tenant_settings.clip_pipeline_use_cases``
# (migration 0073) and, when set (non-NULL), wins over the env default at
# submit time via ``enabled_use_cases_for``. The canonical ordering is
# always (uc1, uc2, uc3) regardless of input order.

# Canonical valid set + ordering. Referenced by ``system/router.py``'s
# config endpoint comment as ``pipeline._VALID_USE_CASES``.
_VALID_USE_CASES: tuple[str, ...] = ("uc1", "uc2", "uc3")


def _env_use_cases(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    """Parse a CSV use-case env var into a canonical tuple.

    Rules (pinned by ``tests/test_clip_pipeline_use_cases.py``):

    * The env var being **unset** (``None``) returns ``default`` verbatim
      — that's how "no operator override" means "run the default set".
    * A present value (even ``""``) is parsed: split on commas, strip +
      lowercase each token, keep only tokens in ``{uc1, uc2, uc3}``,
      dedupe, and return them in the canonical (uc1, uc2, uc3) order.
    * An empty string or an all-invalid value parses to ``()`` — i.e. a
      deliberate "run nothing", distinct from the unset/default case.
    """

    raw = os.environ.get(name)
    if raw is None:
        return default
    seen: set[str] = set()
    for token in raw.split(","):
        t = token.strip().lower()
        if t in _VALID_USE_CASES:
            seen.add(t)
    return tuple(uc for uc in _VALID_USE_CASES if uc in seen)


# Computed once at import. ``ClipPipeline.UCS`` is bound to this so the
# stage startup spins up exactly the env-enabled cropping stages. Tests
# reload this module to recompute it under a changed env.
ENABLED_USE_CASES: tuple[str, ...] = _env_use_cases(
    "MAUGOOD_CLIP_PIPELINE_USE_CASES", ("uc1", "uc2", "uc3")
)


def enabled_use_cases() -> tuple[str, ...]:
    """The process-wide env/default enabled set (no DB read).

    Used by callers that have no tenant scope to consult (e.g. the
    single-clip match path in ``reprocess.py``) and as the fallback for
    the per-tenant resolver when the DB column is NULL/unreadable.
    """

    return ENABLED_USE_CASES


# ---- per-tenant DB-backed resolver (migration 0073) -----------------------
#
# Reads ``tenant_settings.clip_pipeline_use_cases`` for the scope's tenant.
# Tenant-scoped read only — the lookup runs inside ``tenant_context`` and
# filters on ``tenant_id`` so it can never see another tenant's row. A 5s
# per-tenant TTL cache keeps the hot auto-submit path from hitting the DB
# on every clip; ``invalidate_use_cases_cache`` lets the PUT endpoint make
# a change take effect immediately.

_USE_CASES_TTL_S = 5.0
_use_cases_cache: dict[int, tuple[float, tuple[str, ...]]] = {}
_use_cases_cache_lock = threading.Lock()


def invalidate_use_cases_cache(tenant_id: Optional[int] = None) -> None:
    """Drop the per-tenant resolver cache.

    ``tenant_id=None`` clears every tenant's entry (used by tests and any
    broad change); a concrete id clears just that tenant (the PUT
    endpoint's case).
    """

    with _use_cases_cache_lock:
        if tenant_id is None:
            _use_cases_cache.clear()
        else:
            _use_cases_cache.pop(int(tenant_id), None)


def _normalize_use_cases(value) -> tuple[str, ...]:
    """Canonicalize a stored JSON array into a valid-only ordered tuple.

    An empty (non-NULL) list normalizes to ``()`` — "none run" — which
    the resolver treats as a real value, NOT a fall-through to env.
    """

    if not isinstance(value, (list, tuple)):
        return ()
    seen = {str(t).strip().lower() for t in value}
    return tuple(uc for uc in _VALID_USE_CASES if uc in seen)


def _read_tenant_use_cases(scope: TenantScope) -> Optional[tuple[str, ...]]:
    """Return the per-tenant DB value, or ``None`` to signal "inherit env".

    ``None`` is returned when the column is NULL, the row is missing, or
    any read error occurs (fail-soft: the env/default is always a safe
    fallback). A present (even empty) array returns a concrete tuple.
    """

    from maugood.db import tenant_settings  # noqa: PLC0415

    engine = get_engine()
    try:
        with tenant_context(scope.tenant_schema):
            with engine.begin() as conn:
                row = conn.execute(
                    sa_select(
                        tenant_settings.c.clip_pipeline_use_cases
                    ).where(tenant_settings.c.tenant_id == scope.tenant_id)
                ).first()
    except Exception:  # noqa: BLE001
        return None
    if row is None or row.clip_pipeline_use_cases is None:
        return None
    return _normalize_use_cases(row.clip_pipeline_use_cases)


def enabled_use_cases_for(scope_or_tenant_id) -> tuple[str, ...]:
    """Per-tenant effective enabled set: DB value if set, else env/default.

    Accepts either a :class:`TenantScope` (the auto-submit / reconcile /
    recovery callers) or a bare ``tenant_id`` int. A bare int has no
    schema to scope a read under, so it cannot consult the DB and falls
    back to the env/default set — never another tenant's value.

    Cached per tenant for ``_USE_CASES_TTL_S`` seconds.
    """

    if isinstance(scope_or_tenant_id, TenantScope):
        scope = scope_or_tenant_id
    else:
        # Bare tenant_id — no schema, so no tenant-scoped DB read is
        # possible. Return the env/default (the per-tenant-isolation test
        # pins this: a tenant whose column is NULL must not inherit
        # another tenant's DB value).
        return enabled_use_cases()

    tid = int(scope.tenant_id)
    now = time.time()
    with _use_cases_cache_lock:
        hit = _use_cases_cache.get(tid)
        if hit is not None and (now - hit[0]) < _USE_CASES_TTL_S:
            return hit[1]

    db_value = _read_tenant_use_cases(scope)
    result = db_value if db_value is not None else enabled_use_cases()

    with _use_cases_cache_lock:
        _use_cases_cache[tid] = (now, result)
    return result


def _recovery_drip_sleep_light() -> None:
    """Drip-feed for Class B (recognition-only) re-enqueues. Uses the
    interval / burst constants from ``recovery`` so a single env var
    tunes both sides.
    """

    from maugood.clip_pipeline import recovery  # noqa: PLC0415

    # Convert (burst, interval) to per-submission sleep so the sweep is
    # straight-line. Burst=10 over 2s → 200ms per submission.
    per = recovery.RECOVERY_LIGHT_INTERVAL_S / max(
        1, recovery.RECOVERY_LIGHT_BURST
    )
    if per > 0:
        time.sleep(per)


def _recovery_drip_sleep_heavy() -> None:
    """Drip-feed for Class C (full-restart) re-enqueues."""

    from maugood.clip_pipeline import recovery  # noqa: PLC0415

    per = recovery.RECOVERY_HEAVY_INTERVAL_S / max(
        1, recovery.RECOVERY_HEAVY_BURST
    )
    if per > 0:
        time.sleep(per)


def _summary_to_dict(summary) -> dict:
    """Plain-dict view of a RecoverySummary for API responses."""

    return {
        "scanned": int(getattr(summary, "scanned", 0)),
        "class_a": int(getattr(summary, "class_a", 0)),
        "class_b": int(getattr(summary, "class_b", 0)),
        "class_c": int(getattr(summary, "class_c", 0)),
        "failed_cap": int(getattr(summary, "failed_cap", 0)),
        "skipped": int(getattr(summary, "skipped", 0)),
    }


def _scope_worker_views(workers: list[dict], viewer_tenant_id: int) -> list[dict]:
    """Tenant-scope the per-worker view for ``status_snapshot`` (Issue #2).

    The stage workers are process-global and may be mid-flight on a job
    belonging to ANY tenant. For a tenant-scoped Pipeline Monitor request
    we must not expose another tenant's job identifier (``current_job``
    carries a concrete ``clip #<id>``). For each worker:

      * if it's busy on another tenant's job → redact ``current_job`` to
        ``""`` (utilisation/health stay visible, the clip-id does not);
      * always strip the internal ``current_job_tenant_id`` key so it
        never reaches the API response.
    """

    scoped: list[dict] = []
    for w in workers:
        owner = w.get("current_job_tenant_id")
        out = {k: v for k, v in w.items() if k != "current_job_tenant_id"}
        if owner is not None and owner != viewer_tenant_id:
            out["current_job"] = ""
        scoped.append(out)
    return scoped


class ClipPipeline:
    """Process-wide singleton — see module docstring."""

    # Valid UCs each get their own cropping queue + worker so the
    # Pipeline Monitor table can show 3 independent rows (UC1, UC2,
    # UC3 cropping). They still serialise on the InsightFace detector
    # lock under the hood, but the per-UC visibility + tracking is
    # the goal here, not raw parallelism (see the architecture
    # confirmation conversation). Bound to the env-derived enabled set so
    # ``start()`` spins up exactly the enabled cropping stages; an empty
    # set means zero cropping stages (the matching stage still runs).
    # Per-tenant enforcement happens at submit time via
    # ``enabled_use_cases_for`` — this constant only governs which stages
    # exist process-wide.
    UCS: tuple[str, ...] = ENABLED_USE_CASES

    def __init__(self) -> None:
        self._started = False
        self._lock = threading.Lock()
        self._tracker = BatchTracker()
        # Stages constructed in start() so the handlers can close over
        # ``self`` without circular reference at module import time.
        self._cropping_by_uc: dict[str, StageQueue[CropJob]] = {}
        self._matching: Optional[StageQueue[MatchJob]] = None
        # P29 — guard so a manual ``recover_now`` triggered while the
        # boot-time deferred recovery thread is still running (or another
        # manual trigger is mid-sweep) doesn't double-fire. The atomic
        # claim UPDATE in ``recovery.py`` would catch the race anyway,
        # but the in-flight guard avoids spawning two threads doing the
        # same DB walk.
        self._recovery_in_flight = False

    # ---- lifecycle ---------------------------------------------------

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            for uc in self.UCS:
                # Each UC keeps a thin lambda referencing self so the
                # handler can stay shared across UCs while the stage
                # name + queue + worker thread stay distinct.
                stage = StageQueue[CropJob](
                    f"clip-pipeline-crop-{uc}",
                    self._handle_crop,
                    worker_count=CROPPING_WORKERS,
                    max_depth=QUEUE_MAX_DEPTH,
                )
                stage.start()
                self._cropping_by_uc[uc] = stage
            self._matching = StageQueue[MatchJob](
                "clip-pipeline-match",
                self._handle_match,
                worker_count=MATCHING_WORKERS,
                max_depth=QUEUE_MAX_DEPTH,
            )
            self._matching.start()
            self._started = True
            logger.info(
                "clip_pipeline started: cropping_workers_per_uc=%d ucs=%s matching_workers=%d max_depth=%d",
                CROPPING_WORKERS,
                list(self.UCS),
                MATCHING_WORKERS,
                QUEUE_MAX_DEPTH,
            )

        # P29 — deferred boot-time recovery for stuck processing rows.
        # Spawned outside the lock because the recovery thread itself
        # acquires it via the enqueue callbacks. A test or operator can
        # disable via MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY=1.
        if os.environ.get(
            "MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY", ""
        ).lower() not in ("1", "true", "yes"):
            self._schedule_recovery()

    def stop(self) -> None:
        with self._lock:
            if not self._started:
                return
            for stage in self._cropping_by_uc.values():
                stage.stop()
            self._cropping_by_uc.clear()
            if self._matching is not None:
                self._matching.stop()
            self._matching = None
            self._started = False
            logger.info("clip_pipeline stopped")

    # ---- queue management (Admin Clear Queues feature) ---------------

    def queue_depths(self) -> dict[str, int]:
        """Snapshot of every in-memory queue's current depth.

        Keys are stable identifiers used by the Clear Queues UI:
        ``crop_uc1`` / ``crop_uc2`` / ``crop_uc3`` / ``match``. Disabled
        UCs are omitted (no stage exists). Process-wide — the queue
        itself isn't tenant-scoped; the per-tenant DB cleanup happens
        separately in the router.
        """

        out: dict[str, int] = {}
        with self._lock:
            for uc, stage in self._cropping_by_uc.items():
                out[f"crop_{uc}"] = stage.queue_depth()
            if self._matching is not None:
                out["match"] = self._matching.queue_depth()
        return out

    def clear_queue(self, queue_name: str) -> int:
        """Drain one named in-memory queue. Returns the count cleared.

        Names: ``crop_uc1``, ``crop_uc2``, ``crop_uc3``, ``match``.
        Returns 0 for an unknown name rather than raising — the router
        validates input before calling and an unknown name reaching
        here would indicate a wiring bug, not user input.
        """

        with self._lock:
            if queue_name.startswith("crop_"):
                uc = queue_name[len("crop_"):]
                stage = self._cropping_by_uc.get(uc)
                if stage is None:
                    return 0
                return stage.drain()
            if queue_name == "match":
                if self._matching is None:
                    return 0
                return self._matching.drain()
        return 0

    def clear_all_queues(self) -> dict[str, int]:
        """Drain every in-memory queue. Returns per-queue cleared
        counts so the router can surface what was discarded."""

        out: dict[str, int] = {}
        with self._lock:
            for uc, stage in self._cropping_by_uc.items():
                out[f"crop_{uc}"] = stage.drain()
            if self._matching is not None:
                out["match"] = self._matching.drain()
        return out

    # ---- public API --------------------------------------------------

    def submit_batch(
        self,
        *,
        scope: TenantScope,
        clip_ids: list[int],
        use_cases: list[str],
        skip_existing: bool,
        submitted_by_user_id: Optional[int],
        submitted_by_email: Optional[str],
    ) -> BatchSubmission:
        """Expand the (clips × use_cases) cross-product into individual
        jobs and push them onto the cropping queue.

        Honours ``skip_existing``: any ``(clip, uc)`` pair that already
        has a ``completed`` clip_processing_results row is skipped
        before it ever enters the queue and recorded as such in the
        batch tracker so the operator's "Skipped" counter reflects the
        real save.
        """

        if not self._started:
            raise RuntimeError("clip_pipeline not started")

        # Chokepoint: intersect the caller's requested use cases with the
        # tenant's effective enabled set BEFORE the batch ever fans out
        # into jobs. The DB per-tenant value (migration 0073) wins over
        # the env default here; a disabled UC is dropped so it runs
        # nowhere — auto-submit, reconcile, and boot recovery all funnel
        # through this method. An empty result is a clean no-op (the
        # clip-save path must never error just because cropping is off).
        enabled = enabled_use_cases_for(scope)
        effective = [uc for uc in use_cases if uc in enabled]
        if effective != list(use_cases):
            logger.info(
                "clip_pipeline submit_batch: tenant=%s requested=%s "
                "effective=%s (gated by enabled set %s)",
                scope.tenant_id,
                list(use_cases),
                effective,
                list(enabled),
            )

        batch = self._tracker.create(
            tenant_id=scope.tenant_id,
            clip_ids=clip_ids,
            use_cases=effective,
            skip_existing=skip_existing,
            submitted_by_user_id=submitted_by_user_id,
            submitted_by_email=submitted_by_email,
        )

        # Pre-load existing (clip, uc) completion state in one query so
        # skip_existing doesn't fan out into N SELECTs.
        existing: set[tuple[int, str]] = set()
        if skip_existing and clip_ids and effective:
            engine = get_engine()
            with tenant_context(scope.tenant_schema):
                with engine.begin() as conn:
                    rows = conn.execute(
                        sa_select(
                            clip_processing_results.c.person_clip_id,
                            clip_processing_results.c.use_case,
                        ).where(
                            clip_processing_results.c.tenant_id == scope.tenant_id,
                            clip_processing_results.c.person_clip_id.in_(clip_ids),
                            clip_processing_results.c.use_case.in_(effective),
                            clip_processing_results.c.status == "completed",
                        )
                    ).all()
            existing = {(int(r[0]), str(r[1])) for r in rows}

        for clip_id in clip_ids:
            for uc in effective:
                if skip_existing and (clip_id, uc) in existing:
                    self._tracker.mark_skipped(batch.batch_id, uc)
                    continue
                stage = self._cropping_by_uc.get(uc)
                if stage is None:
                    # Defence in depth — router already validated UCs
                    # against VALID_USE_CASES. Anything that slips
                    # through is a hard reject so the tracker totals
                    # stay balanced.
                    self._tracker.mark_failed(
                        batch.batch_id, uc, stage="cropping"
                    )
                    continue
                job = CropJob(
                    job_id=uuid.uuid4().hex[:12],
                    batch_id=batch.batch_id,
                    clip_id=clip_id,
                    use_case=uc,
                    scope=scope,
                )
                if stage.submit(job):
                    self._tracker.mark_submitted(batch.batch_id, uc)
                else:
                    # Queue rejection counts as a failure so the operator
                    # sees the loss in the batch totals.
                    self._tracker.mark_failed(
                        batch.batch_id, uc, stage="cropping"
                    )

        logger.info(
            "clip_pipeline batch=%s submitted: clips=%d use_cases=%s skip_existing=%s queued=%d skipped=%d",
            batch.batch_id,
            len(clip_ids),
            effective,
            skip_existing,
            batch.queued_jobs,
            batch.skipped_jobs,
        )
        return batch

    def status_snapshot(self, *, tenant_id: int) -> dict:
        """Pipeline Monitor payload — queues + workers + batches for
        the requesting tenant."""

        cropping_by_uc: dict[str, dict] = {}
        # Aggregate over the per-UC stages too so the legacy
        # ``cropping`` block (kept for backwards compat with the
        # Queue Pipeline panel from the prior turn) still shows the
        # global cropping totals.
        agg_q = 0
        agg_in = 0
        agg_done = 0
        agg_fail = 0
        agg_workers: list[dict] = []
        for uc in self.UCS:
            stage = self._cropping_by_uc.get(uc)
            s = stage.stats() if stage else None
            block = {
                "queue_depth": s.queue_depth if s else 0,
                "in_flight": s.in_flight if s else 0,
                "lifetime_processed": s.lifetime_processed if s else 0,
                "lifetime_failed": s.lifetime_failed if s else 0,
                "workers": _scope_worker_views(s.workers, tenant_id) if s else [],
            }
            cropping_by_uc[uc] = block
            agg_q += block["queue_depth"]
            agg_in += block["in_flight"]
            agg_done += block["lifetime_processed"]
            agg_fail += block["lifetime_failed"]
            agg_workers.extend(block["workers"])

        match_stats = self._matching.stats() if self._matching else None
        return {
            "running": self._started,
            "cropping": {
                "queue_depth": agg_q,
                "in_flight": agg_in,
                "lifetime_processed": agg_done,
                "lifetime_failed": agg_fail,
                "workers": agg_workers,
            },
            "cropping_by_uc": cropping_by_uc,
            "matching": {
                "queue_depth": match_stats.queue_depth if match_stats else 0,
                "in_flight": match_stats.in_flight if match_stats else 0,
                "lifetime_processed": (
                    match_stats.lifetime_processed if match_stats else 0
                ),
                "lifetime_failed": (
                    match_stats.lifetime_failed if match_stats else 0
                ),
                "workers": (
                    _scope_worker_views(match_stats.workers, tenant_id)
                    if match_stats else []
                ),
            },
            "batches": self._tracker.snapshot(tenant_id),
            "config": {
                "cropping_workers_per_uc": CROPPING_WORKERS,
                "matching_workers": MATCHING_WORKERS,
                "queue_max_depth": QUEUE_MAX_DEPTH,
                "ucs": list(self.UCS),
            },
        }

    # ---- boot-time + on-demand recovery -----------------------------

    def recover_now(self, *, blocking: bool = False) -> Optional[dict]:
        """Manually trigger an immediate recovery sweep — no startup
        delay, no drip-feed cadence change. Used by the Pipeline
        Monitor's "Restart All Workers" action.

        Idempotent on concurrent calls: if a sweep is already in
        flight, returns ``None`` immediately rather than starting a
        second walk of the same DB rows. The atomic claim UPDATE in
        ``recovery.claim_for_recovery`` is the load-bearing safety —
        this guard is just a courtesy to avoid two threads doing the
        same DB scan in parallel.

        ``blocking=True`` runs synchronously on the caller's thread
        and returns the ``RecoverySummary`` as a dict. Default
        (False) spawns the same daemon thread shape as the boot-time
        path, returns a small dict announcing the trigger.
        """

        with self._lock:
            if not self._started:
                return {"triggered": False, "reason": "pipeline not started"}
            if self._recovery_in_flight:
                return {"triggered": False, "reason": "recovery already in flight"}
            self._recovery_in_flight = True

        if blocking:
            try:
                summary = self._do_recovery_sweep()
                return {
                    "triggered": True,
                    "blocking": True,
                    **_summary_to_dict(summary),
                }
            finally:
                with self._lock:
                    self._recovery_in_flight = False
        else:
            self._spawn_recovery_thread(delay_s=0)
            return {"triggered": True, "blocking": False}

    def _schedule_recovery(self) -> None:
        """Deferred boot-time recovery. Spawns a daemon thread that
        sleeps ``RECOVERY_DELAY_SECONDS`` before sweeping — see
        ``recovery.start_deferred_recovery`` for the timing rationale.
        """

        with self._lock:
            if self._recovery_in_flight:
                return
            self._recovery_in_flight = True

        self._spawn_recovery_thread(delay_s=None)

    def _spawn_recovery_thread(self, *, delay_s: Optional[int]) -> None:
        """Shared boot-time + recover_now machinery. Builds the
        per-tenant synthetic batch + enqueue callbacks, then hands
        off to ``recovery.start_deferred_recovery``.
        """

        def _on_complete(_summary) -> None:
            with self._lock:
                self._recovery_in_flight = False

        from maugood.clip_pipeline import recovery  # noqa: PLC0415

        # Per-tenant synthetic batches, created lazily on first Class B
        # or C decision for that tenant so empty-recovery tenants don't
        # appear in the Pipeline Monitor list.
        recovery_batches: dict[int, BatchSubmission] = {}
        rebatches_lock = threading.Lock()

        def _ensure_batch(tenant_id: int) -> BatchSubmission:
            with rebatches_lock:
                b = recovery_batches.get(tenant_id)
                if b is not None:
                    return b
                b = self._tracker.create(
                    tenant_id=tenant_id,
                    clip_ids=[],
                    use_cases=list(self.UCS),
                    skip_existing=False,
                    submitted_by_user_id=None,
                    submitted_by_email="system:recovery@boot",
                )
                recovery_batches[tenant_id] = b
                return b

        def _enqueue_class_b(decision: "recovery.RecoveryDecision") -> None:
            """Class B: matching-only resume — push a synthetic MatchJob
            straight onto the matching queue (skip cropping). Light
            drip-feed cadence (10 / 2 s)."""

            # Resolve camera_id once so the attendance fan-out has it.
            camera_id = self._fetch_camera_id_for_clip(
                scope=TenantScope(
                    tenant_id=decision.tenant_id,
                    tenant_schema=decision.tenant_schema,
                ),
                clip_id=decision.clip_id,
            )
            batch = _ensure_batch(decision.tenant_id)
            scope = TenantScope(
                tenant_id=decision.tenant_id,
                tenant_schema=decision.tenant_schema,
            )
            match_job = MatchJob(
                job_id=uuid.uuid4().hex[:12],
                batch_id=batch.batch_id,
                clip_id=decision.clip_id,
                use_case=decision.use_case,
                scope=scope,
                submitted_at=time.time(),
                cropping_started_at=time.time(),
                cropping_ended_at=time.time(),
                frame_results=[],
                frames_meta={},
                extract_seconds=0.0,
                clip_meta={"camera_id": camera_id},
                crop_match_index={},
                initial_face_crop_count=0,
                resume_from_db=True,
            )
            # Bookkeeping: in the tracker we count this job as both
            # submitted + already past cropping so the Pipeline Monitor
            # row shows it in 'matching' rather than 'queued'.
            self._tracker.mark_submitted(batch.batch_id, decision.use_case)
            self._tracker.mark_cropping_started(
                batch.batch_id, decision.use_case
            )
            self._tracker.mark_cropping_finished_enqueue_match(
                batch.batch_id, decision.use_case
            )
            if self._matching is None or not self._matching.submit(match_job):
                logger.warning(
                    "clip_pipeline recovery: Class B enqueue rejected "
                    "(matching queue full or stopped) tenant=%s clip=%s uc=%s",
                    decision.tenant_id, decision.clip_id, decision.use_case,
                )
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="matching"
                )

            # Light drip cadence — share a small sleep across the
            # whole sweep so we don't slam the queue + matcher.
            _recovery_drip_sleep_light()

        def _enqueue_class_c(decision: "recovery.RecoveryDecision") -> None:
            """Class C: full restart — push a normal CropJob. Heavy
            drip-feed cadence (3 / 5 s) because each one re-runs
            detection."""

            batch = _ensure_batch(decision.tenant_id)
            scope = TenantScope(
                tenant_id=decision.tenant_id,
                tenant_schema=decision.tenant_schema,
            )
            crop_job = CropJob(
                job_id=uuid.uuid4().hex[:12],
                batch_id=batch.batch_id,
                clip_id=decision.clip_id,
                use_case=decision.use_case,
                scope=scope,
            )
            stage = self._cropping_by_uc.get(decision.use_case)
            if stage is None:
                logger.warning(
                    "clip_pipeline recovery: Class C — unknown use_case "
                    "tenant=%s clip=%s uc=%s",
                    decision.tenant_id, decision.clip_id, decision.use_case,
                )
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="cropping"
                )
                return
            self._tracker.mark_submitted(batch.batch_id, decision.use_case)
            if not stage.submit(crop_job):
                logger.warning(
                    "clip_pipeline recovery: Class C enqueue rejected "
                    "(cropping queue full) tenant=%s clip=%s uc=%s",
                    decision.tenant_id, decision.clip_id, decision.use_case,
                )
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="cropping"
                )
            _recovery_drip_sleep_heavy()

        # Stash the callbacks on ``self`` so blocking ``recover_now``
        # can call ``run_recovery`` synchronously with the same
        # enqueue + batch shape, no thread spawn.
        self._last_enqueue_class_b = _enqueue_class_b
        self._last_enqueue_class_c = _enqueue_class_c

        recovery.start_deferred_recovery(
            enqueue_class_b=_enqueue_class_b,
            enqueue_class_c=_enqueue_class_c,
            on_complete=_on_complete,
            delay_s=delay_s,
        )

    def _do_recovery_sweep(self):
        """Synchronous sweep used by ``recover_now(blocking=True)``.

        Builds the same enqueue callbacks as the threaded path so the
        per-tenant synthetic batches + drip-feed land identically.
        Returns the ``RecoverySummary`` for direct API consumption.
        """

        from maugood.clip_pipeline import recovery  # noqa: PLC0415

        # We need the same callbacks the deferred path builds — so we
        # call _spawn_recovery_thread machinery in "synchronous mode":
        # invoke run_recovery directly. The simplest way is to take
        # the deferred path's same builder closure. Inline the trio
        # here so we don't double-spawn a thread.
        per_tenant_batches: dict[int, BatchSubmission] = {}
        bl = threading.Lock()

        def _ensure_batch(tenant_id: int) -> BatchSubmission:
            with bl:
                b = per_tenant_batches.get(tenant_id)
                if b is not None:
                    return b
                b = self._tracker.create(
                    tenant_id=tenant_id,
                    clip_ids=[],
                    use_cases=list(self.UCS),
                    skip_existing=False,
                    submitted_by_user_id=None,
                    submitted_by_email="system:recovery@manual",
                )
                per_tenant_batches[tenant_id] = b
                return b

        def _enqueue_b(decision):
            camera_id = self._fetch_camera_id_for_clip(
                scope=TenantScope(
                    tenant_id=decision.tenant_id,
                    tenant_schema=decision.tenant_schema,
                ),
                clip_id=decision.clip_id,
            )
            batch = _ensure_batch(decision.tenant_id)
            scope = TenantScope(
                tenant_id=decision.tenant_id,
                tenant_schema=decision.tenant_schema,
            )
            match_job = MatchJob(
                job_id=uuid.uuid4().hex[:12],
                batch_id=batch.batch_id,
                clip_id=decision.clip_id,
                use_case=decision.use_case,
                scope=scope,
                submitted_at=time.time(),
                cropping_started_at=time.time(),
                cropping_ended_at=time.time(),
                frame_results=[],
                frames_meta={},
                extract_seconds=0.0,
                clip_meta={"camera_id": camera_id},
                crop_match_index={},
                initial_face_crop_count=0,
                resume_from_db=True,
            )
            self._tracker.mark_submitted(batch.batch_id, decision.use_case)
            self._tracker.mark_cropping_started(
                batch.batch_id, decision.use_case
            )
            self._tracker.mark_cropping_finished_enqueue_match(
                batch.batch_id, decision.use_case
            )
            if self._matching is None or not self._matching.submit(match_job):
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="matching"
                )

        def _enqueue_c(decision):
            batch = _ensure_batch(decision.tenant_id)
            scope = TenantScope(
                tenant_id=decision.tenant_id,
                tenant_schema=decision.tenant_schema,
            )
            crop_job = CropJob(
                job_id=uuid.uuid4().hex[:12],
                batch_id=batch.batch_id,
                clip_id=decision.clip_id,
                use_case=decision.use_case,
                scope=scope,
            )
            stage = self._cropping_by_uc.get(decision.use_case)
            if stage is None:
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="cropping"
                )
                return
            self._tracker.mark_submitted(batch.batch_id, decision.use_case)
            if not stage.submit(crop_job):
                self._tracker.mark_failed(
                    batch.batch_id, decision.use_case, stage="cropping"
                )

        return recovery.run_recovery(
            enqueue_class_b=_enqueue_b,
            enqueue_class_c=_enqueue_c,
        )

    def _fetch_camera_id_for_clip(
        self, *, scope: TenantScope, clip_id: int
    ) -> Optional[int]:
        """Tiny helper to resolve camera_id under a tenant context for
        the Class B resume path. Returns None on any lookup error;
        attendance fan-out is best-effort so a missing camera_id only
        suppresses the fan-out without failing the resume itself.
        """

        engine = get_engine()
        try:
            with tenant_context(scope.tenant_schema):
                with engine.begin() as conn:
                    row = conn.execute(
                        sa_select(person_clips.c.camera_id).where(
                            person_clips.c.id == clip_id,
                            person_clips.c.tenant_id == scope.tenant_id,
                        )
                    ).first()
            if row is None:
                return None
            return int(row.camera_id) if row.camera_id is not None else None
        except Exception:  # noqa: BLE001
            return None

    # ---- stage 1: cropping ------------------------------------------

    def _handle_crop(self, job: CropJob) -> None:
        # Late imports — keep module import light and avoid a circular
        # ref via reprocess.py's own imports.
        from maugood.person_clips.reprocess import (  # noqa: PLC0415
            _run_detection,
            _sample_frames,
            _save_face_crops_to_db,
            _upsert_processing_result,
        )

        self._tracker.mark_cropping_started(job.batch_id, job.use_case)
        job.started_at = time.time()
        scope = job.scope
        engine = get_engine()
        t_total_start = time.time()

        try:
            with tenant_context(scope.tenant_schema):
                # Mark this (clip, uc) as processing before we do any
                # work — the UI's status pill flips immediately.
                _upsert_processing_result(
                    engine, scope, job.clip_id, job.use_case,
                    status="processing",
                    started_at=datetime.now(timezone.utc),
                )

                # Resolve the clip row.
                with engine.begin() as conn:
                    row = conn.execute(
                        sa_select(
                            person_clips.c.id,
                            person_clips.c.file_path,
                            person_clips.c.clip_start,
                            person_clips.c.duration_seconds,
                            person_clips.c.frame_count,
                            person_clips.c.camera_id,
                        ).where(
                            person_clips.c.id == job.clip_id,
                            person_clips.c.tenant_id == scope.tenant_id,
                        )
                    ).first()
                if row is None or not row.file_path:
                    raise RuntimeError("clip row missing or file_path empty")

                file_path = Path(str(row.file_path))
                if not file_path.exists():
                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="failed",
                        error="clip file missing",
                    )
                    self._tracker.mark_failed(
                        job.batch_id, job.use_case, stage="cropping"
                    )
                    return

                encrypted = file_path.read_bytes()
                plain = decrypt_bytes(encrypted)
                with tempfile.NamedTemporaryFile(
                    suffix=".mp4", delete=False
                ) as tmp:
                    tmp.write(plain)
                    tmp_path = Path(tmp.name)

                try:
                    frames, sample_interval, actual_fps = _sample_frames(
                        tmp_path, 10.0
                    )
                    if not frames:
                        _upsert_processing_result(
                            engine, scope, job.clip_id, job.use_case,
                            status="failed",
                            error="no frames extracted",
                        )
                        self._tracker.mark_failed(
                            job.batch_id, job.use_case, stage="cropping"
                        )
                        return

                    mode = "yolo+face" if job.use_case == "uc1" else "insightface"
                    frame_results, extract_s = _run_detection(
                        frames, mode, None, use_case=job.use_case
                    )

                    # Surface "extraction done, matching not yet" in the
                    # frontend status pill the same way the legacy path
                    # does — face_extract_duration_ms set + match_duration_ms
                    # still null reads as "now matching".
                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="processing",
                        started_at=datetime.fromtimestamp(t_total_start, tz=timezone.utc),
                        face_extract_duration_ms=int(extract_s * 1000),
                    )

                    # UC1 saves crops first (with employee_id=NULL); the
                    # matching worker backfills the IDs after running
                    # the matcher. UC2/UC3 save crops in the matching
                    # worker because they need the match result to pick
                    # the best crop per track (UC2) or to bake the ID
                    # into the INSERT (UC3) — same logic as the legacy
                    # path, just split across two workers.
                    initial_count = 0
                    crop_match_index: dict[tuple[int, int], int] = {}
                    if job.use_case == "uc1" and frame_results:
                        initial_count, crop_match_index = _save_face_crops_to_db(
                            engine, scope, job.clip_id, int(row.camera_id),
                            frames, frame_results,
                            row.clip_start,
                            float(row.duration_seconds or 0.0),
                            int(row.frame_count or 0),
                            sample_interval,
                            use_case=job.use_case,
                            det_employee_map=None,
                            max_crops_override=30,
                            return_index=True,
                        )
                finally:
                    tmp_path.unlink(missing_ok=True)

                # Memory fix: UC1 uses frames only in the cropping stage
                # above (_save_face_crops_to_db). The matching stage only
                # calls _backfill_crop_matches which reads frame_results,
                # not frames. Drop the numpy arrays now so the 158+ MB
                # of per-frame BGR data is freed before the MatchJob sits
                # in the matching queue. UC2/UC3 still need frames in the
                # matching stage to call _save_face_crops_uc2_best_per_track
                # / _save_face_crops_to_db, so they carry the list through.
                frames_for_match = [] if job.use_case == "uc1" else frames

                # Hand off to the matching stage.
                match_job = MatchJob(
                    job_id=job.job_id,
                    batch_id=job.batch_id,
                    clip_id=job.clip_id,
                    use_case=job.use_case,
                    scope=scope,
                    submitted_at=job.submitted_at,
                    cropping_started_at=job.started_at or t_total_start,
                    cropping_ended_at=time.time(),
                    frame_results=frame_results,
                    frames_meta={
                        "sample_interval": sample_interval,
                        "actual_fps": actual_fps,
                    },
                    extract_seconds=extract_s,
                    clip_meta={
                        "clip_start": row.clip_start,
                        "duration_seconds": float(row.duration_seconds or 0.0),
                        "frame_count": int(row.frame_count or 0),
                        "camera_id": int(row.camera_id),
                        "frames": frames_for_match,
                        "t_total_start": t_total_start,
                    },
                    crop_match_index=crop_match_index,
                    initial_face_crop_count=initial_count,
                )
                # Release the local frame reference now. For UC1 this
                # was already cleared above. For UC2/UC3 the MatchJob
                # holds the only remaining reference; the local variable
                # is no longer needed and we want the refcount to drop
                # as soon as the matching worker finishes with them.
                del frames, frames_for_match

            # Outside the tenant_context so the queue submission isn't
            # tied to a connection scope. mark_cropping_finished does
            # the bookkeeping; the matching worker re-enters
            # tenant_context inside its own handler.
            self._tracker.mark_cropping_finished_enqueue_match(
                job.batch_id, job.use_case
            )
            if self._matching is None:
                raise RuntimeError("matching stage not running")
            if not self._matching.submit(match_job):
                # Backpressure: the matcher is overloaded. Mark this
                # job failed at the matching stage (we already left
                # cropping) so the totals balance.
                self._tracker.mark_failed(
                    job.batch_id, job.use_case, stage="matching"
                )
                with tenant_context(scope.tenant_schema):
                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="failed",
                        error="matching queue full",
                    )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "clip_pipeline crop handler failed clip=%s uc=%s: %s",
                job.clip_id,
                job.use_case,
                type(exc).__name__,
            )
            try:
                with tenant_context(scope.tenant_schema):
                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="failed",
                        error=f"crop stage failed: {type(exc).__name__}",
                    )
            except Exception:  # noqa: BLE001
                pass
            self._tracker.mark_failed(
                job.batch_id, job.use_case, stage="cropping"
            )

    # ---- stage 2: matching ------------------------------------------

    def _handle_match(self, job: MatchJob) -> None:
        from maugood.person_clips.reprocess import (  # noqa: PLC0415
            _backfill_crop_matches,
            _emit_attendance_detection_events,
            _match_detections,
            _resolve_employee_names,
            _save_face_crops_to_db,
            _save_face_crops_uc2_best_per_track,
            _upsert_processing_result,
            match_only_from_saved_crops,
        )

        self._tracker.mark_matching_started(job.batch_id, job.use_case)
        job.started_at = time.time()
        scope = job.scope
        engine = get_engine()

        # Recovery resume branch (P29). Cropping was skipped — saved
        # crops are reused directly. ``frame_results`` is empty here so
        # the regular ``_match_detections`` path can't run.
        if job.resume_from_db:
            try:
                with tenant_context(scope.tenant_schema):
                    (
                        matched_ids,
                        unknown_count,
                        match_details,
                        face_crop_count,
                        match_s,
                        _crops_done,
                    ) = match_only_from_saved_crops(
                        engine,
                        scope,
                        clip_id=job.clip_id,
                        use_case=job.use_case,
                    )

                    name_map = _resolve_employee_names(
                        engine, scope, matched_ids
                    )
                    for md in match_details:
                        eid = md.get("employee_id")
                        if eid and eid in name_map:
                            md["name"] = name_map[eid]

                    total_ms = int((time.time() - job.cropping_started_at) * 1000)
                    matched_list = sorted(matched_ids)
                    ended_at = datetime.now(timezone.utc)

                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="completed",
                        ended_at=ended_at,
                        duration_ms=total_ms,
                        match_duration_ms=int(match_s * 1000),
                        face_crop_count=face_crop_count,
                        matched_employees=matched_list,
                        unknown_count=unknown_count,
                        match_details=match_details if match_details else None,
                    )

                    # Attendance fan-out — same as the regular path. The
                    # dedup-on-(camera, employee, captured_at) inside
                    # _emit_attendance_detection_events keeps duplicates
                    # from a previous half-run from being created again.
                    try:
                        camera_id = job.clip_meta.get("camera_id")
                        if camera_id is not None:
                            n = _emit_attendance_detection_events(
                                engine, scope, job.clip_id, int(camera_id),
                            )
                            if n > 0:
                                logger.info(
                                    "clip_pipeline recovery: attendance "
                                    "fan-out emitted %d detection_events "
                                    "row(s) clip=%s uc=%s",
                                    n, job.clip_id, job.use_case,
                                )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "clip_pipeline recovery: attendance fan-out "
                            "failed clip=%s uc=%s reason=%s",
                            job.clip_id, job.use_case, type(exc).__name__,
                        )

                self._tracker.mark_completed(job.batch_id, job.use_case)
                return
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "clip_pipeline recovery (resume): match handler "
                    "failed clip=%s uc=%s: %s",
                    job.clip_id, job.use_case, type(exc).__name__,
                )
                try:
                    with tenant_context(scope.tenant_schema):
                        _upsert_processing_result(
                            engine, scope, job.clip_id, job.use_case,
                            status="failed",
                            error=(
                                "recovery match-only resume failed: "
                                f"{type(exc).__name__}"
                            ),
                        )
                except Exception:  # noqa: BLE001
                    pass
                self._tracker.mark_failed(
                    job.batch_id, job.use_case, stage="matching"
                )
                return

        try:
            with tenant_context(scope.tenant_schema):
                (
                    det_employee_map,
                    matched_ids,
                    unknown_count,
                    match_details,
                    match_s,
                ) = _match_detections(job.frame_results, scope)

                # Save / backfill face_crops based on UC.
                clip_meta = job.clip_meta
                face_crop_count = job.initial_face_crop_count
                if job.use_case == "uc1" and job.frame_results:
                    # Crops already exist with employee_id=NULL; backfill
                    # the matched ones now (employee_id + match_confidence).
                    # clip_meta["frames"] is [] for UC1 (cleared in the
                    # cropping stage once _save_face_crops_to_db finished).
                    _backfill_crop_matches(
                        engine, scope, job.crop_match_index, det_employee_map,
                        frame_results=job.frame_results,
                    )
                elif job.use_case == "uc2" and job.frame_results:
                    face_crop_count = _save_face_crops_uc2_best_per_track(
                        engine, scope, job.clip_id, clip_meta["camera_id"],
                        clip_meta["frames"], job.frame_results,
                        clip_meta["clip_start"],
                        clip_meta["duration_seconds"],
                        clip_meta["frame_count"],
                        job.frames_meta["sample_interval"],
                        det_employee_map=det_employee_map,
                    )
                elif job.frame_results:
                    # UC3 — save after match with employee_id baked in.
                    face_crop_count = _save_face_crops_to_db(
                        engine, scope, job.clip_id, clip_meta["camera_id"],
                        clip_meta["frames"], job.frame_results,
                        clip_meta["clip_start"],
                        clip_meta["duration_seconds"],
                        clip_meta["frame_count"],
                        job.frames_meta["sample_interval"],
                        use_case=job.use_case,
                        det_employee_map=det_employee_map,
                    )

                # Memory fix: frames and frame_results are no longer
                # needed past this point. Release them immediately so
                # the numpy arrays (158+ MB per clip for UC2/UC3) and
                # the detection embedding dicts are freed before the
                # remainder of _handle_match executes.
                clip_meta["frames"] = []
                job.frame_results = []

                # Enrich match_details with employee names.
                name_map = _resolve_employee_names(engine, scope, matched_ids)
                for md in match_details:
                    eid = md.get("employee_id")
                    if eid and eid in name_map:
                        md["name"] = name_map[eid]

                total_ms = int((time.time() - clip_meta["t_total_start"]) * 1000)
                matched_list = sorted(matched_ids)
                ended_at = datetime.now(timezone.utc)

                _upsert_processing_result(
                    engine, scope, job.clip_id, job.use_case,
                    status="completed",
                    started_at=datetime.fromtimestamp(
                        clip_meta["t_total_start"], tz=timezone.utc
                    ),
                    ended_at=ended_at,
                    duration_ms=total_ms,
                    face_extract_duration_ms=int(job.extract_seconds * 1000),
                    match_duration_ms=int(match_s * 1000),
                    face_crop_count=face_crop_count,
                    matched_employees=matched_list,
                    unknown_count=unknown_count,
                    match_details=match_details if match_details else None,
                )

                # Legacy parity — UC3 owns the canonical matched_employees
                # column on person_clips so existing Camera Logs / drawer
                # paths continue to surface the match.
                if job.use_case == "uc3":
                    with engine.begin() as conn:
                        conn.execute(
                            sa_update(person_clips)
                            .where(
                                person_clips.c.id == job.clip_id,
                                person_clips.c.tenant_id == scope.tenant_id,
                            )
                            .values(
                                matched_employees=matched_list,
                                matched_status="processed",
                                face_matching_progress=100,
                                face_matching_duration_ms=total_ms,
                            )
                        )

                # Attendance fan-out — emit one detection_events row per
                # matched (clip, employee) at the best-confidence crop's
                # frame timestamp. This is what reconnects clip-pipeline
                # matches to the attendance engine since live capture no
                # longer writes detection_events.
                try:
                    n = _emit_attendance_detection_events(
                        engine, scope, job.clip_id, clip_meta["camera_id"],
                    )
                    if n > 0:
                        logger.info(
                            "clip_pipeline attendance fan-out: "
                            "clip=%s uc=%s emitted %d detection_events row(s)",
                            job.clip_id, job.use_case, n,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "clip_pipeline attendance fan-out failed: "
                        "clip=%s uc=%s reason=%s",
                        job.clip_id, job.use_case, type(exc).__name__,
                    )
            self._tracker.mark_completed(job.batch_id, job.use_case)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "clip_pipeline match handler failed clip=%s uc=%s: %s",
                job.clip_id,
                job.use_case,
                type(exc).__name__,
            )
            try:
                with tenant_context(scope.tenant_schema):
                    _upsert_processing_result(
                        engine, scope, job.clip_id, job.use_case,
                        status="failed",
                        error=f"match stage failed: {type(exc).__name__}",
                    )
            except Exception:  # noqa: BLE001
                pass
            self._tracker.mark_failed(
                job.batch_id, job.use_case, stage="matching"
            )


# Process-wide singleton. FastAPI lifespan calls ``.start()`` /
# ``.stop()``; the router calls ``.submit_batch()`` / ``.status_snapshot()``.
clip_pipeline = ClipPipeline()
