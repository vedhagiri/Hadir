"""Database layer for face_crops."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import delete, func, insert, select
from sqlalchemy.engine import Engine, Row

from maugood.db import cameras, face_crops, person_clips
from maugood.tenants.scope import TenantScope


def _crop_join(q):
    """Join face_crops with cameras on tenant_id + camera_id."""
    return q.select_from(
        face_crops.join(
            cameras,
            (cameras.c.id == face_crops.c.camera_id)
            & (cameras.c.tenant_id == face_crops.c.tenant_id),
        )
    )


def list_crops(
    conn, scope, *, page=1, page_size=50, camera_id=None, person_clip_id=None
) -> tuple[list[Row], int]:
    """Return (rows, total_count) for the given filters."""
    base = (
        select(face_crops, cameras.c.name.label("camera_name"))
        .select_from(face_crops.join(cameras, (cameras.c.id == face_crops.c.camera_id) & (cameras.c.tenant_id == scope.tenant_id)))
        .where(face_crops.c.tenant_id == scope.tenant_id)
    )
    if camera_id is not None:
        base = base.where(face_crops.c.camera_id == camera_id)
    if person_clip_id is not None:
        base = base.where(face_crops.c.person_clip_id == person_clip_id)
    count_q = select(func.count()).select_from(base.subquery())
    total = conn.execute(count_q).scalar_one()
    offset = (page - 1) * page_size
    rows = conn.execute(
        base.order_by(face_crops.c.created_at.desc())
        .limit(page_size)
        .offset(offset)
    ).all()
    return rows, total


def get_crop(conn, scope, crop_id) -> Optional[Row]:
    """Return a single crop row with camera join, or None."""
    row = conn.execute(
        select(face_crops, cameras.c.name.label("camera_name"))
        .select_from(
            face_crops.join(cameras, (cameras.c.id == face_crops.c.camera_id) & (cameras.c.tenant_id == scope.tenant_id))
        )
        .where(face_crops.c.id == crop_id, face_crops.c.tenant_id == scope.tenant_id)
    ).first()
    return row


def delete_crop(conn, scope, crop_id) -> bool:
    """Delete a crop row. Returns True if a row was removed."""
    result = conn.execute(
        delete(face_crops).where(
            face_crops.c.id == crop_id,
            face_crops.c.tenant_id == scope.tenant_id,
        )
    )
    return result.rowcount > 0


def insert_crop(
    conn,
    scope,
    *,
    camera_id,
    person_clip_id,
    event_timestamp,
    face_index,
    file_path,
    quality_score,
    sharpness,
    detection_score,
    width,
    height,
) -> int:
    """Insert a face crop row and return its id."""
    result = conn.execute(
        insert(face_crops).values(
            tenant_id=scope.tenant_id,
            camera_id=camera_id,
            person_clip_id=person_clip_id,
            event_timestamp=event_timestamp,
            face_index=face_index,
            file_path=file_path,
            quality_score=quality_score,
            sharpness=sharpness,
            detection_score=detection_score,
            width=width,
            height=height,
        )
    )
    return result.inserted_primary_key[0]


def get_stats(conn, scope) -> tuple[int, list[dict]]:
    """Return (total_crops, per_camera)."""
    total = conn.execute(
        select(func.count(face_crops.c.id)).where(
            face_crops.c.tenant_id == scope.tenant_id
        )
    ).scalar_one()

    per_camera_rows = conn.execute(
        select(
            face_crops.c.camera_id,
            cameras.c.name.label("camera_name"),
            func.count(face_crops.c.id).label("crop_count"),
        )
        .select_from(
            face_crops.join(
                cameras,
                (cameras.c.id == face_crops.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            )
        )
        .where(face_crops.c.tenant_id == scope.tenant_id)
        .group_by(face_crops.c.camera_id, cameras.c.name)
        .order_by(cameras.c.name)
    ).all()

    per_camera = [
        {
            "camera_id": r.camera_id,
            "camera_name": str(r.camera_name),
            "crop_count": int(r.crop_count),
        }
        for r in per_camera_rows
    ]
    return int(total), per_camera


def list_crops_grouped_by_clip(
    conn, scope, *, camera_id=None, page=1, page_size=20
) -> list[dict]:
    """Return face crops grouped by person_clip_id.

    Returns a list of dicts:
        {
            "person_clip_id": int,
            "camera_id": int,
            "camera_name": str,
            "clip_start": str | None,
            "clip_end": str | None,
            "duration_seconds": float,
            "track_count": int,
            "crops": [...]
        }
    """
    base = (
        select(
            face_crops,
            cameras.c.name.label("camera_name"),
            person_clips.c.clip_start,
            person_clips.c.clip_end,
            person_clips.c.duration_seconds,
            person_clips.c.person_count,
        )
        .select_from(
            face_crops.join(
                cameras,
                (cameras.c.id == face_crops.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            ).join(
                person_clips,
                (person_clips.c.id == face_crops.c.person_clip_id)
                & (person_clips.c.tenant_id == scope.tenant_id),
            )
        )
        .where(face_crops.c.tenant_id == scope.tenant_id)
    )
    if camera_id is not None:
        base = base.where(face_crops.c.camera_id == camera_id)
    base = base.order_by(person_clips.c.clip_start.desc(), face_crops.c.face_index.asc())

    rows = conn.execute(base).all()

    groups: dict[int, dict] = {}
    for r in rows:
        cid = r.person_clip_id
        if cid not in groups:
            clip_start = r.clip_start
            groups[cid] = {
                "person_clip_id": cid,
                "camera_id": r.camera_id,
                "camera_name": str(r.camera_name or ""),
                "clip_start": clip_start.strftime("%Y-%m-%d %H:%M:%S") if hasattr(clip_start, "strftime") else str(clip_start or ""),
                "clip_end": r.clip_end.strftime("%Y-%m-%d %H:%M:%S") if hasattr(r.clip_end, "strftime") else str(r.clip_end or ""),
                "duration_seconds": float(r.duration_seconds or 0),
                "track_count": int(r.person_count or 0),
                "crops": [],
            }
        groups[cid]["crops"].append({
            "id": r.id,
            "face_index": int(r.face_index or 1),
            "quality_score": float(r.quality_score or 0),
            "width": int(r.width or 0),
            "height": int(r.height or 0),
            "created_at": r.created_at,
        })

    all_groups = list(groups.values())
    total_groups = len(all_groups)
    offset = (page - 1) * page_size
    page_groups = all_groups[offset : offset + page_size]

    return {
        "groups": page_groups,
        "total_groups": total_groups,
        "total_crops": sum(len(g["crops"]) for g in all_groups),
    }
