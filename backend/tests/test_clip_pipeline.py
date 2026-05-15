"""Unit tests for the clip-processing pipeline plumbing.

Covers the queue-based pipeline mechanics — ``StageQueue`` lifecycle,
``BatchTracker`` counter transitions, ``ClipPipeline.submit_batch``
fan-out + ``skip_existing`` filter, and the status snapshot shape.

The real cropping + matching handlers run against actual MP4 files
and InsightFace; those paths are exercised by the live verification
in ``docs/phases/`` instead of unit tests so the fast suite stays
hermetic.
"""

from __future__ import annotations

import threading
import time

import pytest

from maugood.clip_pipeline.batches import BatchTracker
from maugood.clip_pipeline.jobs import CropJob
from maugood.clip_pipeline.stage import StageQueue


# ---- StageQueue ------------------------------------------------------------


def test_stage_queue_starts_workers_and_drains_jobs():
    processed: list[int] = []
    done = threading.Event()
    target_count = 5

    def handler(payload: int) -> None:
        processed.append(payload)
        if len(processed) >= target_count:
            done.set()

    stage = StageQueue[int]("test", handler, worker_count=1, max_depth=16)
    stage.start()
    try:
        for i in range(target_count):
            assert stage.submit(i)
        # Wait for the worker to drain.
        assert done.wait(timeout=2.0), f"only processed {processed}"
        assert sorted(processed) == list(range(target_count))
        stats = stage.stats()
        assert stats.lifetime_processed == target_count
        assert stats.lifetime_failed == 0
    finally:
        stage.stop()


def test_stage_queue_records_failures_but_keeps_running():
    processed: list[int] = []
    done = threading.Event()

    def handler(payload: int) -> None:
        if payload < 0:
            raise RuntimeError("boom")
        processed.append(payload)
        if len(processed) >= 2:
            done.set()

    stage = StageQueue[int]("test-fail", handler, worker_count=1)
    stage.start()
    try:
        stage.submit(-1)  # → counts as failure
        stage.submit(1)
        stage.submit(2)
        assert done.wait(timeout=2.0)
        stats = stage.stats()
        assert stats.lifetime_processed == 2
        assert stats.lifetime_failed == 1
    finally:
        stage.stop()


def test_stage_queue_rejects_when_full():
    processed: list[int] = []
    block_release = threading.Event()

    def handler(payload: int) -> None:
        block_release.wait(timeout=2.0)
        processed.append(payload)

    stage = StageQueue[int]("test-cap", handler, worker_count=1, max_depth=2)
    stage.start()
    try:
        # First fills the worker slot, next two fill the queue.
        assert stage.submit(1)
        # Give the worker time to pick up #1.
        time.sleep(0.05)
        assert stage.submit(2)
        assert stage.submit(3)
        # Queue is now full → submit returns False, not raise.
        assert stage.submit(4) is False
    finally:
        block_release.set()
        stage.stop()


def test_stage_queue_stats_shape_for_observability():
    """The Pipeline Monitor reads stats() — make sure the keys it
    needs are always present even when nothing has run yet."""

    def handler(_: int) -> None:
        pass

    stage = StageQueue[int]("test-shape", handler, worker_count=2)
    stage.start()
    try:
        s = stage.stats()
        assert s.queue_depth == 0
        assert s.in_flight == 0
        assert s.lifetime_processed == 0
        assert s.lifetime_failed == 0
        assert len(s.workers) == 2
        for w in s.workers:
            assert {"name", "busy", "current_job", "running_for_s"} <= set(w.keys())
            assert w["busy"] is False
            assert w["current_job"] == ""
            assert w["running_for_s"] is None
    finally:
        stage.stop()


# ---- BatchTracker ----------------------------------------------------------


def test_batch_tracker_transitions_through_full_lifecycle():
    tracker = BatchTracker()
    batch = tracker.create(
        tenant_id=1,
        clip_ids=[100, 101],
        use_cases=["uc1", "uc3"],
        skip_existing=False,
        submitted_by_user_id=1,
        submitted_by_email="op@example.com",
    )
    # Fan-out: 2 clips × 2 UCs = 4 jobs. Caller marks each as submitted.
    for clip_id in [100, 101]:
        for uc in ["uc1", "uc3"]:
            tracker.mark_submitted(batch.batch_id, uc)
    snap = tracker.snapshot(tenant_id=1)[0]
    assert snap["total_jobs"] == 4
    assert snap["queued_jobs"] == 4
    assert snap["completed_jobs"] == 0
    assert snap["remaining_jobs"] == 4
    assert snap["per_uc"]["uc1"]["total"] == 2
    assert snap["per_uc"]["uc1"]["queued"] == 2

    # One job flows: queued → cropping → matching → completed.
    tracker.mark_cropping_started(batch.batch_id, "uc1")
    tracker.mark_cropping_finished_enqueue_match(batch.batch_id, "uc1")
    tracker.mark_matching_started(batch.batch_id, "uc1")
    tracker.mark_completed(batch.batch_id, "uc1")
    snap = tracker.snapshot(tenant_id=1)[0]
    assert snap["completed_jobs"] == 1
    assert snap["queued_jobs"] == 3  # the other 3 still waiting
    assert snap["cropping_now"] == 0
    assert snap["matching_now"] == 0
    assert snap["remaining_jobs"] == 3
    assert snap["per_uc"]["uc1"]["completed"] == 1

    # Skipped count never enters either queue.
    tracker.mark_skipped(batch.batch_id, "uc3")
    snap = tracker.snapshot(tenant_id=1)[0]
    assert snap["skipped_jobs"] == 1
    assert snap["total_jobs"] == 5  # skipped jobs count toward the total


def test_batch_tracker_marks_failure_at_correct_stage():
    tracker = BatchTracker()
    batch = tracker.create(
        tenant_id=2,
        clip_ids=[1],
        use_cases=["uc1"],
        skip_existing=False,
        submitted_by_user_id=None,
        submitted_by_email=None,
    )
    tracker.mark_submitted(batch.batch_id, "uc1")
    tracker.mark_cropping_started(batch.batch_id, "uc1")
    tracker.mark_failed(batch.batch_id, "uc1", stage="cropping")
    snap = tracker.snapshot(tenant_id=2)[0]
    assert snap["failed_jobs"] == 1
    assert snap["cropping_now"] == 0
    assert snap["remaining_jobs"] == 0  # 1 - (0 + 0 + 1) = 0


def test_batch_tracker_isolates_tenants():
    tracker = BatchTracker()
    tracker.create(
        tenant_id=1, clip_ids=[1], use_cases=["uc1"],
        skip_existing=False, submitted_by_user_id=None,
        submitted_by_email=None,
    )
    tracker.create(
        tenant_id=2, clip_ids=[2], use_cases=["uc1"],
        skip_existing=False, submitted_by_user_id=None,
        submitted_by_email=None,
    )
    assert len(tracker.snapshot(tenant_id=1)) == 1
    assert len(tracker.snapshot(tenant_id=2)) == 1
    # Cross-tenant — never see another tenant's batches.
    assert all(b["batch_id"] != tracker.snapshot(tenant_id=2)[0]["batch_id"]
               for b in tracker.snapshot(tenant_id=1))


# ---- Worker slot description for the UI -----------------------------------


def test_worker_slot_describes_current_clip_job():
    """The ``current_job`` string the UI renders for the active task
    pane comes from the job's clip_id + use_case attributes."""

    from maugood.clip_pipeline.stage import _describe_job
    from maugood.tenants.scope import TenantScope

    job = CropJob(
        job_id="abc",
        batch_id="def",
        clip_id=794,
        use_case="uc2",
        scope=TenantScope(tenant_id=1),
    )
    assert _describe_job(job) == "clip #794 · UC2"
    # Non-job-shaped objects fall back to the type name.
    assert _describe_job("nope") == "str"
