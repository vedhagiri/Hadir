"""Database queries for storage analytics.

All queries are read-only aggregates over ``person_clips`` and ``face_crops``
scoped to the requesting tenant.  No tables are written; no audit rows are
emitted (read-only analytics surface).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import case, func, select
from sqlalchemy.engine import Connection

from maugood.db import cameras, face_crops, person_clips
from maugood.storage_analytics.schemas import (
    CameraStorageRow,
    DailyStorageRow,
    StorageAnalyticsResponse,
    StorageOverview,
)
from maugood.tenants.scope import TenantScope


def get_storage_analytics(
    conn: Connection,
    scope: TenantScope,
    *,
    days: int = 30,
    camera_id: Optional[int] = None,
) -> StorageAnalyticsResponse:
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)

    overview = _overview(conn, scope, cutoff, camera_id)
    by_camera = _by_camera(conn, scope, cutoff, camera_id)
    daily = _daily(conn, scope, cutoff, camera_id)

    return StorageAnalyticsResponse(
        overview=overview,
        by_camera=by_camera,
        daily=daily,
        days_window=days,
        camera_id_filter=camera_id,
    )


def _overview(
    conn: Connection,
    scope: TenantScope,
    cutoff: datetime,
    camera_id: Optional[int],
) -> StorageOverview:
    # ── Clip aggregate ────────────────────────────────────────────────────────
    clip_stmt = select(
        func.count().label("total_clips"),
        func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label("total_bytes"),
        func.avg(person_clips.c.duration_seconds).label("avg_clip_duration_sec"),
        func.count()
        .filter(person_clips.c.matched_status == "pending")
        .label("pending_clips"),
        func.count()
        .filter(person_clips.c.matched_status == "processing")
        .label("processing_clips"),
        func.count()
        .filter(person_clips.c.matched_status == "processed")
        .label("completed_clips"),
        func.count()
        .filter(person_clips.c.matched_status == "failed")
        .label("failed_clips"),
        func.count()
        .filter(person_clips.c.recording_status == "recording")
        .label("recording_clips"),
    ).where(
        person_clips.c.tenant_id == scope.tenant_id,
        person_clips.c.created_at >= cutoff,
    )
    if camera_id is not None:
        clip_stmt = clip_stmt.where(person_clips.c.camera_id == camera_id)
    clip_row = conn.execute(clip_stmt).one()

    # ── Face crop aggregate ───────────────────────────────────────────────────
    crop_stmt = select(
        func.count().label("total_face_crops"),
        func.count()
        .filter(face_crops.c.employee_id.isnot(None))
        .label("matched_face_crops"),
    ).where(
        face_crops.c.tenant_id == scope.tenant_id,
        face_crops.c.created_at >= cutoff,
    )
    if camera_id is not None:
        crop_stmt = crop_stmt.where(face_crops.c.camera_id == camera_id)
    crop_row = conn.execute(crop_stmt).one()

    total_crops: int = int(crop_row.total_face_crops or 0)
    matched_crops: int = int(crop_row.matched_face_crops or 0)

    return StorageOverview(
        total_clips=int(clip_row.total_clips or 0),
        total_bytes=int(clip_row.total_bytes or 0),
        total_face_crops=total_crops,
        matched_face_crops=matched_crops,
        unmatched_face_crops=total_crops - matched_crops,
        pending_clips=int(clip_row.pending_clips or 0),
        processing_clips=int(clip_row.processing_clips or 0),
        completed_clips=int(clip_row.completed_clips or 0),
        failed_clips=int(clip_row.failed_clips or 0),
        recording_clips=int(clip_row.recording_clips or 0),
        avg_clip_duration_sec=float(clip_row.avg_clip_duration_sec)
        if clip_row.avg_clip_duration_sec is not None
        else None,
    )


def _by_camera(
    conn: Connection,
    scope: TenantScope,
    cutoff: datetime,
    camera_id: Optional[int],
) -> list[CameraStorageRow]:
    # ── Clips per camera ──────────────────────────────────────────────────────
    clip_stmt = (
        select(
            person_clips.c.camera_id,
            cameras.c.name.label("camera_name"),
            func.count().label("clip_count"),
            func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label(
                "total_bytes"
            ),
            func.avg(person_clips.c.duration_seconds).label("avg_clip_duration_sec"),
        )
        .select_from(
            person_clips.outerjoin(
                cameras,
                (cameras.c.id == person_clips.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            )
        )
        .where(
            person_clips.c.tenant_id == scope.tenant_id,
            person_clips.c.created_at >= cutoff,
        )
        .group_by(person_clips.c.camera_id, cameras.c.name)
        .order_by(func.sum(person_clips.c.filesize_bytes).desc())
    )
    if camera_id is not None:
        clip_stmt = clip_stmt.where(person_clips.c.camera_id == camera_id)
    clip_rows = conn.execute(clip_stmt).fetchall()

    # ── Face crops per camera ─────────────────────────────────────────────────
    crop_stmt = (
        select(
            face_crops.c.camera_id,
            func.count().label("total_crops"),
            func.count()
            .filter(face_crops.c.employee_id.isnot(None))
            .label("matched_crops"),
        )
        .where(
            face_crops.c.tenant_id == scope.tenant_id,
            face_crops.c.created_at >= cutoff,
        )
        .group_by(face_crops.c.camera_id)
    )
    if camera_id is not None:
        crop_stmt = crop_stmt.where(face_crops.c.camera_id == camera_id)
    crop_rows = conn.execute(crop_stmt).fetchall()
    crop_by_cam: dict[int, tuple[int, int]] = {
        row.camera_id: (int(row.total_crops or 0), int(row.matched_crops or 0))
        for row in crop_rows
    }

    result: list[CameraStorageRow] = []
    for row in clip_rows:
        total_c, matched_c = crop_by_cam.get(row.camera_id, (0, 0))
        result.append(
            CameraStorageRow(
                camera_id=row.camera_id,
                camera_name=row.camera_name or f"Camera {row.camera_id}",
                clip_count=int(row.clip_count or 0),
                total_bytes=int(row.total_bytes or 0),
                matched_crops=matched_c,
                unmatched_crops=total_c - matched_c,
                avg_clip_duration_sec=float(row.avg_clip_duration_sec)
                if row.avg_clip_duration_sec is not None
                else None,
            )
        )
    return result


def _daily(
    conn: Connection,
    scope: TenantScope,
    cutoff: datetime,
    camera_id: Optional[int],
) -> list[DailyStorageRow]:
    # ── Clips per day ─────────────────────────────────────────────────────────
    day_col = func.date(person_clips.c.created_at).label("day")
    clip_stmt = (
        select(
            day_col,
            func.count().label("clip_count"),
            func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label(
                "total_bytes"
            ),
        )
        .where(
            person_clips.c.tenant_id == scope.tenant_id,
            person_clips.c.created_at >= cutoff,
        )
        .group_by(func.date(person_clips.c.created_at))
        .order_by(func.date(person_clips.c.created_at))
    )
    if camera_id is not None:
        clip_stmt = clip_stmt.where(person_clips.c.camera_id == camera_id)
    clip_rows = conn.execute(clip_stmt).fetchall()

    # ── Crops per day ─────────────────────────────────────────────────────────
    crop_day_col = func.date(face_crops.c.created_at).label("day")
    crop_stmt = (
        select(
            crop_day_col,
            func.count().label("total_crops"),
            func.count()
            .filter(face_crops.c.employee_id.isnot(None))
            .label("matched_crops"),
        )
        .where(
            face_crops.c.tenant_id == scope.tenant_id,
            face_crops.c.created_at >= cutoff,
        )
        .group_by(func.date(face_crops.c.created_at))
    )
    if camera_id is not None:
        crop_stmt = crop_stmt.where(face_crops.c.camera_id == camera_id)
    crop_rows = conn.execute(crop_stmt).fetchall()
    crop_by_day: dict[str, tuple[int, int]] = {
        str(row.day): (int(row.total_crops or 0), int(row.matched_crops or 0))
        for row in crop_rows
    }

    result: list[DailyStorageRow] = []
    for row in clip_rows:
        day_str = str(row.day)
        total_c, matched_c = crop_by_day.get(day_str, (0, 0))
        result.append(
            DailyStorageRow(
                date=day_str,
                clip_count=int(row.clip_count or 0),
                total_bytes=int(row.total_bytes or 0),
                new_crops=total_c,
                matched_crops=matched_c,
            )
        )
    return result
