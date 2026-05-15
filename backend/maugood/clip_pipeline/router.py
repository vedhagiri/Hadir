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
