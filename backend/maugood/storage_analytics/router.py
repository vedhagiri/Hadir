"""Storage Analytics API.

Read-only aggregates over ``person_clips`` + ``face_crops`` plus an
Admin-only clip-video cleanup surface (migration 0069).

Endpoints:
  GET    /api/storage-analytics                    — Admin + HR
  POST   /api/storage-analytics/clip-cleanup/preview — Admin
  POST   /api/storage-analytics/clip-cleanup         — Admin
  GET    /api/storage-analytics/clip-retention       — Admin
  PATCH  /api/storage-analytics/clip-retention       — Admin
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import insert, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    require_any_role,
    require_role,
)
from maugood.db import get_engine, tenant_settings
from maugood.storage_analytics.cleanup import (
    CLEANUP_CAP,
    CleanupFilterError,
    ClipCleanupFilter,
    get_clip_retention_days,
    preview_clip_cleanup,
    run_clip_cleanup,
)
from maugood.storage_analytics.repository import get_storage_analytics
from maugood.storage_analytics.schemas import (
    ClipCleanupFilterBody,
    ClipCleanupPreviewResponse,
    ClipCleanupRunResponse,
    ClipRetentionSettingPatchRequest,
    ClipRetentionSettingResponse,
    CleanupCameraImpact,
    StorageAnalyticsResponse,
)
from maugood.tenants.scope import TenantScope, get_tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/storage-analytics", tags=["storage-analytics"])

HR_OR_ADMIN = Depends(require_any_role("Admin", "HR"))
ADMIN_ONLY = Depends(require_role("Admin"))


def _to_filter(body: ClipCleanupFilterBody) -> ClipCleanupFilter:
    return ClipCleanupFilter(
        older_than_hours=body.older_than_hours,
        older_than_days=body.older_than_days,
        start_date=body.start_date,
        end_date=body.end_date,
        camera_id=body.camera_id,
    )


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


# ── Clip cleanup ──────────────────────────────────────────────────────────


@router.post(
    "/clip-cleanup/preview", response_model=ClipCleanupPreviewResponse
)
def clip_cleanup_preview(
    body: ClipCleanupFilterBody,
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = ADMIN_ONLY,
) -> ClipCleanupPreviewResponse:
    """Aggregate the impact of a hypothetical cleanup without touching
    anything. Used by the confirmation modal."""

    filt = _to_filter(body)
    with get_engine().begin() as conn:
        try:
            preview = preview_clip_cleanup(conn, scope, filt)
        except CleanupFilterError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ClipCleanupPreviewResponse(
        clip_count=preview.clip_count,
        total_bytes=preview.total_bytes,
        oldest_clip_at=(
            preview.oldest_clip_at.isoformat()
            if preview.oldest_clip_at is not None
            else None
        ),
        newest_clip_at=(
            preview.newest_clip_at.isoformat()
            if preview.newest_clip_at is not None
            else None
        ),
        by_camera=[
            CleanupCameraImpact(
                camera_id=row.camera_id,
                camera_name=row.camera_name,
                clip_count=row.clip_count,
                total_bytes=row.total_bytes,
            )
            for row in preview.by_camera
        ],
        capped=preview.capped,
        cap=CLEANUP_CAP,
    )


@router.post("/clip-cleanup", response_model=ClipCleanupRunResponse)
def clip_cleanup_execute(
    body: ClipCleanupFilterBody,
    scope: TenantScope = Depends(get_tenant_scope),
    user: CurrentUser = ADMIN_ONLY,
) -> ClipCleanupRunResponse:
    """Soft-clear up to ``CLEANUP_CAP`` matching clips in one call.

    The frontend loops the call until ``has_more`` is false. Each
    call writes one ``clip_cleanup.executed`` audit row carrying
    the filter shape + the deletion counts.
    """

    filt = _to_filter(body)
    with get_engine().begin() as conn:
        try:
            result = run_clip_cleanup(
                conn, scope, filt, actor_user_id=user.id
            )
        except CleanupFilterError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ClipCleanupRunResponse(
        deleted_count=result.deleted_count,
        bytes_freed=result.bytes_freed,
        files_unlinked=result.files_unlinked,
        files_missing=result.files_missing,
        files_failed=result.files_failed,
        has_more=result.has_more,
    )


# ── Auto-retention setting ────────────────────────────────────────────────


@router.get("/clip-retention", response_model=ClipRetentionSettingResponse)
def clip_retention_get(
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = ADMIN_ONLY,
) -> ClipRetentionSettingResponse:
    with get_engine().begin() as conn:
        days = get_clip_retention_days(conn, scope)
    return ClipRetentionSettingResponse(clip_retention_days=days)


@router.patch("/clip-retention", response_model=ClipRetentionSettingResponse)
def clip_retention_patch(
    payload: ClipRetentionSettingPatchRequest,
    scope: TenantScope = Depends(get_tenant_scope),
    user: CurrentUser = ADMIN_ONLY,
) -> ClipRetentionSettingResponse:
    """Toggle / set the per-tenant auto-cleanup threshold (NULL = off).

    Audited as ``clip_cleanup.retention_updated`` so the policy
    change is verifiable."""

    new_value = payload.clip_retention_days
    with get_engine().begin() as conn:
        before = conn.execute(
            select(tenant_settings.c.clip_retention_days).where(
                tenant_settings.c.tenant_id == scope.tenant_id
            )
        ).first()
        if before is None:
            # Lazy-create the row with the new value, matching the
            # pattern from leave_calendar.router.get_tenant_settings.
            conn.execute(
                insert(tenant_settings).values(
                    tenant_id=scope.tenant_id,
                    clip_retention_days=new_value,
                )
            )
            previous = None
        else:
            previous = before.clip_retention_days
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == scope.tenant_id)
                .values(clip_retention_days=new_value)
            )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="clip_cleanup.retention_updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before={"clip_retention_days": previous},
            after={"clip_retention_days": new_value},
        )

    return ClipRetentionSettingResponse(clip_retention_days=new_value)
