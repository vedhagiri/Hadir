"""Storage Analytics API — read-only aggregates.

GET /api/storage-analytics
  Available to Admin and HR.  Returns per-clip + per-face-crop aggregate
  statistics for the requesting tenant, optionally scoped to a date window
  and a single camera.
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query

from maugood.auth.dependencies import CurrentUser, current_user, require_any_role
from maugood.db import get_engine
from maugood.storage_analytics.repository import get_storage_analytics
from maugood.storage_analytics.schemas import StorageAnalyticsResponse
from maugood.tenants.scope import TenantScope, get_tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/storage-analytics", tags=["storage-analytics"])

HR_OR_ADMIN = Depends(require_any_role("Admin", "HR"))


@router.get("", response_model=StorageAnalyticsResponse)
def analytics(
    days: Annotated[
        int,
        Query(ge=7, le=365, description="Lookback window in days (7 / 14 / 30 / 90 / 365)."),
    ] = 30,
    camera_id: Annotated[
        Optional[int],
        Query(description="Restrict results to a single camera. Omit for all cameras."),
    ] = None,
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = HR_OR_ADMIN,
) -> StorageAnalyticsResponse:
    with get_engine().begin() as conn:
        return get_storage_analytics(conn, scope, days=days, camera_id=camera_id)
