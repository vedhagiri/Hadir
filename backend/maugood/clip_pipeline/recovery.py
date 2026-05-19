"""Boot-time recovery for stuck clip_processing_results rows.

If a worker, scheduler, or whole backend container dies mid-job, the
``clip_processing_results`` row stays at ``status='processing'`` with
no in-memory queue to drain it. This module is the recovery flow that
runs at ``ClipPipeline.start()`` to:

1. Enumerate stuck rows per tenant.
2. Validate the DB + on-disk state to decide whether a cheap resume
   path is safe vs. requiring a full restart.
3. Atomically claim each row (so a second recovery pass — e.g. a hot
   restart — can't double-process it) and either flip it to
   ``completed`` (Class A), re-enqueue as a matching-only resume
   (Class B), or schedule a full re-run from cropping (Class C).

The classification is **artifact-based**, not metadata-based: a row
that claims to have finished cropping but whose face_crops are absent
or whose disk files don't exist drops to Class C. A row stuck in
``processing`` before cropping ever wrote a crop also drops to Class C.

Class B is the headline CPU saver. When all five validation checks
pass, recognition runs on the already-saved face crops directly
(~3–5 ms each) instead of re-decoding the clip + re-running
detection (~80–150 ms per frame × N frames).

This module is import-light on purpose; expensive deps (cv2, the
matcher cache, the upsert helper) are late-imported inside the
helpers that actually need them so the boot path stays fast even
when no recovery is needed.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Optional

import sqlalchemy as sa

from maugood.db import (
    clip_processing_results,
    face_crops as face_crops_table,
    get_engine,
    person_clips,
    tenant_context,
    tenants as tenants_table,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables (env-overridable; same pattern as ClipPipeline's own knobs)
# ---------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        v = int(raw)
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    try:
        v = float(raw)
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


# How many recovery attempts we allow before flipping to ``failed``.
# 3 is enough to absorb two unclean shutdowns mid-recovery and still
# clear a healthy job; a fourth try is almost always a poison job.
MAX_RECOVERY_ATTEMPTS = _env_int(
    "MAUGOOD_CLIP_PIPELINE_MAX_RECOVERY_ATTEMPTS", 3
)

# Seconds to wait after pipeline start before kicking off recovery.
# Lets capture workers, matcher cache, and the DB pool warm up first
# so recovery doesn't compete with normal-traffic startup CPU.
RECOVERY_DELAY_SECONDS = _env_int(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_DELAY_S", 30
)

# Drip-feed: throttle re-enqueue rate to avoid a startup CPU spike.
# Class B (light: recognition-only) gets a faster cadence than
# Class C (heavy: full re-detection).
RECOVERY_LIGHT_BURST = _env_int(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_RATE_LIGHT_BURST", 10
)
RECOVERY_LIGHT_INTERVAL_S = _env_float(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_RATE_LIGHT_INTERVAL_S", 2.0
)
RECOVERY_HEAVY_BURST = _env_int(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_RATE_HEAVY_BURST", 3
)
RECOVERY_HEAVY_INTERVAL_S = _env_float(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_RATE_HEAVY_INTERVAL_S", 5.0
)

# Number of on-disk file_paths to stat per Class-B candidate. Sampling
# rather than checking every crop keeps validation cheap on backlogs
# with thousands of crops; 3 is enough to catch a wiped volume.
DISK_SAMPLE_COUNT = _env_int(
    "MAUGOOD_CLIP_PIPELINE_RECOVERY_DISK_SAMPLE", 3
)


# ---------------------------------------------------------------------------
# Decision record
# ---------------------------------------------------------------------------


@dataclass
class RecoveryDecision:
    """Per-row recovery classification. Drives the audit payload and the
    drip-feed scheduler downstream."""

    tenant_id: int
    tenant_schema: Optional[str]
    clip_id: int
    use_case: str
    klass: str  # 'A' | 'B' | 'C' | 'failed_cap' | 'noop'
    reason: str
    artifact_count: int
    artifact_disk_ok: Optional[bool]
    recovery_attempts_before: int
    recovery_attempts_after: int

    @property
    def class_label(self) -> str:
        return {
            "A": "completed_mislabelled",
            "B": "match_only_resume",
            "C": "full_restart",
            "failed_cap": "failed_recovery_cap",
            "noop": "noop",
        }.get(self.klass, self.klass)


@dataclass
class RecoverySummary:
    """One-shot counts surfaced into BatchTracker as a synthetic batch."""

    scanned: int = 0
    class_a: int = 0
    class_b: int = 0
    class_c: int = 0
    failed_cap: int = 0
    skipped: int = 0


# ---------------------------------------------------------------------------
# Tenant discovery (mirrors capture/manager.py)
# ---------------------------------------------------------------------------


def discover_active_tenants() -> list[tuple[int, Optional[str]]]:
    """Return ``[(tenant_id, schema_name), ...]`` for every active tenant.

    Always reads ``public.tenants`` regardless of ``MAUGOOD_TENANT_MODE``;
    the mode flag governs HTTP routing, not recovery sweep coverage.
    """

    engine = get_engine()
    try:
        with tenant_context("public"):
            with engine.begin() as conn:
                rows = conn.execute(
                    sa.select(
                        tenants_table.c.id, tenants_table.c.schema_name
                    ).where(tenants_table.c.status == "active")
                ).all()
        return [(int(r.id), str(r.schema_name)) for r in rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "clip pipeline recovery: tenants discovery failed (%s)",
            type(exc).__name__,
        )
        return []


# ---------------------------------------------------------------------------
# Validation pipeline
# ---------------------------------------------------------------------------


def _row_is_class_a(row: sa.Row) -> bool:
    """Check 1: matching already completed — just mislabelled.

    Strict — we only flip to completed when matching has demonstrably
    finished (match_duration_ms set AND matched_employees populated).
    A row claiming match_duration_ms but no matched_employees is
    suspicious and goes through the full validation path instead.
    """

    if row.match_duration_ms is None:
        return False
    matched = row.matched_employees or []
    if not isinstance(matched, list):
        return False
    # The completed pipeline writes face_crop_count > 0 alongside the
    # match duration. A zero count means matching ran on no crops —
    # legitimately possible (clip with no detected faces) but rare;
    # we accept it here so a genuinely-noop completed run can still
    # flip out of ``processing``.
    return True


def _sample_disk_artifacts(
    paths: list[str], sample_count: int = DISK_SAMPLE_COUNT
) -> bool:
    """Check that at least one sample of the saved crop files is
    present + non-empty on disk. Sample-based to keep validation
    cheap on large backlogs; a wiped /face_crops volume will fail at
    least one of the first ``sample_count`` checks."""

    if not paths:
        return False
    from pathlib import Path  # noqa: PLC0415

    sample = paths[: max(1, sample_count)]
    for p in sample:
        try:
            fp = Path(p)
            if not fp.exists():
                return False
            if fp.stat().st_size <= 0:
                return False
        except OSError:
            return False
    return True


def _fetch_stuck_rows(
    *, tenant_id: int
) -> list[sa.Row]:
    """SELECT all stuck rows for the tenant under the active context.

    Ordered oldest-first so the operator-visible "stuck for hours"
    jobs clear before any minutes-old ones.
    """

    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            sa.select(
                clip_processing_results.c.id,
                clip_processing_results.c.person_clip_id,
                clip_processing_results.c.use_case,
                clip_processing_results.c.status,
                clip_processing_results.c.started_at,
                clip_processing_results.c.face_extract_duration_ms,
                clip_processing_results.c.match_duration_ms,
                clip_processing_results.c.matched_employees,
                clip_processing_results.c.face_crop_count,
                clip_processing_results.c.recovery_attempts,
            )
            .where(
                clip_processing_results.c.tenant_id == tenant_id,
                clip_processing_results.c.status == "processing",
            )
            .order_by(
                clip_processing_results.c.started_at.asc().nulls_first()
            )
        ).all()
    return list(rows)


def _fetch_artifact_index(
    *, tenant_id: int, pairs: list[tuple[int, str]]
) -> dict[tuple[int, str], list[str]]:
    """Bulk-fetch up to ``DISK_SAMPLE_COUNT`` file_paths per (clip, uc).

    One query for all pairs rather than N round-trips. The list is the
    first N (by face_crops.id) file_paths — we don't need every crop,
    just enough samples for the disk check. NULL file_paths are
    filtered out before the LIMIT.
    """

    if not pairs:
        return {}

    engine = get_engine()
    # ROW_NUMBER OVER (PARTITION BY person_clip_id, use_case ORDER BY id)
    # would let us LIMIT per-group inside Postgres. Easier — and still
    # cheap because there are O(stuck_rows) pairs, not O(clips) — to
    # fetch a single page per pair under one connection.
    out: dict[tuple[int, str], list[str]] = {}
    with engine.begin() as conn:
        for clip_id, uc in pairs:
            paths_rows = conn.execute(
                sa.select(face_crops_table.c.file_path)
                .where(
                    face_crops_table.c.tenant_id == tenant_id,
                    face_crops_table.c.person_clip_id == clip_id,
                    face_crops_table.c.use_case == uc,
                    face_crops_table.c.file_path.isnot(None),
                )
                .order_by(face_crops_table.c.id.asc())
                .limit(DISK_SAMPLE_COUNT)
            ).all()
            out[(clip_id, uc)] = [str(r[0]) for r in paths_rows]
    return out


def _fetch_artifact_counts(
    *, tenant_id: int, pairs: list[tuple[int, str]]
) -> dict[tuple[int, str], int]:
    """Bulk-count face_crops rows per (clip, uc) for the tenant.

    One GROUP BY query for the whole stuck set. Zero-count pairs are
    not returned — callers default to 0.
    """

    if not pairs:
        return {}

    engine = get_engine()
    clip_ids = list({c for c, _ in pairs})
    use_cases = list({u for _, u in pairs})
    with engine.begin() as conn:
        rows = conn.execute(
            sa.select(
                face_crops_table.c.person_clip_id,
                face_crops_table.c.use_case,
                sa.func.count().label("n"),
            )
            .where(
                face_crops_table.c.tenant_id == tenant_id,
                face_crops_table.c.person_clip_id.in_(clip_ids),
                face_crops_table.c.use_case.in_(use_cases),
            )
            .group_by(
                face_crops_table.c.person_clip_id,
                face_crops_table.c.use_case,
            )
        ).all()
    return {
        (int(r.person_clip_id), str(r.use_case)): int(r.n) for r in rows
    }


def _classify_row(
    row: sa.Row,
    *,
    tenant_id: int,
    tenant_schema: Optional[str],
    artifact_count: int,
    sample_paths: list[str],
) -> RecoveryDecision:
    """Run the five validation checks; return a RecoveryDecision.

    The checks fire in cost order — Class A is a single DB-column
    inspection, Class C-by-no-artifacts is one int compare, Class C-
    by-partial-stage is one column inspection, the disk check is the
    only one that touches the filesystem.
    """

    clip_id = int(row.person_clip_id)
    use_case = str(row.use_case)
    attempts = int(row.recovery_attempts or 0)

    # Check 0: poison-job cap. Beyond MAX_RECOVERY_ATTEMPTS we refuse
    # to retry and mark the row failed. Sits ahead of Class A because
    # an over-cap row should NOT silently flip to completed even if it
    # somehow gained match_duration_ms between attempts.
    if attempts >= MAX_RECOVERY_ATTEMPTS:
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="failed_cap",
            reason="recovery_attempts >= cap",
            artifact_count=artifact_count,
            artifact_disk_ok=None,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # Check 1: already complete, just mislabelled.
    if _row_is_class_a(row):
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="A",
            reason="matching finished but status not flipped",
            artifact_count=artifact_count,
            artifact_disk_ok=None,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # Check 2: no crops at all → cropping never made progress. Drop
    # straight to Class C. Catches the "processing before face
    # cropping even starts" case explicitly.
    if artifact_count == 0:
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="C",
            reason="no face_crops rows — cropping never wrote artifacts",
            artifact_count=0,
            artifact_disk_ok=None,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # Check 3: face_crops exist BUT cropping stage didn't commit
    # ``face_extract_duration_ms``. Partial / corrupted crop set.
    if row.face_extract_duration_ms is None:
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="C",
            reason="face_crops present but cropping stage didn't commit — partial artifacts",
            artifact_count=artifact_count,
            artifact_disk_ok=None,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # Check 5 before Check 4: UC2/UC3 always full-restart because
    # their crops are written during matching, so any crops present
    # are by definition incomplete. Cheaper than the disk check.
    if use_case != "uc1":
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="C",
            reason="UC2/UC3 crops are interleaved with matching — unsafe to reuse",
            artifact_count=artifact_count,
            artifact_disk_ok=None,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # Check 4: sample disk artifacts.
    disk_ok = _sample_disk_artifacts(sample_paths, DISK_SAMPLE_COUNT)
    if not disk_ok:
        return RecoveryDecision(
            tenant_id=tenant_id,
            tenant_schema=tenant_schema,
            clip_id=clip_id,
            use_case=use_case,
            klass="C",
            reason="face_crops rows present but disk files missing/empty",
            artifact_count=artifact_count,
            artifact_disk_ok=False,
            recovery_attempts_before=attempts,
            recovery_attempts_after=attempts,
        )

    # All five checks passed → matching-only resume.
    return RecoveryDecision(
        tenant_id=tenant_id,
        tenant_schema=tenant_schema,
        clip_id=clip_id,
        use_case=use_case,
        klass="B",
        reason="cropping artifacts intact — reuse for matching-only resume",
        artifact_count=artifact_count,
        artifact_disk_ok=True,
        recovery_attempts_before=attempts,
        recovery_attempts_after=attempts,
    )


def validate_stuck_jobs(
    *, tenant_id: int, tenant_schema: Optional[str]
) -> list[RecoveryDecision]:
    """Per-tenant: fetch stuck rows, validate, return decisions.

    Caller MUST already be inside ``tenant_context(tenant_schema)`` for
    the SQL to land in the right schema.
    """

    rows = _fetch_stuck_rows(tenant_id=tenant_id)
    if not rows:
        return []

    pairs = [(int(r.person_clip_id), str(r.use_case)) for r in rows]
    counts = _fetch_artifact_counts(tenant_id=tenant_id, pairs=pairs)
    # Only bother fetching the disk samples for rows that look like a
    # Class B candidate — keeps the per-pair SELECT down to UC1 rows
    # whose stage actually finished cropping.
    sample_pairs = [
        (cid, uc)
        for r, (cid, uc) in zip(rows, pairs)
        if uc == "uc1"
        and r.face_extract_duration_ms is not None
        and counts.get((cid, uc), 0) > 0
        and not _row_is_class_a(r)
        and int(r.recovery_attempts or 0) < MAX_RECOVERY_ATTEMPTS
    ]
    paths = _fetch_artifact_index(
        tenant_id=tenant_id, pairs=sample_pairs
    )

    decisions: list[RecoveryDecision] = []
    for row, pair in zip(rows, pairs):
        decisions.append(
            _classify_row(
                row,
                tenant_id=tenant_id,
                tenant_schema=tenant_schema,
                artifact_count=counts.get(pair, 0),
                sample_paths=paths.get(pair, []),
            )
        )
    return decisions


# ---------------------------------------------------------------------------
# Atomic claim + Class A/C application
# ---------------------------------------------------------------------------


def claim_for_recovery(
    *, tenant_id: int, clip_id: int, use_case: str
) -> Optional[int]:
    """Atomic claim: flip status processing→pending and bump
    recovery_attempts. Returns the new ``recovery_attempts`` value
    on success, or ``None`` if another pass already claimed the row
    (rowcount=0). Caller MUST already be inside ``tenant_context``.

    The ``recovery_attempts < cap`` predicate is the second source of
    truth for the cap — the validator's check 0 is the visible signal,
    but a second concurrent recovery pass would also re-validate from
    scratch, so the predicate here is the load-bearing safety.
    """

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.update(clip_processing_results)
            .where(
                clip_processing_results.c.tenant_id == tenant_id,
                clip_processing_results.c.person_clip_id == clip_id,
                clip_processing_results.c.use_case == use_case,
                clip_processing_results.c.status == "processing",
                clip_processing_results.c.recovery_attempts
                < MAX_RECOVERY_ATTEMPTS,
            )
            .values(
                status="pending",
                recovery_attempts=(
                    clip_processing_results.c.recovery_attempts + 1
                ),
            )
            .returning(clip_processing_results.c.recovery_attempts)
        )
        row = result.first()
        if row is None:
            return None
        return int(row[0])


def apply_class_a(
    *, tenant_id: int, clip_id: int, use_case: str
) -> bool:
    """Class A: already-completed row, just mislabelled. Single UPDATE
    flip; no recovery_attempts bump (no actual recovery happened).
    Idempotent via the status guard.
    """

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.update(clip_processing_results)
            .where(
                clip_processing_results.c.tenant_id == tenant_id,
                clip_processing_results.c.person_clip_id == clip_id,
                clip_processing_results.c.use_case == use_case,
                clip_processing_results.c.status == "processing",
            )
            .values(status="completed")
        )
    return (result.rowcount or 0) > 0


def apply_failed_cap(
    *, tenant_id: int, clip_id: int, use_case: str
) -> bool:
    """Beyond-cap row: terminal failure marker. The cap predicate
    in the WHERE is defence in depth — if a concurrent pass already
    bumped attempts below the cap, this update no-ops cleanly.
    """

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.update(clip_processing_results)
            .where(
                clip_processing_results.c.tenant_id == tenant_id,
                clip_processing_results.c.person_clip_id == clip_id,
                clip_processing_results.c.use_case == use_case,
                clip_processing_results.c.status == "processing",
                clip_processing_results.c.recovery_attempts
                >= MAX_RECOVERY_ATTEMPTS,
            )
            .values(
                status="failed",
                error="exceeded recovery attempts after restart",
            )
        )
    return (result.rowcount or 0) > 0


def delete_partial_artifacts(
    *, tenant_id: int, clip_id: int, use_case: str
) -> int:
    """Class C cleanup: drop any partial face_crops rows for the
    (clip, uc) before we restart from cropping. Returns the row
    count deleted. The encrypted JPEGs on disk under the deleted
    rows are intentionally NOT removed here — they're harmless
    orphans, and a future cropping run will overwrite/replace the
    parent path. Avoiding the disk delete keeps recovery cheap and
    avoids accidentally removing crops that might be referenced by
    a row whose recovery hasn't yet run.
    """

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.delete(face_crops_table).where(
                face_crops_table.c.tenant_id == tenant_id,
                face_crops_table.c.person_clip_id == clip_id,
                face_crops_table.c.use_case == use_case,
            )
        )
    return int(result.rowcount or 0)


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


def write_recovery_audit(
    *, decision: RecoveryDecision
) -> None:
    """One audit row per decision, regardless of class. ``failed_cap``
    rows also get an audit entry so the operator can see why a row
    landed in ``status='failed'``.
    """

    from maugood.auth.audit import write_audit  # noqa: PLC0415

    engine = get_engine()
    payload = {
        "class": decision.klass,
        "label": decision.class_label,
        "reason": decision.reason,
        "use_case": decision.use_case,
        "artifact_count": decision.artifact_count,
        "artifact_disk_ok": decision.artifact_disk_ok,
        "recovery_attempts_before": decision.recovery_attempts_before,
        "recovery_attempts_after": decision.recovery_attempts_after,
    }
    try:
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=decision.tenant_id,
                actor_user_id=None,
                action="clip_pipeline.recovered_at_boot",
                entity_type="person_clip",
                entity_id=str(decision.clip_id),
                after=payload,
            )
    except Exception as exc:  # noqa: BLE001
        # An audit failure must not block recovery; just log.
        logger.warning(
            "clip pipeline recovery audit write failed: "
            "tenant=%s clip=%s reason=%s",
            decision.tenant_id, decision.clip_id, type(exc).__name__,
        )


# ---------------------------------------------------------------------------
# Orchestration — called by ClipPipeline.start()
# ---------------------------------------------------------------------------


def run_recovery(
    *,
    enqueue_class_b: "callable",  # type: ignore[type-arg]
    enqueue_class_c: "callable",  # type: ignore[type-arg]
) -> RecoverySummary:
    """Top-level entry point. Walks every active tenant, classifies
    every stuck row, applies Class A/failed_cap immediately, and hands
    Class B + C off to the queue-submission callbacks supplied by the
    pipeline. The callbacks are injected so this module stays free of
    a circular import on pipeline.py.

    The callbacks themselves are responsible for the drip-feed cadence
    — this function returns once all decisions are made and Class A /
    failed_cap rows are flipped.
    """

    summary = RecoverySummary()
    tenants = discover_active_tenants()
    if not tenants:
        logger.info("clip pipeline recovery: no active tenants found")
        return summary

    for tenant_id, schema in tenants:
        try:
            with tenant_context(schema):
                decisions = validate_stuck_jobs(
                    tenant_id=tenant_id, tenant_schema=schema
                )
                if not decisions:
                    continue
                logger.info(
                    "clip pipeline recovery: tenant=%s schema=%s scanned=%d",
                    tenant_id, schema, len(decisions),
                )
                for decision in decisions:
                    summary.scanned += 1
                    if decision.klass == "A":
                        applied = apply_class_a(
                            tenant_id=tenant_id,
                            clip_id=decision.clip_id,
                            use_case=decision.use_case,
                        )
                        if applied:
                            summary.class_a += 1
                            write_recovery_audit(decision=decision)
                        else:
                            summary.skipped += 1
                        continue

                    if decision.klass == "failed_cap":
                        if apply_failed_cap(
                            tenant_id=tenant_id,
                            clip_id=decision.clip_id,
                            use_case=decision.use_case,
                        ):
                            summary.failed_cap += 1
                            write_recovery_audit(decision=decision)
                        else:
                            summary.skipped += 1
                        continue

                    # Class B / C — atomic claim, then enqueue. Each
                    # claim mutates the row; if a concurrent pass
                    # already claimed it we skip.
                    new_attempts = claim_for_recovery(
                        tenant_id=tenant_id,
                        clip_id=decision.clip_id,
                        use_case=decision.use_case,
                    )
                    if new_attempts is None:
                        summary.skipped += 1
                        continue
                    decision.recovery_attempts_after = new_attempts

                    if decision.klass == "C":
                        # Wipe any partial crops before re-running.
                        # UC2/UC3 deliberately delete here even though
                        # the crop_count might be > 0 — those are
                        # mid-matching artifacts, not reusable.
                        try:
                            delete_partial_artifacts(
                                tenant_id=tenant_id,
                                clip_id=decision.clip_id,
                                use_case=decision.use_case,
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "clip pipeline recovery: partial-artifact "
                                "cleanup failed: tenant=%s clip=%s uc=%s "
                                "reason=%s",
                                tenant_id, decision.clip_id,
                                decision.use_case, type(exc).__name__,
                            )

                    # Hand off to the pipeline-supplied enqueue
                    # callback. The callback applies the drip-feed
                    # cadence so this loop stays linear.
                    if decision.klass == "B":
                        enqueue_class_b(decision)
                        summary.class_b += 1
                    elif decision.klass == "C":
                        enqueue_class_c(decision)
                        summary.class_c += 1
                    write_recovery_audit(decision=decision)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "clip pipeline recovery: tenant=%s schema=%s failed (%s)",
                tenant_id, schema, type(exc).__name__,
            )
            continue

    logger.info(
        "clip pipeline recovery complete: scanned=%d A=%d B=%d C=%d "
        "failed_cap=%d skipped=%d",
        summary.scanned, summary.class_a, summary.class_b,
        summary.class_c, summary.failed_cap, summary.skipped,
    )
    return summary


def start_deferred_recovery(
    *,
    enqueue_class_b: "callable",  # type: ignore[type-arg]
    enqueue_class_c: "callable",  # type: ignore[type-arg]
    on_complete: "Optional[callable]" = None,  # type: ignore[type-arg]
    delay_s: Optional[int] = None,
) -> threading.Thread:
    """Spawn a daemon thread that sleeps ``delay_s`` and then runs the
    full recovery sweep. Returns the thread so the caller can join it
    in tests; in production it's fire-and-forget.
    """

    actual_delay = RECOVERY_DELAY_SECONDS if delay_s is None else delay_s

    def _entry() -> None:
        if actual_delay > 0:
            # Quiet sleep — no log line here because boot logs are
            # already chatty. The "starting" line below is the audit
            # trail for when recovery actually began.
            time.sleep(actual_delay)
        logger.info(
            "clip pipeline recovery: starting (delay_s=%d)",
            actual_delay,
        )
        try:
            summary = run_recovery(
                enqueue_class_b=enqueue_class_b,
                enqueue_class_c=enqueue_class_c,
            )
            if on_complete is not None:
                try:
                    on_complete(summary)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "clip pipeline recovery on_complete failed: %s",
                        type(exc).__name__,
                    )
        except Exception:  # noqa: BLE001
            logger.exception("clip pipeline recovery thread crashed")

    t = threading.Thread(
        target=_entry, name="clip-pipeline-recovery", daemon=True
    )
    t.start()
    return t


__all__ = [
    "MAX_RECOVERY_ATTEMPTS",
    "RECOVERY_DELAY_SECONDS",
    "RECOVERY_LIGHT_BURST",
    "RECOVERY_LIGHT_INTERVAL_S",
    "RECOVERY_HEAVY_BURST",
    "RECOVERY_HEAVY_INTERVAL_S",
    "DISK_SAMPLE_COUNT",
    "RecoveryDecision",
    "RecoverySummary",
    "discover_active_tenants",
    "validate_stuck_jobs",
    "claim_for_recovery",
    "apply_class_a",
    "apply_failed_cap",
    "delete_partial_artifacts",
    "write_recovery_audit",
    "run_recovery",
    "start_deferred_recovery",
]
