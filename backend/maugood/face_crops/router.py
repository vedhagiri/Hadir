"""API endpoints for face crops — /api/face-crops/*.

All endpoints require authentication. List/stats are available to Admin
and HR; image serving is HR+Admin.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.db import get_engine
from maugood.employees.photos import decrypt_bytes
from maugood.face_crops.extractor import (
    get_clips_processing_status,
    is_processing,
    process_all_pending,
)
from maugood.face_crops.repository import (
    get_crop,
    get_stats,
    list_crops,
    list_crops_grouped_by_clip,
)
from maugood.face_crops.schemas import (
    ClipsProcessingStatus,
    FaceCropListResponse,
    FaceCropOut,
    FaceCropStats,
    FaceCropsByClipResponse,
    ProcessResult,
)
from maugood.tenants.scope import (
    TenantScope,
    resolve_tenant_schema_via_engine,
)
from maugood.auth.audit import write_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/face-crops", tags=["face-crops"])

HR_OR_ADMIN = Depends(require_any_role("Admin", "HR"))


def _row_to_out(row) -> FaceCropOut:
    return FaceCropOut(
        id=row.id,
        camera_id=row.camera_id,
        camera_name=str(getattr(row, "camera_name", "") or ""),
        person_clip_id=row.person_clip_id,
        event_timestamp=str(row.event_timestamp or ""),
        face_index=int(row.face_index or 1),
        quality_score=float(row.quality_score or 0),
        width=int(row.width or 0),
        height=int(row.height or 0),
        created_at=row.created_at,
    )


def _make_scope(user: CurrentUser) -> TenantScope:
    """Build a TenantScope with the correct tenant_schema resolved."""
    engine = get_engine()
    schema = resolve_tenant_schema_via_engine(engine, user.tenant_id)
    return TenantScope(tenant_id=user.tenant_id, tenant_schema=schema)


@router.get("", response_model=FaceCropListResponse)
def list_face_crops(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    camera_id: Optional[int] = Query(default=None),
    person_clip_id: Optional[int] = Query(default=None),
) -> FaceCropListResponse:
    """List face crops, with optional filters."""

    scope = _make_scope(user)
    with get_engine().begin() as conn:
        rows, total = list_crops(
            conn,
            scope,
            page=page,
            page_size=page_size,
            camera_id=camera_id,
            person_clip_id=person_clip_id,
        )

    return FaceCropListResponse(
        items=[_row_to_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/by-clip", response_model=FaceCropsByClipResponse)
def face_crops_by_clip(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    camera_id: Optional[int] = Query(default=None),
) -> FaceCropsByClipResponse:
    """List face crops grouped by person clip (event-based grouping)."""

    scope = _make_scope(user)
    with get_engine().begin() as conn:
        result = list_crops_grouped_by_clip(
            conn, scope, camera_id=camera_id, page=page, page_size=page_size,
        )

    return FaceCropsByClipResponse(**result)


@router.get("/stats", response_model=FaceCropStats)
def face_crop_stats(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> FaceCropStats:
    """Summary stats for face crops."""

    scope = _make_scope(user)
    with get_engine().begin() as conn:
        total, per_camera = get_stats(conn, scope)
    return FaceCropStats(
        total_crops=total,
        per_camera=per_camera,
    )


@router.get("/clips-status", response_model=ClipsProcessingStatus)
def clips_processing_status(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> ClipsProcessingStatus:
    """Get counts of clips by face_crops_status."""

    scope = _make_scope(user)
    engine = get_engine()
    data = get_clips_processing_status(engine, scope)
    return ClipsProcessingStatus(**data)


@router.post("/process", response_model=ProcessResult)
def process_face_crops(
    user: Annotated[CurrentUser, HR_OR_ADMIN],
    camera_id: Optional[int] = Query(default=None),
    reprocess: bool = Query(default=False),
) -> ProcessResult:
    """Start background processing of face crops from person clips.

    If ``reprocess`` is True, re-extracts from already-processed clips
    too. Optionally filter to a single camera.
    """

    if is_processing():
        raise HTTPException(status_code=409, detail="face crop processing is already running")

    scope = _make_scope(user)
    engine = get_engine()

    logger.info(
        "face_crop.processing.started tenant=%s camera=%s reprocess=%s",
        scope.tenant_id, camera_id, reprocess,
    )

    # Fire off background processing on a daemon thread.
    result_holder: dict = {}

    def _run() -> None:
        try:
            res = process_all_pending(
                engine, scope,
                camera_id=camera_id,
                reprocess=reprocess,
            )
            result_holder.update(res)
            logger.info(
                "face_crop.processing.completed tenant=%s result=%s",
                scope.tenant_id, res,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "face_crop.processing.failed tenant=%s reason=%s",
                scope.tenant_id, type(exc).__name__,
            )
            result_holder["error"] = str(exc)

    thread = threading.Thread(target=_run, name="face-crop-batch", daemon=True)
    thread.start()

    return ProcessResult(total=0, processed=0, failed=0, saved_crops=0)


@router.get("/{crop_id}/image")
def face_crop_image(
    crop_id: int,
    user: Annotated[CurrentUser, HR_OR_ADMIN],
) -> Response:
    """Serve a single face crop image (decrypted JPEG stream)."""

    scope = _make_scope(user)
    engine = get_engine()

    with engine.begin() as conn:
        row = get_crop(conn, scope, crop_id)

    if row is None:
        raise HTTPException(status_code=404, detail="face crop not found")

    if not row.file_path:
        raise HTTPException(status_code=410, detail="crop file missing")

    fp = Path(str(row.file_path))
    if not fp.exists():
        logger.warning(
            "face_crop.file.missing tenant=%s crop_id=%s path=%s",
            scope.tenant_id, crop_id, fp,
        )
        raise HTTPException(status_code=410, detail="crop file missing")

    try:
        encrypted = fp.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.error(
            "face_crop.decrypt.failed crop_id=%s reason=%s",
            crop_id, type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="crop decrypt failed") from exc

    return Response(content=plain, media_type="image/jpeg")
