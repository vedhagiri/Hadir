"""API endpoints for person clips — /api/person-clips/*.

All endpoints require authentication. List/stats are available to Admin
and HR; stream/delete are Admin-only.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, current_user, require_any_role, require_role
from maugood.config import get_settings
from maugood.db import get_engine, person_clips
from maugood.employees.photos import decrypt_bytes
from maugood.person_clips.repository import bulk_delete_clips, delete_clip, get_clip, get_stats, list_clips
from maugood.person_clips.reprocess import get_reprocess_worker
from maugood.person_clips.schemas import (
    BulkDeleteClipRequest,
    BulkDeleteClipResponse,
    PersonClipListResponse,
    PersonClipOut,
    PersonClipStats,
    ReprocessFaceMatchRequest,
    ReprocessFaceMatchResponse,
    ReprocessFaceMatchStatus,
)
from maugood.tenants.scope import TenantScope, resolve_tenant_schema_via_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/person-clips", tags=["person-clips"])

ADMIN = Depends(require_role("Admin"))
HR_OR_ADMIN = Depends(require_any_role("Admin", "HR"))


def _resolve_employee_names(conn, scope: TenantScope, all_matched_ids: set[int]) -> dict[int, str]:
    """Fetch full names for a set of employee IDs. Returns {id: name} dict."""
    if not all_matched_ids:
        return {}
    from sqlalchemy import select as _select
    from maugood.db import employees as _emp
    rows = conn.execute(
        _select(_emp.c.id, _emp.c.full_name).where(
            _emp.c.id.in_(list(all_matched_ids)),
            _emp.c.tenant_id == scope.tenant_id,
        )
    ).all()
    return {r.id: r.full_name for r in rows}


def _row_to_out(row, name_map: dict[int, str] | None = None) -> PersonClipOut:
    matched: list[int] = []
    raw = getattr(row, "matched_employees", None)
    if raw is not None and isinstance(raw, list):
        matched = [int(x) for x in raw if isinstance(x, (int, float))]
    names: list[str] = []
    if name_map is not None:
        names = [name_map.get(eid, f"EMP {eid}") for eid in matched]
    return PersonClipOut(
        id=row.id,
        camera_id=row.camera_id,
        camera_name=str(getattr(row, "camera_name", "") or ""),
        employee_id=row.employee_id,
        employee_name=str(getattr(row, "employee_name", "") or None)
        if getattr(row, "employee_name", None)
        else None,
        track_id=row.track_id,
        clip_start=row.clip_start,
        clip_end=row.clip_end,
        duration_seconds=float(row.duration_seconds or 0),
        filesize_bytes=int(row.filesize_bytes or 0),
        frame_count=int(row.frame_count or 0),
        person_count=int(getattr(row, "person_count", 0) or 0),
        matched_employees=matched,
        matched_employee_names=names,
        matched_status=str(getattr(row, "matched_status", "pending") or "pending"),
        person_start=getattr(row, "person_start", None),
        person_end=getattr(row, "person_end", None),
        face_matching_duration_ms=getattr(row, "face_matching_duration_ms", None),
        face_matching_progress=int(getattr(row, "face_matching_progress", 0) or 0),
        created_at=row.created_at,
    )


@router.get("", response_model=PersonClipListResponse)
def list_person_clips(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    camera_id: Optional[int] = Query(default=None),
    employee_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
) -> PersonClipListResponse:
    """List person clips, with optional filters."""

    scope = TenantScope(tenant_id=user.tenant_id)
    start_dt: Optional[datetime] = None
    end_dt: Optional[datetime] = None
    if start:
        try:
            start_dt = datetime.fromisoformat(start)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid start date") from exc
    if end:
        try:
            end_dt = datetime.fromisoformat(end)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid end date") from exc

    with get_engine().begin() as conn:
        rows, total = list_clips(
            conn,
            scope,
            page=page,
            page_size=page_size,
            camera_id=camera_id,
            employee_id=employee_id,
            start=start_dt,
            end=end_dt,
        )

        # Resolve matched employee names in one batch query.
        all_ids: set[int] = set()
        for r in rows:
            raw = getattr(r, "matched_employees", None)
            if raw is not None and isinstance(raw, list):
                for eid in raw:
                    if isinstance(eid, (int, float)):
                        all_ids.add(int(eid))
        name_map = _resolve_employee_names(conn, scope, all_ids)

    return PersonClipListResponse(
        items=[_row_to_out(r, name_map) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/stats", response_model=PersonClipStats)
def person_clip_stats(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> PersonClipStats:
    """Summary stats for person clips."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        total, size, per_camera = get_stats(conn, scope)
    return PersonClipStats(
        total_clips=total,
        total_size_bytes=size,
        per_camera=per_camera,
    )


@router.post("/reprocess-face-match", response_model=ReprocessFaceMatchResponse)
def reprocess_face_match(
    body: ReprocessFaceMatchRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> ReprocessFaceMatchResponse:
    """Start (or resume) reprocessing all saved person clips for face
    matching. Runs asynchronously — poll ``/reprocess-status`` for
    progress.

    ``mode``:
    * ``"all"`` — reprocess every clip, overwriting existing data.
    * ``"skip_existing"`` — only process clips where
      ``matched_employees`` is empty.
    """

    from maugood.person_clips.reprocess import get_reprocess_worker

    schema = resolve_tenant_schema_via_engine(get_engine(), user.tenant_id)
    scope = TenantScope(
        tenant_id=user.tenant_id,
        tenant_schema=schema,
    )

    worker = get_reprocess_worker()
    if worker.is_running():
        return ReprocessFaceMatchResponse(
            started=False,
            message="Reprocess is already running. "
            "Poll /api/person-clips/reprocess-status for progress.",
        )

    started = worker.trigger(
        scope=scope,
        mode=body.mode,
        actor_user_id=user.id,
    )

    if started:
        logger.info(
            "face match reprocess triggered: tenant=%s mode=%s by user=%s",
            scope.tenant_id, body.mode, user.id,
        )
        return ReprocessFaceMatchResponse(
            started=True,
            message="Face match reprocess started. "
            "Poll /api/person-clips/reprocess-status for progress.",
        )

    return ReprocessFaceMatchResponse(
        started=False,
        message="Could not start reprocess. Try again.",
    )


@router.get("/reprocess-status", response_model=ReprocessFaceMatchStatus)
def reprocess_face_match_status(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> ReprocessFaceMatchStatus:
    """Return the current reprocess status for this tenant."""

    from maugood.person_clips.reprocess import get_reprocess_worker

    worker = get_reprocess_worker()
    raw = worker.get_status()
    return ReprocessFaceMatchStatus(
        status=raw.get("status", "idle"),
        mode=raw.get("mode", "all"),
        total_clips=raw.get("total_clips", 0),
        processed_clips=raw.get("processed_clips", 0),
        matched_total=raw.get("matched_total", 0),
        failed_count=raw.get("failed_count", 0),
        errors=raw.get("errors", []),
        started_at=raw.get("started_at"),
        ended_at=raw.get("ended_at"),
    )


@router.get("/{clip_id}/thumbnail")
def person_clip_thumbnail(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> Response:
    """Serve the thumbnail (first frame) for a person clip.

    Looks for ``{file_path.stem}.thumb.jpg`` next to the MP4.
    Returns ``image/jpeg``. No audit row — thumbnails are not
    considered sensitive.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        raise HTTPException(status_code=404, detail="person clip not found")

    if not row.file_path:
        raise HTTPException(status_code=410, detail="clip file missing")

    thumb_path = Path(str(row.file_path)).with_suffix(".thumb.jpg")

    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="thumbnail not found")

    try:
        encrypted = thumb_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error("thumb decrypt failed: clip_id=%s reason=%s", clip_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail="thumbnail decrypt failed") from exc

    return Response(content=plain, media_type="image/jpeg")


@router.get("/{clip_id}/stream")
def stream_person_clip(
    clip_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    response: Response,
) -> Response:
    """Stream a person clip video file. Decrypts on the fly.

    Returns the raw MP4 bytes with ``Content-Type: video/mp4``.
    Writes an audit row per download.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        raise HTTPException(status_code=404, detail="person clip not found")

    if not row.file_path:
        raise HTTPException(status_code=410, detail="clip file missing")

    file_path = Path(str(row.file_path))
    if not file_path.exists():
        logger.warning(
            "clip file missing on disk: tenant=%s clip_id=%s path=%s",
            scope.tenant_id, clip_id, file_path,
        )
        raise HTTPException(status_code=410, detail="clip file missing")

    try:
        encrypted = file_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error("clip decrypt failed: clip_id=%s reason=%s", clip_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail="clip decrypt failed") from exc

    # Audit the download.
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="person_clip.streamed",
            entity_type="person_clip",
            entity_id=str(clip_id),
            after={"camera_id": row.camera_id, "employee_id": row.employee_id},
        )

    filename = f"person-clip-{clip_id}.mp4"
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return Response(
        content=plain,
        media_type="video/mp4",
        headers={
            "Content-Length": str(len(plain)),
            "Accept-Ranges": "bytes",
        },
    )


@router.post("/bulk-delete", response_model=BulkDeleteClipResponse)
def bulk_delete_person_clips(
    body: BulkDeleteClipRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> BulkDeleteClipResponse:
    """Delete multiple person clips (files + DB rows). Admin-only.

    Removes up to 200 clips in a single call. Each deleted clip
    writes an audit row. Already-missing clip IDs are silently
    skipped.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        rows = bulk_delete_clips(conn, scope, body.clip_ids)

    if not rows:
        return BulkDeleteClipResponse(deleted_count=0, deleted_ids=[])

    # Remove files from disk.
    for row in rows:
        if row.file_path:
            mp4 = Path(str(row.file_path))
            try:
                mp4.unlink(missing_ok=True)
                mp4.with_suffix(".thumb.jpg").unlink(missing_ok=True)
            except OSError as exc:
                logger.warning(
                    "clip file delete failed: clip_id=%s path=%s reason=%s",
                    row.id, row.file_path, type(exc).__name__,
                )

    # Write one audit row per deleted clip.
    with engine.begin() as conn:
        for row in rows:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="person_clip.deleted",
                entity_type="person_clip",
                entity_id=str(row.id),
                before={"camera_id": row.camera_id, "employee_id": row.employee_id},
            )

    deleted_ids = [r.id for r in rows]
    return BulkDeleteClipResponse(
        deleted_count=len(deleted_ids),
        deleted_ids=deleted_ids,
    )


@router.delete("/{clip_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_person_clip(
    clip_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    """Delete a person clip (file + DB row). Admin-only."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_clip(conn, scope, clip_id)

    if row is None:
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    # Remove files from disk.
    if row.file_path:
        mp4 = Path(str(row.file_path))
        try:
            mp4.unlink(missing_ok=True)
            mp4.with_suffix(".thumb.jpg").unlink(missing_ok=True)
        except OSError as exc:
            logger.warning(
                "clip file delete failed: clip_id=%s path=%s reason=%s",
                clip_id, row.file_path, type(exc).__name__,
            )

    with engine.begin() as conn:
        delete_clip(conn, scope, clip_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="person_clip.deleted",
            entity_type="person_clip",
            entity_id=str(clip_id),
            before={"camera_id": row.camera_id, "employee_id": row.employee_id},
        )

    response.status_code = status.HTTP_204_NO_CONTENT
    return response
