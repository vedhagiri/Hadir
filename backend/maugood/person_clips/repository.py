"""Database layer for person_clips."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, insert, select
from sqlalchemy.engine import Engine, Row

from maugood.db import cameras, clip_processing_results, employees, person_clips
from maugood.tenants.scope import TenantScope


def list_clips(
    conn: Engine,
    scope: TenantScope,
    *,
    page: int = 1,
    page_size: int = 50,
    camera_id: Optional[int] = None,
    employee_id: Optional[int] = None,
    matched_employee_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    detection_source: Optional[str] = None,
    recording_status: Optional[str] = None,
    matched_status: Optional[str] = None,
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
    if matched_employee_id is not None:
        # Union semantics: a clip "belongs" to an employee when ANY of
        # these is true:
        #   1) legacy ``person_clips.employee_id`` link points at them
        #   2) ``person_clips.matched_employees`` JSONB contains their
        #      id (only UC3 writes this — load-bearing bug if we stop
        #      here, because operators may only run UC1)
        #   3) ANY ``clip_processing_results`` row for this clip has
        #      a completed match for this employee
        # (3) is the broad guarantee — UC1, UC2 or UC3 hitting on the
        # employee surfaces the clip regardless of which UC ran.
        from sqlalchemy import or_  # noqa: PLC0415

        cpr_subq = (
            select(clip_processing_results.c.person_clip_id)
            .where(
                clip_processing_results.c.tenant_id == scope.tenant_id,
                clip_processing_results.c.status == "completed",
                clip_processing_results.c.matched_employees.contains(
                    [matched_employee_id]
                ),
            )
        )
        base = base.where(
            or_(
                person_clips.c.employee_id == matched_employee_id,
                person_clips.c.matched_employees.contains([matched_employee_id]),
                person_clips.c.id.in_(cpr_subq),
            )
        )
    if start is not None:
        base = base.where(person_clips.c.clip_start >= start)
    if end is not None:
        base = base.where(person_clips.c.clip_end <= end)
    if detection_source is not None and detection_source in (
        "face", "body", "both"
    ):
        base = base.where(
            person_clips.c.detection_source == detection_source
        )
    # Face-matching status filter (matched_status column). Clicking a
    # pill on the page passes one of pending|processing|processed|failed.
    if matched_status is not None and matched_status in (
        "pending", "processing", "processed", "failed"
    ):
        base = base.where(
            person_clips.c.matched_status == matched_status
        )

    if recording_status is not None and recording_status in (
        "recording", "finalizing", "completed", "failed", "abandoned"
    ):
        # Explicit filter — return exactly that status.
        base = base.where(
            person_clips.c.recording_status == recording_status
        )
    else:
        # Migration 0054 / 0055 — default list view hides failure
        # states. ``abandoned`` rows have no file on disk (the worker
        # never got to finalize before a shutdown / crash); ``failed``
        # rows had a file write that errored out. Clicking either
        # would 410 with "clip file missing". They stay in the DB for
        # ops-side debugging and can be retrieved with an explicit
        # ?recording_status=abandoned / =failed query param. The
        # transient ``finalizing`` state is included — encoding is in
        # progress, the card shows "Encoding…" and the camera's live
        # stream is still watchable.
        base = base.where(
            person_clips.c.recording_status.in_(
                ("recording", "finalizing", "completed")
            )
        )

    count_q = select(func.count()).select_from(base.subquery())
    total = conn.execute(count_q).scalar_one()

    offset = (page - 1) * page_size
    # Migration 0054 — live clips pin to the top of the list so the
    # operator never has to scroll for the 🔴 LIVE entry. Among rows
    # with the same recording status, newest first as before.
    rows = (
        conn.execute(
            base.order_by(
                (person_clips.c.recording_status == "recording").desc(),
                person_clips.c.created_at.desc(),
            )
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

    Migration 0054 / 0055: rows in the in-flight states are silently
    skipped. ``recording`` = reader is still writing chunk frames.
    ``finalizing`` = reader has handed off, ClipWorker is encoding
    the file. Deleting now would race with the in-flight UPDATEs +
    leak partial intermediate files. The frontend disables the
    delete button on these states; this filter is defence in depth.
    """

    rows = (
        conn.execute(
            select(person_clips).where(
                person_clips.c.id.in_(clip_ids),
                person_clips.c.tenant_id == scope.tenant_id,
                person_clips.c.recording_status.notin_(
                    ("recording", "finalizing")
                ),
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
