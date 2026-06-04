"""Tests for the single-knob UC1/UC2/UC3 enable/disable control.

``MAUGOOD_CLIP_PIPELINE_USE_CASES`` (CSV, default "uc1,uc2,uc3") is the
single source of truth for which clip-pipeline use cases run. A disabled
use case must run NOWHERE: not on auto-submit, not on the reconcile
resubmit, not on boot recovery, and the pipeline must not even spin up
its cropping worker stage.

These tests drive the parser helper directly + the ``submit_batch``
chokepoint with a stubbed crop handler (so no real InsightFace / MP4
work runs) and assert the queue fan-out honours the enabled set. The
module-level ``ENABLED_USE_CASES`` / ``ClipPipeline.UCS`` are reloaded
per-test via importlib so the env var change takes effect.
"""

from __future__ import annotations

import contextlib
import importlib

import pytest

import maugood.clip_pipeline.pipeline as pipeline_mod
from maugood.tenants.scope import TenantScope

# ---------------------------------------------------------------------------
# Parser helper — exercised directly so the parse rules are pinned.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Unset (None) → default all-on.
        (None, ("uc1", "uc2", "uc3")),
        # Explicit full set.
        ("uc1,uc2,uc3", ("uc1", "uc2", "uc3")),
        # Single UC.
        ("uc1", ("uc1",)),
        ("uc2", ("uc2",)),
        # Subset — order normalised to canonical uc1,uc2,uc3.
        ("uc3,uc1", ("uc1", "uc3")),
        # Whitespace + case tolerated.
        (" UC1 , Uc3 ", ("uc1", "uc3")),
        # Dupes deduped.
        ("uc1,uc1,uc2", ("uc1", "uc2")),
        # Invalid tokens dropped.
        ("uc1,uc9,bogus", ("uc1",)),
        # Empty string → no use cases run.
        ("", ()),
        # All-invalid → no use cases run.
        ("nope,xx", ()),
        ("  ,  ", ()),
    ],
)
def test_env_use_cases_parser(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", raising=False)
    else:
        monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", raw)
    got = pipeline_mod._env_use_cases(
        "MAUGOOD_CLIP_PIPELINE_USE_CASES", ("uc1", "uc2", "uc3")
    )
    assert got == expected


# ---------------------------------------------------------------------------
# submit_batch chokepoint + stage startup, per enabled set.
# ---------------------------------------------------------------------------


def _fresh_pipeline(monkeypatch, env_value):
    """Reload the pipeline module under the given env so ENABLED_USE_CASES
    + ClipPipeline.UCS recompute, then return a started pipeline whose
    crop handler is stubbed (records jobs instead of doing real work).
    """

    if env_value is None:
        monkeypatch.delenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", raising=False)
    else:
        monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", env_value)
    # Never spawn the boot-recovery thread in these tests.
    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY", "1")

    mod = importlib.reload(pipeline_mod)

    pipe = mod.ClipPipeline()
    seen: list[tuple[int, str]] = []

    def _stub_crop(job) -> None:
        seen.append((job.clip_id, job.use_case))

    # Replace the real cropping handler so no InsightFace / file IO runs.
    pipe._handle_crop = _stub_crop  # type: ignore[assignment]
    pipe.start()
    return mod, pipe, seen


_SCOPE = TenantScope(tenant_id=1, tenant_schema="main")


def test_only_uc1_enabled(monkeypatch):
    mod, pipe, _seen = _fresh_pipeline(monkeypatch, "uc1")
    try:
        assert mod.ENABLED_USE_CASES == ("uc1",)
        # Only the uc1 cropping stage exists.
        assert set(pipe._cropping_by_uc.keys()) == {"uc1"}

        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[101],
            use_cases=["uc1", "uc2", "uc3"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        # uc2/uc3 dropped at the chokepoint — one queued job (uc1).
        assert batch.queued_jobs == 1
        assert set(batch.per_uc.keys()) == {"uc1"}
    finally:
        pipe.stop()
        importlib.reload(pipeline_mod)


def test_uc1_and_uc3_enabled(monkeypatch):
    mod, pipe, _seen = _fresh_pipeline(monkeypatch, "uc1,uc3")
    try:
        assert mod.ENABLED_USE_CASES == ("uc1", "uc3")
        assert set(pipe._cropping_by_uc.keys()) == {"uc1", "uc3"}

        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[202],
            use_cases=["uc1", "uc2", "uc3"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        # uc2 dropped; uc1 + uc3 queue.
        assert batch.queued_jobs == 2
        assert set(batch.per_uc.keys()) == {"uc1", "uc3"}
    finally:
        pipe.stop()
        importlib.reload(pipeline_mod)


def test_empty_disables_everything(monkeypatch):
    mod, pipe, _seen = _fresh_pipeline(monkeypatch, "")
    try:
        assert mod.ENABLED_USE_CASES == ()
        # No cropping stages started.
        assert pipe._cropping_by_uc == {}
        # Matching stage still runs (clip-save path must not break).
        assert pipe._matching is not None

        # submit_batch is a clean no-op — no error, zero jobs queued.
        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[303],
            use_cases=["uc1", "uc2", "uc3"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        assert batch.queued_jobs == 0
        assert batch.per_uc == {}
    finally:
        pipe.stop()
        importlib.reload(pipeline_mod)


def test_default_unset_runs_all_three(monkeypatch):
    mod, pipe, _seen = _fresh_pipeline(monkeypatch, None)
    try:
        assert mod.ENABLED_USE_CASES == ("uc1", "uc2", "uc3")
        assert set(pipe._cropping_by_uc.keys()) == {"uc1", "uc2", "uc3"}

        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[404],
            use_cases=["uc1", "uc2", "uc3"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        assert batch.queued_jobs == 3
        assert set(batch.per_uc.keys()) == {"uc1", "uc2", "uc3"}
    finally:
        pipe.stop()
        importlib.reload(pipeline_mod)


# ---------------------------------------------------------------------------
# Recovery skips a disabled UC's stuck row.
# ---------------------------------------------------------------------------


def test_recovery_skips_disabled_use_case(monkeypatch):
    """``run_recovery`` must not claim / enqueue a decision whose UC is
    disabled. We stub tenant discovery + the validator so no DB is hit,
    feeding one uc1 (disabled) and one uc3 (enabled) Class-C decision.
    """

    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", "uc3")
    importlib.reload(pipeline_mod)

    import maugood.clip_pipeline.recovery as recovery_mod
    importlib.reload(recovery_mod)

    from maugood.clip_pipeline.recovery import RecoveryDecision

    def _decision(uc):
        return RecoveryDecision(
            tenant_id=1,
            tenant_schema="main",
            clip_id=1,
            use_case=uc,
            klass="C",
            reason="test",
            artifact_count=0,
            artifact_disk_ok=None,
            recovery_attempts_before=0,
            recovery_attempts_after=0,
        )

    monkeypatch.setattr(
        recovery_mod, "discover_active_tenants", lambda: [(1, "main")]
    )
    monkeypatch.setattr(
        recovery_mod,
        "validate_stuck_jobs",
        lambda **kw: [_decision("uc1"), _decision("uc3")],
    )
    # tenant_context is a context manager around DB scope — neutralise it.
    monkeypatch.setattr(
        recovery_mod,
        "tenant_context",
        lambda *_a, **_k: contextlib.nullcontext(),
    )
    # claim succeeds for whatever reaches it.
    monkeypatch.setattr(
        recovery_mod, "claim_for_recovery", lambda **kw: 1
    )
    monkeypatch.setattr(
        recovery_mod, "delete_partial_artifacts", lambda **kw: 0
    )
    monkeypatch.setattr(
        recovery_mod, "write_recovery_audit", lambda **kw: None
    )

    enqueued_c: list[str] = []

    summary = recovery_mod.run_recovery(
        enqueue_class_b=lambda d: None,
        enqueue_class_c=lambda d: enqueued_c.append(d.use_case),
    )

    # uc1 (disabled) skipped entirely; only uc3 enqueued for restart.
    assert enqueued_c == ["uc3"]
    assert summary.class_c == 1
    assert summary.skipped == 1

    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", "uc1,uc2,uc3")
    importlib.reload(pipeline_mod)
    importlib.reload(recovery_mod)
