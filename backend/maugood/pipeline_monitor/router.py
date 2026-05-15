"""FastAPI router — unified Pipeline Monitor endpoint.

``GET /api/pipeline-monitor/workers`` (Admin/HR). The frontend polls
this every 1-2 s and renders one table grouped by category. All
columns the dashboard needs — including health + speed metrics —
come from a single round-trip.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.pipeline_monitor.aggregator import build_snapshot

router = APIRouter(prefix="/api/pipeline-monitor", tags=["pipeline-monitor"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


@router.get("/workers")
def workers(user: Annotated[CurrentUser, ADMIN_OR_HR]) -> dict:
    return build_snapshot(tenant_id=user.tenant_id)
