"""Storage Analytics API.

Read-only aggregates over ``person_clips`` + ``face_crops`` plus an
Admin-only clip-video cleanup surface (migration 0069).

Endpoints:
  GET    /api/storage-analytics                    — Admin + HR
  POST   /api/storage-analytics/clip-cleanup/preview — Admin
  POST   /api/storage-analytics/clip-cleanup         — Admin
  GET    /api/storage-analytics/cleanup-history      — Admin
  GET    /api/storage-analytics/clip-retention       — Admin
  PATCH  /api/storage-analytics/clip-retention       — Admin
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import BigInteger, and_, cast, func, insert, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    require_any_role,
    require_role,
)
from maugood.db import audit_log, get_engine, tenant_settings, users
from maugood.storage_analytics.cleanup import (
    CLEANUP_CAP,
    CleanupFilterError,
    ClipCleanupFilter,
    get_clip_retention_days,
    get_daily_cleanup_config,
    preview_clip_cleanup,
    run_clip_cleanup,
)
from maugood.storage_analytics.repository import get_storage_analytics
from maugood.storage_analytics.schemas import (
    AutoDeleteSettingPatchRequest,
    AutoDeleteSettingResponse,
    CleanupHistoryEntry,
    CleanupHistoryResponse,
    ClipCleanupFilterBody,
    ClipCleanupPreviewResponse,
    ClipCleanupRunResponse,
    ClipRetentionSettingPatchRequest,
    ClipRetentionSettingResponse,
    CleanupCameraImpact,
    DailyCleanupSettingPatchRequest,
    DailyCleanupSettingResponse,
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
        Query(
            ge=0,
            le=3650,
            description=(
                "Lookback window in days (7 / 14 / 30 …). 0 = overall / all-time. "
                "Ignored when both 'start' and 'end' are supplied."
            ),
        ),
    ] = 30,
    start: Annotated[
        Optional[date],
        Query(description="Custom range start (YYYY-MM-DD, inclusive). Requires 'end'."),
    ] = None,
    end: Annotated[
        Optional[date],
        Query(description="Custom range end (YYYY-MM-DD, inclusive). Requires 'start'."),
    ] = None,
    camera_id: Annotated[
        Optional[int],
        Query(description="Restrict results to a single camera. Omit for all cameras."),
    ] = None,
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = HR_OR_ADMIN,
) -> StorageAnalyticsResponse:
    # Custom-range mode requires both bounds; reject a half-specified range
    # with a clean 400 rather than silently falling back to the day window.
    if (start is None) != (end is None):
        raise HTTPException(
            status_code=400,
            detail="custom range requires both 'start' and 'end'",
        )
    if start is not None and end is not None and start > end:
        raise HTTPException(
            status_code=400,
            detail="'start' must be on or before 'end'",
        )

    with get_engine().begin() as conn:
        return get_storage_analytics(
            conn, scope, days=days, start=start, end=end, camera_id=camera_id
        )


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


# ── Cleanup history ───────────────────────────────────────────────────────

# Manual UI cleanups + the nightly retention sweep both route through
# ``run_clip_cleanup``, which writes one ``clip_cleanup.executed`` audit row
# per batch — distinguished by whether ``actor_user_id`` is set.
_RUN_ACTION = "clip_cleanup.executed"
# The "auto-delete after processing" toggle writes one row per clip; these are
# aggregated by day so the table stays run-level rather than per-clip.
_AUTO_AFTER_ACTION = "clip_cleanup.auto_deleted_after_processing"


@router.get("/cleanup-history", response_model=CleanupHistoryResponse)
def cleanup_history(
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = ADMIN_ONLY,
) -> CleanupHistoryResponse:
    """Log of past clip-video cleanups, newest first.

    Sourced from the append-only ``audit_log`` — no separate history
    table. Three kinds appear interleaved by time:

    * ``manual`` / ``auto_retention`` — one entry per
      ``clip_cleanup.executed`` batch (operator-run vs. retention sweep).
    * ``auto_after_processing`` — the per-clip auto-delete rows, rolled
      up to one entry per calendar day (UTC).
    """

    entries: list[CleanupHistoryEntry] = []

    # Fetch the newest (limit + offset) of each source so the merged,
    # re-sorted slice [offset : offset + limit] is exact.
    fetch_n = limit + offset

    run_base = (
        select(
            audit_log.c.id,
            audit_log.c.created_at,
            audit_log.c.actor_user_id,
            users.c.email.label("actor_email"),
            audit_log.c.after,
        )
        .select_from(
            audit_log.outerjoin(
                users,
                and_(
                    users.c.id == audit_log.c.actor_user_id,
                    users.c.tenant_id == audit_log.c.tenant_id,
                ),
            )
        )
        .where(
            audit_log.c.tenant_id == scope.tenant_id,
            audit_log.c.action == _RUN_ACTION,
        )
    )

    # Per-day rollup of the per-clip auto-delete rows. ``filesize_bytes``
    # is only present on rows written after this feature shipped; older
    # rows coalesce to 0 (so historical days show a partial total).
    day = func.date_trunc("day", audit_log.c.created_at)
    auto_base = (
        select(
            func.max(audit_log.c.id).label("id"),
            func.max(audit_log.c.created_at).label("executed_at"),
            func.count().label("cnt"),
            func.coalesce(
                func.sum(
                    cast(audit_log.c.after["filesize_bytes"].astext, BigInteger)
                ),
                0,
            ).label("bytes_freed"),
        )
        .where(
            audit_log.c.tenant_id == scope.tenant_id,
            audit_log.c.action == _AUTO_AFTER_ACTION,
        )
        .group_by(day)
    )

    with get_engine().begin() as conn:
        run_total = int(
            conn.execute(
                select(func.count()).select_from(run_base.subquery())
            ).scalar_one()
        )
        auto_total = int(
            conn.execute(
                select(func.count()).select_from(auto_base.subquery())
            ).scalar_one()
        )
        run_rows = conn.execute(
            run_base.order_by(audit_log.c.id.desc()).limit(fetch_n)
        ).all()
        auto_rows = conn.execute(
            auto_base.order_by(func.max(audit_log.c.created_at).desc()).limit(
                fetch_n
            )
        ).all()

    for r in run_rows:
        after = r.after or {}
        filt = after.get("filter") or {}
        automatic = r.actor_user_id is None
        entries.append(
            CleanupHistoryEntry(
                id=int(r.id),
                kind="auto_retention" if automatic else "manual",
                executed_at=r.created_at,
                actor_user_id=(
                    int(r.actor_user_id) if r.actor_user_id is not None else None
                ),
                actor_email=(
                    str(r.actor_email) if r.actor_email is not None else None
                ),
                automatic=automatic,
                mode=filt.get("mode"),
                older_than_hours=filt.get("older_than_hours"),
                older_than_days=filt.get("older_than_days"),
                start_date=filt.get("start_date"),
                end_date=filt.get("end_date"),
                camera_id=filt.get("camera_id"),
                deleted_count=int(after.get("deleted_count") or 0),
                bytes_freed=int(after.get("bytes_freed") or 0),
                files_unlinked=int(after.get("files_unlinked") or 0),
                files_missing=int(after.get("files_missing") or 0),
                files_failed=int(after.get("files_failed") or 0),
            )
        )

    for a in auto_rows:
        entries.append(
            CleanupHistoryEntry(
                id=int(a.id),
                kind="auto_after_processing",
                executed_at=a.executed_at,
                actor_user_id=None,
                actor_email=None,
                automatic=True,
                deleted_count=int(a.cnt or 0),
                bytes_freed=int(a.bytes_freed or 0),
                files_unlinked=0,
                files_missing=0,
                files_failed=0,
            )
        )

    entries.sort(key=lambda e: e.executed_at, reverse=True)
    page = entries[offset : offset + limit]

    return CleanupHistoryResponse(
        items=page, total=run_total + auto_total, limit=limit, offset=offset
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


# ── Auto-delete after processing ──────────────────────────────────────────


@router.get("/auto-delete-setting", response_model=AutoDeleteSettingResponse)
def auto_delete_setting_get(
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = ADMIN_ONLY,
) -> AutoDeleteSettingResponse:
    with get_engine().begin() as conn:
        row = conn.execute(
            select(tenant_settings.c.auto_delete_clip_after_processing).where(
                tenant_settings.c.tenant_id == scope.tenant_id
            )
        ).first()
    enabled = bool(row.auto_delete_clip_after_processing) if row is not None else False
    return AutoDeleteSettingResponse(auto_delete_clip_after_processing=enabled)


@router.patch("/auto-delete-setting", response_model=AutoDeleteSettingResponse)
def auto_delete_setting_patch(
    payload: AutoDeleteSettingPatchRequest,
    scope: TenantScope = Depends(get_tenant_scope),
    user: CurrentUser = ADMIN_ONLY,
) -> AutoDeleteSettingResponse:
    new_value = payload.auto_delete_clip_after_processing
    with get_engine().begin() as conn:
        before_row = conn.execute(
            select(tenant_settings.c.auto_delete_clip_after_processing).where(
                tenant_settings.c.tenant_id == scope.tenant_id
            )
        ).first()
        if before_row is None:
            conn.execute(
                insert(tenant_settings).values(
                    tenant_id=scope.tenant_id,
                    auto_delete_clip_after_processing=new_value,
                )
            )
            previous = False
        else:
            previous = bool(before_row.auto_delete_clip_after_processing)
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == scope.tenant_id)
                .values(auto_delete_clip_after_processing=new_value)
            )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="clip_cleanup.auto_delete_setting_updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before={"auto_delete_clip_after_processing": previous},
            after={"auto_delete_clip_after_processing": new_value},
        )
    return AutoDeleteSettingResponse(auto_delete_clip_after_processing=new_value)


# ── Automatic daily clip cleanup (migration 0090) ─────────────────────────


@router.get("/daily-cleanup", response_model=DailyCleanupSettingResponse)
def daily_cleanup_get(
    scope: TenantScope = Depends(get_tenant_scope),
    _: CurrentUser = ADMIN_ONLY,
) -> DailyCleanupSettingResponse:
    with get_engine().begin() as conn:
        cfg = get_daily_cleanup_config(conn, scope)
    return DailyCleanupSettingResponse(
        enabled=cfg.enabled,
        cleanup_time=cfg.cleanup_time,
        last_run_on=cfg.last_run_on.isoformat() if cfg.last_run_on else None,
    )


@router.patch("/daily-cleanup", response_model=DailyCleanupSettingResponse)
def daily_cleanup_patch(
    payload: DailyCleanupSettingPatchRequest,
    scope: TenantScope = Depends(get_tenant_scope),
    user: CurrentUser = ADMIN_ONLY,
) -> DailyCleanupSettingResponse:
    """Enable/disable automatic daily clip cleanup + set the fire time.

    Changing the time resets ``last_run_on`` to NULL so a newly-set
    (earlier) time can fire the same day. Audited as
    ``clip_cleanup.daily_setting_updated``."""

    with get_engine().begin() as conn:
        before = conn.execute(
            select(
                tenant_settings.c.clip_daily_cleanup_enabled,
                tenant_settings.c.clip_daily_cleanup_time,
                tenant_settings.c.clip_daily_cleanup_last_run_on,
            ).where(tenant_settings.c.tenant_id == scope.tenant_id)
        ).first()

        prev_enabled = bool(before.clip_daily_cleanup_enabled) if before else False
        prev_time = str(before.clip_daily_cleanup_time) if before else "00:00"
        # A time change (or a fresh enable) clears the once-per-day guard
        # so the new schedule can act today.
        time_changed = prev_time != payload.cleanup_time
        new_last_run = (
            (before.clip_daily_cleanup_last_run_on if before else None)
            if not time_changed
            else None
        )

        values = {
            "clip_daily_cleanup_enabled": payload.enabled,
            "clip_daily_cleanup_time": payload.cleanup_time,
            "clip_daily_cleanup_last_run_on": new_last_run,
        }
        if before is None:
            conn.execute(
                insert(tenant_settings).values(
                    tenant_id=scope.tenant_id, **values
                )
            )
        else:
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == scope.tenant_id)
                .values(**values)
            )

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="clip_cleanup.daily_setting_updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before={"enabled": prev_enabled, "cleanup_time": prev_time},
            after={
                "enabled": payload.enabled,
                "cleanup_time": payload.cleanup_time,
            },
        )

    return DailyCleanupSettingResponse(
        enabled=payload.enabled,
        cleanup_time=payload.cleanup_time,
        last_run_on=new_last_run.isoformat() if new_last_run else None,
    )
