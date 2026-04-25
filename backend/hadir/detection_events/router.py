"""Camera Logs read endpoints — Admin only.

* ``GET /api/detection-events`` — paginated list with filters
  (camera_id, employee_id, identified, captured_at range).
* ``GET /api/detection-events/{id}/crop`` — decrypt the encrypted JPEG
  on disk and stream it back. Auth-gated and audit-logged
  (``detection_event.crop_viewed``) per pilot-plan red lines.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.cameras import repository as camera_repo
from hadir.db import (
    cameras,
    departments,
    detection_events,
    employees,
    get_engine,
)
from hadir.employees.photos import decrypt_bytes
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/detection-events", tags=["detection-events"])

ADMIN = Depends(require_role("Admin"))


class DetectionEventOut(BaseModel):
    id: int
    captured_at: datetime
    camera_id: int
    camera_name: str
    employee_id: Optional[int] = None
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None
    confidence: Optional[float] = None
    track_id: str
    has_crop: bool


class DetectionEventListOut(BaseModel):
    items: list[DetectionEventOut]
    total: int
    page: int
    page_size: int


def _build_select(scope: TenantScope):
    return (
        select(
            detection_events.c.id,
            detection_events.c.captured_at,
            detection_events.c.camera_id,
            cameras.c.name.label("camera_name"),
            detection_events.c.employee_id,
            employees.c.employee_code,
            employees.c.full_name.label("employee_name"),
            detection_events.c.confidence,
            detection_events.c.track_id,
            detection_events.c.face_crop_path,
        )
        .select_from(
            detection_events.join(
                cameras,
                and_(
                    cameras.c.id == detection_events.c.camera_id,
                    cameras.c.tenant_id == detection_events.c.tenant_id,
                ),
            ).outerjoin(
                employees,
                and_(
                    employees.c.id == detection_events.c.employee_id,
                    employees.c.tenant_id == detection_events.c.tenant_id,
                ),
            )
        )
        .where(detection_events.c.tenant_id == scope.tenant_id)
    )


@router.get("", response_model=DetectionEventListOut)
def list_events(
    user: Annotated[CurrentUser, ADMIN],
    camera_id: Annotated[Optional[int], Query()] = None,
    employee_id: Annotated[Optional[int], Query()] = None,
    identified: Annotated[
        Optional[bool],
        Query(description="True → only identified events; False → only unknown."),
    ] = None,
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 100,
) -> DetectionEventListOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    base = _build_select(scope)
    if camera_id is not None:
        base = base.where(detection_events.c.camera_id == camera_id)
    if employee_id is not None:
        base = base.where(detection_events.c.employee_id == employee_id)
    if identified is True:
        base = base.where(detection_events.c.employee_id.is_not(None))
    elif identified is False:
        base = base.where(detection_events.c.employee_id.is_(None))
    if start is not None:
        base = base.where(detection_events.c.captured_at >= start)
    if end is not None:
        base = base.where(detection_events.c.captured_at <= end)

    with get_engine().begin() as conn:
        total = int(
            conn.execute(
                select(func.count()).select_from(base.subquery())
            ).scalar_one()
        )
        rows = conn.execute(
            base.order_by(detection_events.c.captured_at.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()

    items = [
        DetectionEventOut(
            id=int(r.id),
            captured_at=r.captured_at,
            camera_id=int(r.camera_id),
            camera_name=str(r.camera_name),
            employee_id=int(r.employee_id) if r.employee_id is not None else None,
            employee_code=str(r.employee_code) if r.employee_code is not None else None,
            employee_name=str(r.employee_name) if r.employee_name is not None else None,
            confidence=float(r.confidence) if r.confidence is not None else None,
            track_id=str(r.track_id),
            has_crop=bool(r.face_crop_path),
        )
        for r in rows
    ]
    return DetectionEventListOut(
        items=items, total=total, page=page, page_size=page_size
    )


@router.get("/{event_id}/crop")
def crop_endpoint(
    event_id: int, user: Annotated[CurrentUser, ADMIN]
) -> Response:
    """Decrypt + stream the encrypted face crop. Auth-gated, audit-logged."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.face_crop_path,
                detection_events.c.camera_id,
                detection_events.c.employee_id,
            ).where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id == event_id,
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="event not found")
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="detection_event.crop_viewed",
            entity_type="detection_event",
            entity_id=str(event_id),
            after={
                "camera_id": int(row.camera_id),
                "employee_id": (
                    int(row.employee_id) if row.employee_id is not None else None
                ),
            },
        )

    path = Path(str(row.face_crop_path))
    if not path.exists():
        logger.warning("detection event %s crop missing on disk: %s", event_id, path)
        raise HTTPException(status_code=410, detail="crop file missing")
    try:
        plain = decrypt_bytes(path.read_bytes())
    except RuntimeError as exc:
        logger.warning("crop decrypt failed for event %s: %s", event_id, exc)
        raise HTTPException(status_code=500, detail="could not decrypt crop") from exc
    return Response(content=plain, media_type="image/jpeg")
