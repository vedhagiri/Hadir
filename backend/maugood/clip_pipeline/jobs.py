"""Job records flowing through the two-stage pipeline."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from maugood.tenants.scope import TenantScope


@dataclass
class CropJob:
    """First-stage job: load the clip + run detection + save crops.

    The cropping worker takes this, decodes the MP4, runs the per-UC
    detector, writes face_crops rows (employee_id=NULL), and emits a
    ``MatchJob`` carrying the in-memory ``frame_results`` so the
    matcher doesn't have to re-run detection.
    """

    job_id: str
    batch_id: str
    clip_id: int
    use_case: str
    scope: TenantScope
    submitted_at: float = field(default_factory=time.time)
    # Set when the worker picks the job up; used for queue-wait stats.
    started_at: Optional[float] = None


@dataclass
class MatchJob:
    """Second-stage job: match the just-extracted crops + finalise the
    clip_processing_results row.

    Carries the in-memory ``frame_results`` (list of per-frame detection
    dicts with embeddings) produced by the cropping stage, plus the
    sampling metadata needed by ``_save_face_crops_*`` / backfill paths.
    The matcher then runs ``_match_detections`` against the matcher
    cache and either backfills the just-saved face_crops (UC1 path) or
    saves the best-per-track crops with employee_id baked in (UC2/UC3
    parity with the existing ``_process_clip_for_use_case``).
    """

    job_id: str
    batch_id: str
    clip_id: int
    use_case: str
    scope: TenantScope
    submitted_at: float
    cropping_started_at: float
    cropping_ended_at: float
    # Payload from the cropping stage. Kept in-memory only — never
    # persisted; an in-flight job that survives a process restart
    # would lose this and re-submit from the operator.
    frame_results: list[dict[str, Any]]
    frames_meta: dict[str, Any]
    extract_seconds: float
    clip_meta: dict[str, Any]
    # The face_crops index returned by ``_save_face_crops_to_db`` for
    # UC1 — needed for the backfill step. Empty dict for UC2 / UC3 where
    # the crops are saved AFTER matching.
    crop_match_index: dict[tuple[int, int], int] = field(default_factory=dict)
    initial_face_crop_count: int = 0
    started_at: Optional[float] = None


# A submission is one operator click; expands to N (clip × use_case)
# jobs that share a ``batch_id`` so the Pipeline Monitor can roll up
# per-batch totals (selected / completed / skipped / remaining).
@dataclass
class BatchSubmission:
    batch_id: str
    tenant_id: int
    clip_ids: list[int]
    use_cases: list[str]
    skip_existing: bool
    submitted_at: datetime
    submitted_by_user_id: Optional[int]
    submitted_by_email: Optional[str]
    # Counts. Mutated by the stage workers under the pipeline lock.
    total_jobs: int = 0
    queued_jobs: int = 0
    cropping_now: int = 0
    matching_now: int = 0
    completed_jobs: int = 0
    skipped_jobs: int = 0
    failed_jobs: int = 0
    # Per-use-case totals — same fields, scoped to one UC. The frontend
    # uses these for the per-UC progress strips.
    per_uc: dict[str, dict[str, int]] = field(default_factory=dict)
    completed_at: Optional[datetime] = None
