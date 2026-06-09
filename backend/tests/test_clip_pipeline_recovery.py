"""Unit tests for the boot-time recovery classifier in
``maugood/clip_pipeline/recovery.py``.

These are pure-function tests — no Postgres, no real face_crops on
disk. The classifier takes a duck-typed row (only the column attributes
it reads), so a SimpleNamespace stand-in is enough to assert every
branch of the validation pipeline.

Coverage:

* Class 0 (failed_cap) — over the attempts cap.
* Class A — match_duration_ms + matched_employees populated.
* Class B — UC1 with face_extract_duration_ms set, crops on disk OK.
* Class C — five distinct sub-cases all decided correctly:
    - no face_crops rows at all
    - face_crops present but cropping stage didn't commit duration
    - non-UC1 / UC2 (intermixed crops; unsafe to reuse)
    - face_crops present, disk files missing
    - face_crops present, disk files empty (size 0)
"""

from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path

import pytest

from maugood.clip_pipeline import recovery


def _make_row(
    *,
    clip_id: int = 100,
    use_case: str = "uc1",
    face_extract_duration_ms=None,
    match_duration_ms=None,
    matched_employees=None,
    face_crop_count: int = 0,
    recovery_attempts: int = 0,
):
    """Minimal duck-typed stand-in for the sa.Row the classifier reads."""

    return SimpleNamespace(
        id=clip_id * 1000,
        person_clip_id=clip_id,
        use_case=use_case,
        status="processing",
        started_at=None,
        face_extract_duration_ms=face_extract_duration_ms,
        match_duration_ms=match_duration_ms,
        matched_employees=matched_employees if matched_employees is not None else [],
        face_crop_count=face_crop_count,
        recovery_attempts=recovery_attempts,
    )


# ---------------------------------------------------------------------------
# Class A: already complete
# ---------------------------------------------------------------------------


def test_class_a_when_match_complete_and_matched_employees_populated():
    row = _make_row(
        match_duration_ms=1234,
        matched_employees=[42, 43],
        face_extract_duration_ms=5678,
        face_crop_count=4,
    )
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=4,
        sample_paths=[],
    )
    assert decision.klass == "A"
    assert decision.recovery_attempts_after == 0


def test_class_a_accepts_completed_run_with_zero_crops():
    """A clip with no detected faces still legitimately completes
    matching — match_duration_ms is set, matched_employees stays [].
    The classifier accepts this rather than treating it as suspect."""

    row = _make_row(
        match_duration_ms=10,
        matched_employees=[],
        face_extract_duration_ms=15,
        face_crop_count=0,
    )
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=0,
        sample_paths=[],
    )
    # The implementation requires matched_employees to be a list (which
    # it is, just empty). _row_is_class_a returns True for any list,
    # and Check 2 only triggers when status NOT class A. So this should
    # be Class A.
    assert decision.klass == "A"


# ---------------------------------------------------------------------------
# Class 0: failed_cap
# ---------------------------------------------------------------------------


def test_failed_cap_when_recovery_attempts_exceeds_max():
    row = _make_row(recovery_attempts=recovery.MAX_RECOVERY_ATTEMPTS)
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=0,
        sample_paths=[],
    )
    assert decision.klass == "failed_cap"


def test_failed_cap_wins_over_class_a_even_if_match_finished():
    """A row that exceeded the cap MUST NOT silently flip to completed
    — operator visibility matters more than automatic cleanup."""

    row = _make_row(
        match_duration_ms=1234,
        matched_employees=[42],
        recovery_attempts=recovery.MAX_RECOVERY_ATTEMPTS,
    )
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=5,
        sample_paths=[],
    )
    assert decision.klass == "failed_cap"


# ---------------------------------------------------------------------------
# Class C: stuck before cropping wrote anything
# ---------------------------------------------------------------------------


def test_class_c_when_no_face_crops_yet():
    """The headline user-requirement case: processing started but
    cropping never even wrote a crop row. Must NOT match-only resume."""

    row = _make_row(face_extract_duration_ms=None, face_crop_count=0)
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=0,  # zero rows in face_crops
        sample_paths=[],
    )
    assert decision.klass == "C"
    assert "cropping never wrote artifacts" in decision.reason


# ---------------------------------------------------------------------------
# Class C: partial crops — stage didn't commit
# ---------------------------------------------------------------------------


def test_class_c_when_crops_exist_but_extract_duration_null():
    """face_crops rows wrote but stage died before face_extract_duration_ms
    landed → partial set, untrustworthy."""

    row = _make_row(face_extract_duration_ms=None)
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=7,
        sample_paths=[],
    )
    assert decision.klass == "C"
    assert "didn't commit" in decision.reason


# ---------------------------------------------------------------------------
# Class C: non-UC1 (UC2) intermixed crops
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("uc", ["uc2"])
def test_class_c_for_non_uc1_even_with_clean_state(uc, tmp_path):
    crop = tmp_path / "crop.jpg"
    crop.write_bytes(b"\xff\xd8\xff" + b"x" * 64)
    row = _make_row(
        use_case=uc,
        face_extract_duration_ms=42,
    )
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=3,
        sample_paths=[str(crop)],
    )
    assert decision.klass == "C"
    # Non-UC1 crops are written during matching → always unsafe to reuse.
    assert "interleaved with matching" in decision.reason


# ---------------------------------------------------------------------------
# Class C: disk corruption
# ---------------------------------------------------------------------------


def test_class_c_when_disk_files_missing(tmp_path):
    missing = tmp_path / "ghost.jpg"  # never created
    row = _make_row(face_extract_duration_ms=42)
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=5,
        sample_paths=[str(missing)],
    )
    assert decision.klass == "C"
    assert decision.artifact_disk_ok is False
    assert "disk files missing" in decision.reason


def test_class_c_when_disk_file_empty(tmp_path):
    empty = tmp_path / "empty.jpg"
    empty.write_bytes(b"")
    row = _make_row(face_extract_duration_ms=42)
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=1,
        sample_paths=[str(empty)],
    )
    assert decision.klass == "C"
    assert decision.artifact_disk_ok is False


# ---------------------------------------------------------------------------
# Class B: matching-only resume
# ---------------------------------------------------------------------------


def test_class_b_when_uc1_crops_intact_on_disk(tmp_path):
    crop1 = tmp_path / "crop1.jpg"
    crop1.write_bytes(b"\xff\xd8\xff" + b"x" * 64)
    crop2 = tmp_path / "crop2.jpg"
    crop2.write_bytes(b"\xff\xd8\xff" + b"y" * 64)
    row = _make_row(face_extract_duration_ms=42)  # uc1 by default
    decision = recovery._classify_row(
        row,
        tenant_id=1,
        tenant_schema="public",
        artifact_count=2,
        sample_paths=[str(crop1), str(crop2)],
    )
    assert decision.klass == "B"
    assert decision.artifact_disk_ok is True


# ---------------------------------------------------------------------------
# Sample-disk helper
# ---------------------------------------------------------------------------


def test_sample_disk_artifacts_returns_false_for_empty_list():
    assert recovery._sample_disk_artifacts([]) is False


def test_sample_disk_artifacts_returns_true_when_all_samples_present(tmp_path):
    paths = []
    for i in range(3):
        p = tmp_path / f"f{i}.jpg"
        p.write_bytes(b"\xff\xd8\xff" + b"x" * 32)
        paths.append(str(p))
    assert recovery._sample_disk_artifacts(paths, 3) is True


def test_sample_disk_artifacts_returns_false_on_first_missing(tmp_path):
    ok = tmp_path / "ok.jpg"
    ok.write_bytes(b"data" * 32)
    paths = [str(tmp_path / "ghost.jpg"), str(ok)]
    # Even though ok exists, the missing first sample should short-circuit.
    assert recovery._sample_disk_artifacts(paths, 2) is False


# ---------------------------------------------------------------------------
# RecoveryDecision class_label mapping
# ---------------------------------------------------------------------------


def test_recover_now_returns_not_started_when_pipeline_idle():
    """Calling ``recover_now`` on a fresh, unstarted pipeline must NOT
    spawn a thread or attempt any DB work — it just reports the
    pipeline isn't running. Mirrors the early-return guard in
    ``ClipPipeline.recover_now``."""

    from maugood.clip_pipeline.pipeline import ClipPipeline

    p = ClipPipeline()
    assert p._started is False  # type: ignore[attr-defined]
    result = p.recover_now(blocking=True)
    assert result == {"triggered": False, "reason": "pipeline not started"}


def test_recover_now_blocks_double_concurrent_calls():
    """When a recovery sweep is already in flight, a second ``recover_now``
    call must return ``triggered=False`` rather than spawning a parallel
    sweep. Simulated by flipping the in-flight guard directly — same
    state the deferred recovery thread leaves while it's running."""

    from maugood.clip_pipeline.pipeline import ClipPipeline

    p = ClipPipeline()
    p._started = True  # type: ignore[attr-defined]
    p._recovery_in_flight = True  # type: ignore[attr-defined]

    result = p.recover_now(blocking=False)
    assert result == {
        "triggered": False,
        "reason": "recovery already in flight",
    }


def test_class_label_mapping_covers_all_classes():
    for klass, label in [
        ("A", "completed_mislabelled"),
        ("B", "match_only_resume"),
        ("C", "full_restart"),
        ("failed_cap", "failed_recovery_cap"),
        ("noop", "noop"),
    ]:
        d = recovery.RecoveryDecision(
            tenant_id=1,
            tenant_schema=None,
            clip_id=1,
            use_case="uc1",
            klass=klass,
            reason="",
            artifact_count=0,
            artifact_disk_ok=None,
            recovery_attempts_before=0,
            recovery_attempts_after=0,
        )
        assert d.class_label == label
