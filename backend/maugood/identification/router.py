"""FastAPI router for ``/api/identification/*`` — Admin only."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.db import get_engine
from maugood.identification import enrollment
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/identification", tags=["identification"])

ADMIN = Depends(require_role("Admin"))


class ReembedResult(BaseModel):
    enrolled: int
    skipped: int
    errors: int


@router.post("/reembed", response_model=ReembedResult)
def reembed_endpoint(user: Annotated[CurrentUser, ADMIN]) -> ReembedResult:
    """Clear every enrolled embedding and recompute them from the stored photos.

    Use after a model upgrade or when tuning the recogniser. Synchronous
    in the pilot — on large tenants this can take a few minutes. v1.0
    moves this onto a background job with progress reporting.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    result = enrollment.reembed_all(get_engine(), scope)

    engine = get_engine()
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="identification.reembedded",
            entity_type="tenant",
            after={
                "enrolled": result.enrolled,
                "skipped": result.skipped,
                "errors": result.errors,
            },
        )
    logger.info(
        "identification reembed done: enrolled=%d skipped=%d errors=%d",
        result.enrolled,
        result.skipped,
        result.errors,
    )
    return ReembedResult(
        enrolled=result.enrolled, skipped=result.skipped, errors=result.errors
    )
