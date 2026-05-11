"""Database layer for person_clips."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, insert, select
from sqlalchemy.engine import Engine, Row

from maugood.db import cameras, employees, person_clips
from maugood.tenants.scope import TenantScope


def list_clips(
    conn: Engine,
    scope: TenantScope,
    *,
    page: int = 1,
    page_size: int = 50,
    camera_id: Optional[int] = None,
    employee_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> tuple[list[Row], int]:
    """Return ``(rows, total_count)`` for the given filters.

    All filters scope to the tenant via ``scope.tenant_id``.
    """

    base = (
        select(
            person_clips,
            cameras.c.name.label("camera_name"),
            employees.c.full_name.label("employee_name"),
        )
        .select_from(
            person_clips.outerjoin(
                cameras,
                (cameras.c.id == person_clips.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            ).outerjoin(
                employees,
                (employees.c.id == person_clips.c.employee_id)
                & (employees.c.tenant_id == scope.tenant_id),
            )
        )
        .where(person_clips.c.tenant_id == scope.tenant_id)
    )

    if camera_id is not None:
        base = base.where(person_clips.c.camera_id == camera_id)
    if employee_id is not None:
        base = base.where(person_clips.c.employee_id == employee_id)
    if start is not None:
        base = base.where(person_clips.c.clip_start >= start)
    if end is not None:
        base = base.where(person_clips.c.clip_end <= end)

    count_q = select(func.count()).select_from(base.subquery())
    total = conn.execute(count_q).scalar_one()

    offset = (page - 1) * page_size
    rows = (
        conn.execute(
            base.order_by(person_clips.c.created_at.desc())
            .limit(page_size)
            .offset(offset)
        )
        .all()
    )

    return rows, total


def get_clip(
    conn: Engine, scope: TenantScope, clip_id: int
) -> Optional[Row]:
    """Return the clip row with camera + employee join, or None."""

    row = conn.execute(
        select(
            person_clips,
            cameras.c.name.label("camera_name"),
            employees.c.full_name.label("employee_name"),
        )
        .select_from(
            person_clips.outerjoin(
                cameras,
                (cameras.c.id == person_clips.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            ).outerjoin(
                employees,
                (employees.c.id == person_clips.c.employee_id)
                & (employees.c.tenant_id == scope.tenant_id),
            )
        )
        .where(
            person_clips.c.id == clip_id,
            person_clips.c.tenant_id == scope.tenant_id,
        )
    ).first()
    return row


def delete_clip(
    conn: Engine, scope: TenantScope, clip_id: int
) -> bool:
    """Delete a clip row. Returns True if a row was removed."""

    result = conn.execute(
        delete(person_clips).where(
            person_clips.c.id == clip_id,
            person_clips.c.tenant_id == scope.tenant_id,
        )
    )
    return result.rowcount > 0


def bulk_delete_clips(
    conn: Engine, scope: TenantScope, clip_ids: list[int]
) -> list[Row]:
    """Delete multiple clip rows scoped to the tenant.

    Returns the list of deleted rows (for file cleanup + audit).
    """

    rows = (
        conn.execute(
            select(person_clips).where(
                person_clips.c.id.in_(clip_ids),
                person_clips.c.tenant_id == scope.tenant_id,
            )
        )
        .all()
    )

    if not rows:
        return []

    conn.execute(
        delete(person_clips).where(
            person_clips.c.id.in_([r.id for r in rows]),
            person_clips.c.tenant_id == scope.tenant_id,
        )
    )

    return rows


def get_stats(
    conn: Engine, scope: TenantScope,
) -> tuple[int, int, list[dict]]:
    """Return ``(total_clips, total_size_bytes, per_camera)``."""

    total = conn.execute(
        select(func.count(person_clips.c.id)).where(
            person_clips.c.tenant_id == scope.tenant_id
        )
    ).scalar_one()

    size = conn.execute(
        select(func.coalesce(func.sum(person_clips.c.filesize_bytes), 0)).where(
            person_clips.c.tenant_id == scope.tenant_id
        )
    ).scalar_one()

    per_camera_rows = conn.execute(
        select(
            person_clips.c.camera_id,
            cameras.c.name.label("camera_name"),
            func.count(person_clips.c.id).label("clip_count"),
            func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label(
                "total_bytes"
            ),
        )
        .select_from(
            person_clips.join(
                cameras,
                (cameras.c.id == person_clips.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            )
        )
        .where(person_clips.c.tenant_id == scope.tenant_id)
        .group_by(person_clips.c.camera_id, cameras.c.name)
        .order_by(cameras.c.name)
    ).all()

    per_camera = [
        {
            "camera_id": r.camera_id,
            "camera_name": str(r.camera_name),
            "clip_count": int(r.clip_count),
            "total_bytes": int(r.total_bytes),
        }
        for r in per_camera_rows
    ]

    return int(total), int(size), per_camera
