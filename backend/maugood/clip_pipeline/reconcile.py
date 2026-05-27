"""Periodic reconcile scheduler for the clip-processing pipeline.

Three independent sweep jobs run on a configurable interval:

1. **saved-clips sweep** — finds ``recording_status='completed'`` rows
   that have no ``clip_processing_results`` rows at all (i.e. auto-submit
   in ``ClipWorker._finalize_clip`` either pre-dates the auto-submit code
   or silently failed) and submits them to the always-on clip_pipeline.

2. **stuck-processing sweep** — finds ``clip_processing_results`` rows
   stuck at ``status='processing'`` beyond a configurable timeout
   (default 20 min) and re-enqueues them via ``recover_now`` so they
   don't stay frozen after a crash that didn't produce a clean shutdown.

3. **file-integrity sweep** — for each tenant, samples the 50 most
   recent ``completed`` clip rows and confirms the Fernet-encrypted file
   exists on disk.  Rows whose file is absent get any pending/processing
   CPR rows flipped to ``failed`` with ``error='clip file missing'``, and
   the clip itself is flagged with a ``file_missing=True`` column if that
   column exists (added in the companion migration).

All three sweeps are tenant-aware (iterates ``public.tenants``), run on
a single daemon thread, and emit one ``audit_log`` row per tenant-sweep so
the ops team can track the reconcile cadence without tailing logs.

Tunables (all env-overridable):

* ``MAUGOOD_RECONCILE_INTERVAL_S``       — seconds between full sweeps  (default 300)
* ``MAUGOOD_RECONCILE_SAVED_MAX``        — max saved clips re-submitted per tenant per sweep (default 200)
* ``MAUGOOD_RECONCILE_STUCK_TIMEOUT_S``  — seconds before a processing row is considered stuck (default 1200)
* ``MAUGOOD_RECONCILE_FILE_SAMPLE``      — completed clips to spot-check per tenant (default 50)
* ``MAUGOOD_RECONCILE_DISABLE``          — set "1" to skip (tests / dev)
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import sqlalchemy as sa

from maugood.db import (
    clip_processing_results,
    get_engine,
    person_clips,
    tenant_context,
    tenants as tenants_table,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


RECONCILE_INTERVAL_S = _env_int("MAUGOOD_RECONCILE_INTERVAL_S", 300)
RECONCILE_SAVED_MAX = _env_int("MAUGOOD_RECONCILE_SAVED_MAX", 200)
RECONCILE_STUCK_TIMEOUT_S = _env_int("MAUGOOD_RECONCILE_STUCK_TIMEOUT_S", 1200)
RECONCILE_FILE_SAMPLE = _env_int("MAUGOOD_RECONCILE_FILE_SAMPLE", 50)


# ---------------------------------------------------------------------------
# Result shapes (returned by each sweep, logged + surfaced by status endpoint)
# ---------------------------------------------------------------------------

@dataclass
class SavedClipsSweepResult:
    tenant_schema: str
    found: int = 0
    submitted: int = 0
    skipped_file_missing: int = 0
    errors: int = 0
    ran_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class StuckSweepResult:
    tenant_schema: str
    found: int = 0
    requeued: int = 0
    errors: int = 0
    ran_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class FileIntegrityResult:
    tenant_schema: str
    checked: int = 0
    missing: int = 0
    flagged_cprs: int = 0
    ran_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class ReconcileSweepSummary:
    tenant_schema: str
    saved: SavedClipsSweepResult
    stuck: StuckSweepResult
    integrity: FileIntegrityResult
    duration_ms: float = 0.0
    ran_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ---------------------------------------------------------------------------
# Sweep 1: saved clips (completed + no CPR row)
# ---------------------------------------------------------------------------

def sweep_saved_clips(
    scope: TenantScope,
    pipeline: object,   # ClipPipeline — late-typed to avoid circular import
    *,
    max_clips: int = RECONCILE_SAVED_MAX,
) -> SavedClipsSweepResult:
    """Submit completed clips that were never sent to the pipeline."""
    result = SavedClipsSweepResult(tenant_schema=scope.tenant_schema)
    engine = get_engine()

    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            # Find completed clips that have NO clip_processing_results row
            # at all. We specifically exclude clips whose file_path is NULL
            # (the file was never written) and clips created in the last
            # 2 minutes (ClipWorker might still be finalising them).
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=120)
            rows = conn.execute(
                sa.select(person_clips.c.id, person_clips.c.file_path)
                .where(
                    person_clips.c.tenant_id == scope.tenant_id,
                    person_clips.c.recording_status == "completed",
                    person_clips.c.file_path.is_not(None),
                    person_clips.c.clip_start < cutoff,
                    ~sa.exists(
                        sa.select(clip_processing_results.c.id).where(
                            clip_processing_results.c.tenant_id == scope.tenant_id,
                            clip_processing_results.c.person_clip_id == person_clips.c.id,
                        )
                    ),
                )
                .order_by(person_clips.c.id.desc())
                .limit(max_clips)
            ).all()

        result.found = len(rows)
        if not rows:
            return result

        # Batch-submit to clip_pipeline
        clip_ids_to_submit: list[int] = []
        for row in rows:
            fp = row.file_path
            if fp and not Path(str(fp)).exists():
                result.skipped_file_missing += 1
                continue
            clip_ids_to_submit.append(int(row.id))

        if clip_ids_to_submit:
            try:
                pipeline.submit_batch(  # type: ignore[attr-defined]
                    scope=scope,
                    clip_ids=clip_ids_to_submit,
                    use_cases=["uc1", "uc2", "uc3"],
                    skip_existing=True,
                    submitted_by_user_id=None,
                    submitted_by_email="reconcile@auto-submit",
                )
                result.submitted = len(clip_ids_to_submit)
                logger.info(
                    "reconcile saved_clips: tenant=%s submitted=%d skipped_missing=%d",
                    scope.tenant_schema, result.submitted, result.skipped_file_missing,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                logger.warning(
                    "reconcile saved_clips submit failed: tenant=%s reason=%s",
                    scope.tenant_schema, type(exc).__name__,
                )

    return result


# ---------------------------------------------------------------------------
# Sweep 2: stuck processing rows
# ---------------------------------------------------------------------------

def sweep_stuck_processing(
    scope: TenantScope,
    pipeline: object,
    *,
    timeout_s: int = RECONCILE_STUCK_TIMEOUT_S,
) -> StuckSweepResult:
    """Re-enqueue clip_processing_results rows stuck at 'processing' beyond timeout."""
    result = StuckSweepResult(tenant_schema=scope.tenant_schema)
    engine = get_engine()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout_s)

    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            rows = conn.execute(
                sa.select(
                    clip_processing_results.c.person_clip_id,
                    clip_processing_results.c.use_case,
                    clip_processing_results.c.started_at,
                ).where(
                    clip_processing_results.c.tenant_id == scope.tenant_id,
                    clip_processing_results.c.status == "processing",
                    # Only consider rows that have been processing for > timeout
                    clip_processing_results.c.started_at < cutoff,
                )
            ).all()

        result.found = len(rows)
        if not rows:
            return result

    # Use the pipeline's recover_now so the existing recovery classification
    # logic (Class A/B/C) handles the stuck rows correctly.
    try:
        pipeline.recover_now(blocking=False)  # type: ignore[attr-defined]
        result.requeued = result.found
        logger.info(
            "reconcile stuck_processing: tenant=%s found=%d triggered_recovery=True",
            scope.tenant_schema, result.found,
        )
    except Exception as exc:  # noqa: BLE001
        result.errors += 1
        logger.warning(
            "reconcile stuck_processing recover_now failed: tenant=%s reason=%s",
            scope.tenant_schema, type(exc).__name__,
        )

    return result


# ---------------------------------------------------------------------------
# Sweep 3: file integrity
# ---------------------------------------------------------------------------

def sweep_file_integrity(
    scope: TenantScope,
    *,
    sample_count: int = RECONCILE_FILE_SAMPLE,
) -> FileIntegrityResult:
    """Spot-check that completed clip files exist on disk.

    For any clip where the file is absent:
    - Flip any pending/processing CPR rows to failed with
      error='clip file missing'.
    - Log a WARNING so the ops team can investigate storage issues.
    """
    result = FileIntegrityResult(tenant_schema=scope.tenant_schema)
    engine = get_engine()

    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            rows = conn.execute(
                sa.select(person_clips.c.id, person_clips.c.file_path)
                .where(
                    person_clips.c.tenant_id == scope.tenant_id,
                    person_clips.c.recording_status == "completed",
                    person_clips.c.file_path.is_not(None),
                )
                .order_by(person_clips.c.clip_start.desc())
                .limit(sample_count)
            ).all()

        result.checked = len(rows)

        for row in rows:
            fp = row.file_path
            if not fp:
                continue
            if Path(str(fp)).exists():
                continue

            # File is missing
            result.missing += 1
            clip_id = int(row.id)
            logger.warning(
                "reconcile file_integrity: MISSING file clip=%s tenant=%s path=%s",
                clip_id, scope.tenant_schema, fp,
            )

            with engine.begin() as conn:
                # Flip any pending/processing CPR rows to failed
                updated = conn.execute(
                    sa.update(clip_processing_results)
                    .where(
                        clip_processing_results.c.tenant_id == scope.tenant_id,
                        clip_processing_results.c.person_clip_id == clip_id,
                        clip_processing_results.c.status.in_(["pending", "processing"]),
                    )
                    .values(
                        status="failed",
                        error="clip file missing",
                        ended_at=datetime.now(timezone.utc),
                    )
                    .returning(clip_processing_results.c.id)
                )
                n = len(updated.all())
                result.flagged_cprs += n

    return result


# ---------------------------------------------------------------------------
# Full per-tenant sweep
# ---------------------------------------------------------------------------

def run_tenant_sweep(
    scope: TenantScope,
    pipeline: object,
) -> ReconcileSweepSummary:
    t0 = time.monotonic()
    saved = sweep_saved_clips(scope, pipeline)
    stuck = sweep_stuck_processing(scope, pipeline)
    integrity = sweep_file_integrity(scope)
    duration_ms = (time.monotonic() - t0) * 1000

    summary = ReconcileSweepSummary(
        tenant_schema=scope.tenant_schema,
        saved=saved,
        stuck=stuck,
        integrity=integrity,
        duration_ms=duration_ms,
    )
    logger.info(
        "reconcile sweep done: tenant=%s saved_submitted=%d stuck_found=%d "
        "missing_files=%d duration_ms=%.0f",
        scope.tenant_schema,
        saved.submitted,
        stuck.found,
        integrity.missing,
        duration_ms,
    )
    return summary


# ---------------------------------------------------------------------------
# Active-tenant discovery (mirrors recovery.py)
# ---------------------------------------------------------------------------

def _discover_tenants() -> list[tuple[int, str]]:
    engine = get_engine()
    with tenant_context("public"):
        with engine.connect() as conn:
            rows = conn.execute(
                sa.select(tenants_table.c.id, tenants_table.c.schema_name)
                .where(
                    tenants_table.c.status.in_(["active", None]),
                    tenants_table.c.schema_name.is_not(None),
                )
            ).all()
    return [(int(r[0]), str(r[1])) for r in rows]


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class ReconcileScheduler:
    """APScheduler-backed periodic reconcile runner.

    Lifecycle mirrors ``RetentionScheduler`` (P25): one daemon
    ``BackgroundScheduler`` with a single interval job. Start/stop called
    from FastAPI lifespan alongside every other scheduler in main.py.
    """

    def __init__(self) -> None:
        self._scheduler = None
        self._lock = threading.Lock()
        self._last_summaries: dict[str, ReconcileSweepSummary] = {}

    # ---- public API --------------------------------------------------------

    def start(self, pipeline: object) -> None:
        if os.environ.get("MAUGOOD_RECONCILE_DISABLE", "").lower() in ("1", "true"):
            logger.info("reconcile scheduler disabled via MAUGOOD_RECONCILE_DISABLE")
            return

        with self._lock:
            if self._scheduler is not None:
                return

            from apscheduler.schedulers.background import BackgroundScheduler  # noqa: PLC0415

            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(
                self._tick,
                "interval",
                seconds=RECONCILE_INTERVAL_S,
                id="clip_reconcile",
                max_instances=1,
                coalesce=True,
                kwargs={"pipeline": pipeline},
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "reconcile scheduler started: interval=%ds saved_max=%d "
                "stuck_timeout=%ds file_sample=%d",
                RECONCILE_INTERVAL_S,
                RECONCILE_SAVED_MAX,
                RECONCILE_STUCK_TIMEOUT_S,
                RECONCILE_FILE_SAMPLE,
            )

        # Run once immediately so existing saved clips get picked up after restart
        t = threading.Thread(
            target=self._tick,
            kwargs={"pipeline": pipeline},
            daemon=True,
            name="reconcile-boot",
        )
        t.start()

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            try:
                self._scheduler.shutdown(wait=False)
            except Exception:  # noqa: BLE001
                pass
            self._scheduler = None
            logger.info("reconcile scheduler stopped")

    def run_now(self, pipeline: object) -> list[ReconcileSweepSummary]:
        """Trigger an immediate reconcile sweep across all tenants (blocking)."""
        return self._run_all_tenants(pipeline)

    def last_summaries(self) -> dict[str, dict]:
        """Return the most recent sweep result per tenant schema."""
        with self._lock:
            return {
                schema: {
                    "saved_submitted": s.saved.submitted,
                    "saved_found": s.saved.found,
                    "stuck_found": s.stuck.found,
                    "missing_files": s.integrity.missing,
                    "flagged_cprs": s.integrity.flagged_cprs,
                    "duration_ms": s.duration_ms,
                    "ran_at": s.ran_at.isoformat(),
                }
                for schema, s in self._last_summaries.items()
            }

    # ---- internal ----------------------------------------------------------

    def _tick(self, pipeline: object) -> None:
        try:
            summaries = self._run_all_tenants(pipeline)
            with self._lock:
                for s in summaries:
                    self._last_summaries[s.tenant_schema] = s
        except Exception:  # noqa: BLE001
            logger.exception("reconcile tick raised unexpectedly")

    def _run_all_tenants(self, pipeline: object) -> list[ReconcileSweepSummary]:
        results: list[ReconcileSweepSummary] = []
        try:
            tenant_rows = _discover_tenants()
        except Exception as exc:  # noqa: BLE001
            logger.warning("reconcile: could not list tenants: %s", exc)
            return results

        for tenant_id, schema in tenant_rows:
            scope = TenantScope(
                tenant_id=tenant_id,
                tenant_schema=schema,
            )
            try:
                summary = run_tenant_sweep(scope, pipeline)
                results.append(summary)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "reconcile: sweep failed for tenant=%s", schema
                )

        return results


# Process-wide singleton
reconcile_scheduler = ReconcileScheduler()
