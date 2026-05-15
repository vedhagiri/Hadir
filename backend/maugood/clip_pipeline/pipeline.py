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


class ClipPipeline:
    """Process-wide singleton — see module docstring."""

    # Valid UCs each get their own cropping queue + worker so the
    # Pipeline Monitor table can show 3 independent rows (UC1, UC2,
    # UC3 cropping). They still serialise on the InsightFace detector
    # lock under the hood, but the per-UC visibility + tracking is
    # the goal here, not raw parallelism (see the architecture
    # confirmation conversation).
    UCS: tuple[str, ...] = ("uc1", "uc2", "uc3")

    def __init__(self) -> None:
        self._started = False
        self._lock = threading.Lock()
        self._tracker = BatchTracker()
        # Stages constructed in start() so the handlers can close over
        # ``self`` without circular reference at module import time.
        self._cropping_by_uc: dict[str, StageQueue[CropJob]] = {}
        self._matching: Optional[StageQueue[MatchJob]] = None

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

        if not self._started or not self._cropping_by_uc:
            raise RuntimeError("clip_pipeline not started")

        batch = self._tracker.create(
            tenant_id=scope.tenant_id,
            clip_ids=clip_ids,
            use_cases=use_cases,
            skip_existing=skip_existing,
            submitted_by_user_id=submitted_by_user_id,
            submitted_by_email=submitted_by_email,
        )

        # Pre-load existing (clip, uc) completion state in one query so
        # skip_existing doesn't fan out into N SELECTs.
        existing: set[tuple[int, str]] = set()
        if skip_existing and clip_ids and use_cases:
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
                            clip_processing_results.c.use_case.in_(use_cases),
                            clip_processing_results.c.status == "completed",
                        )
                    ).all()
            existing = {(int(r[0]), str(r[1])) for r in rows}

        for clip_id in clip_ids:
            for uc in use_cases:
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
            use_cases,
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
                "workers": s.workers if s else [],
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
                "workers": match_stats.workers if match_stats else [],
            },
            "batches": self._tracker.snapshot(tenant_id),
            "config": {
                "cropping_workers_per_uc": CROPPING_WORKERS,
                "matching_workers": MATCHING_WORKERS,
                "queue_max_depth": QUEUE_MAX_DEPTH,
                "ucs": list(self.UCS),
            },
        }

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
                        "frames": frames,
                        "t_total_start": t_total_start,
                    },
                    crop_match_index=crop_match_index,
                    initial_face_crop_count=initial_count,
                )

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
            _match_detections,
            _resolve_employee_names,
            _save_face_crops_to_db,
            _save_face_crops_uc2_best_per_track,
            _upsert_processing_result,
        )

        self._tracker.mark_matching_started(job.batch_id, job.use_case)
        job.started_at = time.time()
        scope = job.scope
        engine = get_engine()

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
                    # the matched ones now.
                    _backfill_crop_matches(
                        engine, scope, job.crop_match_index, det_employee_map
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
