"""Per-batch tracking — operator scorecard rolled up from job state.

One ``BatchSubmission`` per operator click. The pipeline mutates its
counters as jobs flow through:

    submitted → queued_jobs counts grow
    cropping worker picks up → queued_jobs--, cropping_now++
    cropping done, enqueue match → cropping_now--, matching_now++,
                                   queued_jobs++ (waiting for matcher)
    matching worker picks up → queued_jobs--, matching_now (already
                               counted) stays the same
    matching done → matching_now--, completed_jobs++
    failure at any stage → failed_jobs++

A submitter who chose ``skip_existing=True`` and re-submits the same
clip after a prior ``completed`` run gets ``skipped_jobs++``
immediately at submit time (the job never enters either queue).

Batches are retained until ``MAX_BATCHES`` is reached, then evicted
oldest-first. The frontend's "30 selected, 10 processed, 10 skipped,
20 remaining" UI reads directly off this structure.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

from maugood.clip_pipeline.jobs import BatchSubmission

logger = logging.getLogger(__name__)


# Cap on retained batch records. A typical Identify Event run is a
# few dozen clips × 3 UCs; ~50 historical batches gives the operator
# plenty of audit-trail without burning RAM.
MAX_BATCHES = 50


class BatchTracker:
    """Thread-safe registry of in-flight + recent batches."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._batches: "OrderedDict[str, BatchSubmission]" = OrderedDict()

    def create(
        self,
        *,
        tenant_id: int,
        clip_ids: list[int],
        use_cases: list[str],
        skip_existing: bool,
        submitted_by_user_id: Optional[int],
        submitted_by_email: Optional[str],
    ) -> BatchSubmission:
        batch_id = uuid.uuid4().hex[:12]
        batch = BatchSubmission(
            batch_id=batch_id,
            tenant_id=tenant_id,
            clip_ids=list(clip_ids),
            use_cases=list(use_cases),
            skip_existing=skip_existing,
            submitted_at=datetime.now(timezone.utc),
            submitted_by_user_id=submitted_by_user_id,
            submitted_by_email=submitted_by_email,
            per_uc={
                uc: {
                    "total": 0,
                    "queued": 0,
                    "cropping": 0,
                    "matching": 0,
                    "completed": 0,
                    "skipped": 0,
                    "failed": 0,
                }
                for uc in use_cases
            },
        )
        with self._lock:
            self._batches[batch_id] = batch
            # Evict oldest if over cap.
            while len(self._batches) > MAX_BATCHES:
                evicted_id, _ = self._batches.popitem(last=False)
                logger.debug(
                    "batch tracker: evicted oldest batch %s (cap=%d)",
                    evicted_id,
                    MAX_BATCHES,
                )
        return batch

    def mark_submitted(self, batch_id: str, use_case: str) -> None:
        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            b.total_jobs += 1
            b.queued_jobs += 1
            slot = b.per_uc.setdefault(
                use_case,
                {
                    "total": 0, "queued": 0, "cropping": 0,
                    "matching": 0, "completed": 0, "skipped": 0, "failed": 0,
                },
            )
            slot["total"] += 1
            slot["queued"] += 1

    def mark_skipped(self, batch_id: str, use_case: str) -> None:
        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            b.total_jobs += 1
            b.skipped_jobs += 1
            slot = b.per_uc.setdefault(
                use_case,
                {
                    "total": 0, "queued": 0, "cropping": 0,
                    "matching": 0, "completed": 0, "skipped": 0, "failed": 0,
                },
            )
            slot["total"] += 1
            slot["skipped"] += 1

    def mark_cropping_started(self, batch_id: str, use_case: str) -> None:
        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            b.queued_jobs = max(0, b.queued_jobs - 1)
            b.cropping_now += 1
            slot = b.per_uc.get(use_case)
            if slot is not None:
                slot["queued"] = max(0, slot["queued"] - 1)
                slot["cropping"] += 1

    def mark_cropping_finished_enqueue_match(
        self, batch_id: str, use_case: str
    ) -> None:
        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            b.cropping_now = max(0, b.cropping_now - 1)
            b.matching_now += 1  # in-flight on the matcher side from this
            # point — note: matching_now == "queued for matcher + actively
            # being matched". When matcher picks it up, mark_matching_started
            # doesn't bump it again (it's already counted here).
            slot = b.per_uc.get(use_case)
            if slot is not None:
                slot["cropping"] = max(0, slot["cropping"] - 1)
                slot["matching"] += 1

    def mark_matching_started(self, batch_id: str, use_case: str) -> None:
        # No-op for batch counters — matching_now was already incremented
        # at the cropping→matching handoff. This hook exists so per-stage
        # *stage* stats (separate from batch stats) can mark "matcher
        # picked it up". Kept for symmetry with the cropping hook.
        return None

    def mark_completed(self, batch_id: str, use_case: str) -> None:
        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            b.matching_now = max(0, b.matching_now - 1)
            b.completed_jobs += 1
            slot = b.per_uc.get(use_case)
            if slot is not None:
                slot["matching"] = max(0, slot["matching"] - 1)
                slot["completed"] += 1
            if (
                b.completed_jobs + b.failed_jobs + b.skipped_jobs
                >= b.total_jobs
                and b.completed_at is None
            ):
                b.completed_at = datetime.now(timezone.utc)

    def mark_failed(
        self,
        batch_id: str,
        use_case: str,
        *,
        stage: str,
    ) -> None:
        """``stage`` is 'cropping' or 'matching' so we decrement the
        right in-flight counter."""

        with self._lock:
            b = self._batches.get(batch_id)
            if b is None:
                return
            if stage == "cropping":
                b.cropping_now = max(0, b.cropping_now - 1)
                slot = b.per_uc.get(use_case)
                if slot is not None:
                    slot["cropping"] = max(0, slot["cropping"] - 1)
            elif stage == "matching":
                b.matching_now = max(0, b.matching_now - 1)
                slot = b.per_uc.get(use_case)
                if slot is not None:
                    slot["matching"] = max(0, slot["matching"] - 1)
            b.failed_jobs += 1
            slot = b.per_uc.get(use_case)
            if slot is not None:
                slot["failed"] += 1
            if (
                b.completed_jobs + b.failed_jobs + b.skipped_jobs
                >= b.total_jobs
                and b.completed_at is None
            ):
                b.completed_at = datetime.now(timezone.utc)

    # ---- snapshots --------------------------------------------------

    def snapshot(self, tenant_id: int) -> list[dict]:
        """Return every batch belonging to the tenant, newest first.

        ``remaining`` is derived = total - (completed + skipped + failed).
        """

        with self._lock:
            out: list[dict] = []
            for b in reversed(list(self._batches.values())):
                if b.tenant_id != tenant_id:
                    continue
                remaining = max(
                    0,
                    b.total_jobs
                    - b.completed_jobs
                    - b.skipped_jobs
                    - b.failed_jobs,
                )
                out.append(
                    {
                        "batch_id": b.batch_id,
                        "submitted_at": b.submitted_at.isoformat(),
                        "submitted_by_email": b.submitted_by_email,
                        "clip_ids": b.clip_ids,
                        "use_cases": b.use_cases,
                        "skip_existing": b.skip_existing,
                        "total_jobs": b.total_jobs,
                        "queued_jobs": b.queued_jobs,
                        "cropping_now": b.cropping_now,
                        "matching_now": b.matching_now,
                        "completed_jobs": b.completed_jobs,
                        "skipped_jobs": b.skipped_jobs,
                        "failed_jobs": b.failed_jobs,
                        "remaining_jobs": remaining,
                        "per_uc": dict(b.per_uc),
                        "completed_at": (
                            b.completed_at.isoformat()
                            if b.completed_at is not None
                            else None
                        ),
                    }
                )
            return out
