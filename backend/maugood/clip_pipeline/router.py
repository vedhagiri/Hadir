"""FastAPI router — ``/api/clip-pipeline/{submit,status}``.

Side-by-side with the legacy ``/api/person-clips/reprocess`` path; the
new endpoints are explicit so the frontend can wire the Pipeline
Monitor page to the queue/worker dashboard without disturbing the
existing Identify Event UI.

* ``POST /api/clip-pipeline/submit`` (Admin/HR) — kicks off a batch.
  Returns the batch id + initial counters; the queues swallow the
  work asynchronously.
* ``GET /api/clip-pipeline/status`` (Admin/HR) — Pipeline Monitor's
  polling endpoint. Returns stage queue depths, worker active tasks,
  and every batch belonging to the requesting tenant.
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.clip_pipeline.pipeline import clip_pipeline
from maugood.db import get_engine
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clip-pipeline", tags=["clip-pipeline"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


VALID_USE_CASES = ("uc1", "uc2", "uc3")


# ---- request / response shapes ----------------------------------------------


class SubmitRequest(BaseModel):
    clip_ids: list[int] = Field(min_length=1, max_length=10000)
    use_cases: list[str] = Field(min_length=1, max_length=3)
    skip_existing: bool = True


class SubmitResponse(BaseModel):
    batch_id: str
    total_jobs: int
    queued_jobs: int
    skipped_jobs: int


# ---- routes ----------------------------------------------------------------


@router.post("/submit", response_model=SubmitResponse)
def submit(
    body: SubmitRequest,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> SubmitResponse:
    # Validate use cases — fail fast, before anything hits the queue.
    bad = [uc for uc in body.use_cases if uc not in VALID_USE_CASES]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"unknown use_cases: {bad} (valid: {list(VALID_USE_CASES)})",
        )
    # De-dup while preserving submission order.
    use_cases: list[str] = []
    seen: set[str] = set()
    for uc in body.use_cases:
        if uc not in seen:
            seen.add(uc)
            use_cases.append(uc)

    # Resolve the schema for the worker's tenant_context wrap. The
    # request path's TenantScopeMiddleware has set the contextvar for
    # this thread but the cropping worker runs on its own thread, so
    # we explicitly capture the schema here.
    engine = get_engine()
    from maugood.tenants.scope import resolve_tenant_schema_via_engine  # noqa: PLC0415

    schema = resolve_tenant_schema_via_engine(engine, user.tenant_id)
    scope = TenantScope(tenant_id=user.tenant_id, tenant_schema=schema)

    if not clip_pipeline._started:  # type: ignore[attr-defined]  # noqa: SLF001
        # Defence in depth — start() is called from lifespan but if a
        # test client bypasses the lifespan we want a clean 503 rather
        # than a quiet hang.
        raise HTTPException(
            status_code=503,
            detail="clip_pipeline not running",
        )

    batch = clip_pipeline.submit_batch(
        scope=scope,
        clip_ids=body.clip_ids,
        use_cases=use_cases,
        skip_existing=body.skip_existing,
        submitted_by_user_id=user.id,
        submitted_by_email=user.email,
    )

    # Audit row — preserves the operator's intent (clip ids + UCs) so
    # an auditor can reconstruct what was queued without inspecting the
    # in-memory tracker.
    from maugood.db import tenant_context  # noqa: PLC0415

    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="clip_pipeline.batch_submitted",
                entity_type="clip_pipeline_batch",
                entity_id=batch.batch_id,
                after={
                    "clip_count": len(body.clip_ids),
                    "use_cases": use_cases,
                    "skip_existing": body.skip_existing,
                    "queued_jobs": batch.queued_jobs,
                    "skipped_jobs": batch.skipped_jobs,
                },
            )

    return SubmitResponse(
        batch_id=batch.batch_id,
        total_jobs=batch.total_jobs,
        queued_jobs=batch.queued_jobs,
        skipped_jobs=batch.skipped_jobs,
    )


@router.get("/status")
def status(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    batch_id: Optional[str] = None,
) -> dict:
    """Pipeline Monitor polling endpoint.

    ``batch_id`` filters the ``batches`` array to just that one (kept
    optional so the same endpoint serves both the dashboard wide view
    and a focused single-batch progress strip).
    """

    snap = clip_pipeline.status_snapshot(tenant_id=user.tenant_id)
    if batch_id is not None:
        snap["batches"] = [b for b in snap["batches"] if b["batch_id"] == batch_id]
    return snap


# ---- batch Identify Event (replaces the legacy reprocess-face-match path) ---


class SubmitAllRequest(BaseModel):
    """``Identify Event — overall process`` body. The server resolves
    the eligible clip set itself so the operator doesn't have to ship
    every id over the wire."""

    use_cases: list[str] = Field(min_length=1, max_length=3)
    skip_existing: bool = True


class SubmitAllResponse(BaseModel):
    batch_id: str
    total_clips: int
    total_jobs: int
    queued_jobs: int
    skipped_jobs: int
    deleted_prior: int


@router.post("/submit-all", response_model=SubmitAllResponse)
def submit_all(
    body: SubmitAllRequest,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> SubmitAllResponse:
    """Submit every completed clip in this tenant.

    * ``skip_existing=True`` (recommended)  — relies on
      ``ClipPipeline.submit_batch`` to pre-check
      ``clip_processing_results.status='completed'`` and skip those
      (clip, uc) pairs at submission time so they never enter the
      queue. Skipped jobs show on the batch tracker's
      ``skipped_jobs`` counter — the modal renders them so the
      operator sees how many were honored.
    * ``skip_existing=False`` (overwrite)  — pre-deletes every prior
      ``clip_processing_results`` row + ``face_crops`` row + fan-out
      ``detection_events`` row for the requested (clip, uc) tuples
      BEFORE submitting. This makes "Overwrite & reprocess" a
      genuinely-fresh run from the operator's perspective: the rows
      disappear from the table, then come back as the pipeline runs.
    """

    bad = [uc for uc in body.use_cases if uc not in VALID_USE_CASES]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"unknown use_cases: {bad} (valid: {list(VALID_USE_CASES)})",
        )
    use_cases: list[str] = []
    seen: set[str] = set()
    for uc in body.use_cases:
        if uc not in seen:
            seen.add(uc)
            use_cases.append(uc)

    if not clip_pipeline._started:  # type: ignore[attr-defined]  # noqa: SLF001
        raise HTTPException(
            status_code=503, detail="clip_pipeline not running",
        )

    engine = get_engine()
    from maugood.tenants.scope import (  # noqa: PLC0415
        resolve_tenant_schema_via_engine,
    )

    schema = resolve_tenant_schema_via_engine(engine, user.tenant_id)
    scope = TenantScope(tenant_id=user.tenant_id, tenant_schema=schema)

    from sqlalchemy import select, delete  # noqa: PLC0415

    from maugood.db import (  # noqa: PLC0415
        clip_processing_results,
        detection_events,
        face_crops,
        person_clips,
        tenant_context,
    )

    deleted_prior = 0
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            # Resolve every clip eligible for processing — completed
            # recordings only. Anything still recording/finalizing/
            # failed/abandoned is intentionally excluded.
            clip_rows = conn.execute(
                select(person_clips.c.id).where(
                    person_clips.c.tenant_id == scope.tenant_id,
                    person_clips.c.recording_status == "completed",
                    person_clips.c.file_path.is_not(None),
                )
            ).all()
            clip_ids = [int(r.id) for r in clip_rows]

            if clip_ids and not body.skip_existing:
                # Overwrite mode — wipe prior results for the
                # (clip, uc) tuples so the operator sees a fresh run.
                #
                # Order matters: detection_events references face_crops
                # via no FK, but cascading manually keeps the cleanup
                # honest. face_crops references person_clips via FK
                # (CASCADE on clip delete) but we delete face_crops
                # directly for the use_case filter.
                clip_track_filters = [
                    f"clip-{cid}-emp-%" for cid in clip_ids
                ]
                # ``track_id LIKE ANY(array[...])`` would be cleaner but
                # SQLAlchemy can't compose it in a way the JSONB DB
                # accepts uniformly — use a per-pattern OR.
                from sqlalchemy import or_  # noqa: PLC0415

                if clip_track_filters:
                    del_events = conn.execute(
                        delete(detection_events).where(
                            detection_events.c.tenant_id == scope.tenant_id,
                            or_(
                                *[
                                    detection_events.c.track_id.like(p)
                                    for p in clip_track_filters
                                ]
                            ),
                        )
                    )
                    deleted_prior += int(del_events.rowcount or 0)

                del_crops = conn.execute(
                    delete(face_crops).where(
                        face_crops.c.tenant_id == scope.tenant_id,
                        face_crops.c.person_clip_id.in_(clip_ids),
                        face_crops.c.use_case.in_(use_cases),
                    )
                )
                deleted_prior += int(del_crops.rowcount or 0)

                del_results = conn.execute(
                    delete(clip_processing_results).where(
                        clip_processing_results.c.tenant_id == scope.tenant_id,
                        clip_processing_results.c.person_clip_id.in_(clip_ids),
                        clip_processing_results.c.use_case.in_(use_cases),
                    )
                )
                deleted_prior += int(del_results.rowcount or 0)

    if not clip_ids:
        raise HTTPException(
            status_code=400,
            detail="No completed clips to process.",
        )

    batch = clip_pipeline.submit_batch(
        scope=scope,
        clip_ids=clip_ids,
        use_cases=use_cases,
        skip_existing=body.skip_existing,
        submitted_by_user_id=user.id,
        submitted_by_email=user.email,
    )

    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="clip_pipeline.batch_submit_all",
                entity_type="clip_pipeline_batch",
                entity_id=batch.batch_id,
                after={
                    "use_cases": use_cases,
                    "skip_existing": body.skip_existing,
                    "total_clips": len(clip_ids),
                    "queued_jobs": batch.queued_jobs,
                    "skipped_jobs": batch.skipped_jobs,
                    "deleted_prior_rows": deleted_prior,
                },
            )

    logger.info(
        "clip_pipeline submit-all: tenant=%s batch=%s clips=%d ucs=%s "
        "skip_existing=%s deleted_prior=%d queued=%d skipped=%d",
        scope.tenant_id, batch.batch_id, len(clip_ids), use_cases,
        body.skip_existing, deleted_prior, batch.queued_jobs,
        batch.skipped_jobs,
    )

    return SubmitAllResponse(
        batch_id=batch.batch_id,
        total_clips=len(clip_ids),
        total_jobs=batch.total_jobs,
        queued_jobs=batch.queued_jobs,
        skipped_jobs=batch.skipped_jobs,
        deleted_prior=deleted_prior,
    )
