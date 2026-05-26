"""Unidentified Faces clustering endpoints.

``GET /api/unidentified-faces``
    Returns paginated face clusters computed on demand from the
    ``detection_events`` rows where ``employee_id IS NULL`` and
    ``former_employee_match = FALSE``.

    Clusters are sorted by size (largest first) then by ``last_seen``
    descending.  Pagination is over *clusters*, not events.

``GET /api/unidentified-faces/events``
    Returns the raw unidentified-event list (no clustering) with the
    same filters.  Used by the detail drawer to load all crops for a
    specific set of event IDs.

Role gate: Admin + HR only — unidentified events have no employee
scope so Manager can't anchor the visibility check.

No new tables. Everything is derived from the existing
``detection_events`` table on every request.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import and_, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.db import cameras, detection_events, employee_photos, employees, get_engine
from maugood.employees.photos import create_photo_row, storage_dir
from maugood.tenants.scope import TenantScope
from maugood.unidentified_faces.clustering import (
    DEFAULT_CLUSTER_THRESHOLD,
    MAX_EVENTS_PER_RUN,
    RawEvent,
    cluster_events,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/unidentified-faces", tags=["unidentified-faces"])

ADMIN_HR = Depends(require_any_role("Admin", "HR"))


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class FaceClusterOut(BaseModel):
    cluster_id: str
    representative_event_id: int
    event_ids: list[int]
    crop_event_ids: list[int]
    count: int
    first_seen: datetime
    last_seen: datetime
    camera_ids: list[int]
    camera_names: list[str]
    avg_similarity: float


class UnidentifiedFacesResponse(BaseModel):
    clusters: list[FaceClusterOut]
    # Pagination over clusters
    total_clusters: int
    page: int
    page_size: int
    # Summary stats for the header banner
    total_unidentified_events: int
    events_with_embedding: int
    capped: bool   # True when MAX_EVENTS_PER_RUN limit was hit


class UnidentifiedEventOut(BaseModel):
    id: int
    captured_at: datetime
    camera_id: int
    camera_name: str
    has_crop: bool


class UnidentifiedEventsResponse(BaseModel):
    items: list[UnidentifiedEventOut]
    total: int


class PhotoAssignment(BaseModel):
    """One face crop to copy as an employee reference photo with its angle tag."""

    event_id: int
    angle: str = "front"

    @field_validator("angle")
    @classmethod
    def _validate_angle(cls, v: str) -> str:
        if v not in ("front", "left", "right", "other"):
            raise ValueError("angle must be one of: front, left, right, other")
        return v


class MapToEmployeeBody(BaseModel):
    employee_id: int
    # ALL cluster event IDs — every row gets employee_id set.
    event_ids: list[int]
    # Subset to copy as reference photos, each with its own angle tag.
    # Empty list = attribute events only, add no new photos.
    photo_assignments: list[PhotoAssignment] = []

    @field_validator("event_ids")
    @classmethod
    def _validate_event_ids(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("event_ids must not be empty")
        return v[:200]  # hard cap to prevent abuse


class MapToEmployeeResponse(BaseModel):
    mapped_events: int
    photos_created: int
    photo_ids: list[int]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _default_start() -> datetime:
    """Default date range: last 7 days."""
    return datetime.now(tz=timezone.utc) - timedelta(days=7)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=UnidentifiedFacesResponse)
def list_clusters(
    user: Annotated[CurrentUser, ADMIN_HR],
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    camera_id: Annotated[Optional[int], Query()] = None,
    min_count: Annotated[int, Query(ge=1)] = 1,
    threshold: Annotated[
        float,
        Query(
            ge=0.40,
            le=0.99,
            description="Cosine similarity threshold for same-person grouping",
        ),
    ] = DEFAULT_CLUSTER_THRESHOLD,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 24,
) -> UnidentifiedFacesResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    if start is None:
        start = _default_start()

    base = (
        select(
            detection_events.c.id,
            detection_events.c.embedding,
            detection_events.c.face_crop_path,
            detection_events.c.captured_at,
            detection_events.c.camera_id,
            cameras.c.name.label("camera_name"),
        )
        .select_from(
            detection_events.join(
                cameras,
                and_(
                    cameras.c.id == detection_events.c.camera_id,
                    cameras.c.tenant_id == detection_events.c.tenant_id,
                ),
            )
        )
        .where(
            detection_events.c.tenant_id == scope.tenant_id,
            detection_events.c.employee_id.is_(None),
            detection_events.c.former_employee_match.is_(False),
        )
        .order_by(detection_events.c.captured_at.desc())
    )

    if camera_id is not None:
        base = base.where(detection_events.c.camera_id == camera_id)
    if start is not None:
        base = base.where(detection_events.c.captured_at >= start)
    if end is not None:
        base = base.where(detection_events.c.captured_at <= end)

    with get_engine().begin() as conn:
        rows = conn.execute(base).all()

    total_events = len(rows)
    rows_with_embedding = [r for r in rows if r.embedding is not None]
    events_with_embedding = len(rows_with_embedding)
    capped = events_with_embedding > MAX_EVENTS_PER_RUN

    raw = [
        RawEvent(
            id=int(r.id),
            embedding_enc=bytes(r.embedding),
            face_crop_path=str(r.face_crop_path) if r.face_crop_path else None,
            captured_at=r.captured_at,
            camera_id=int(r.camera_id),
            camera_name=str(r.camera_name),
        )
        for r in rows_with_embedding
    ]

    all_clusters = cluster_events(raw, threshold=threshold)

    # Apply min_count filter.
    all_clusters = [c for c in all_clusters if c.count >= min_count]
    total_clusters = len(all_clusters)

    # Paginate clusters.
    offset = (page - 1) * page_size
    page_clusters = all_clusters[offset : offset + page_size]

    return UnidentifiedFacesResponse(
        clusters=[
            FaceClusterOut(
                cluster_id=c.cluster_id,
                representative_event_id=c.representative_event_id,
                event_ids=c.event_ids,
                crop_event_ids=c.crop_event_ids,
                count=c.count,
                first_seen=c.first_seen,
                last_seen=c.last_seen,
                camera_ids=c.camera_ids,
                camera_names=c.camera_names,
                avg_similarity=round(c.avg_similarity, 3),
            )
            for c in page_clusters
        ],
        total_clusters=total_clusters,
        page=page,
        page_size=page_size,
        total_unidentified_events=total_events,
        events_with_embedding=events_with_embedding,
        capped=capped,
    )


@router.get("/events", response_model=UnidentifiedEventsResponse)
def list_events_for_cluster(
    user: Annotated[CurrentUser, ADMIN_HR],
    event_ids: Annotated[
        str,
        Query(description="Comma-separated list of detection_event IDs"),
    ],
) -> UnidentifiedEventsResponse:
    """Return event metadata for a specific set of IDs (used by the
    cluster detail drawer). Validates that each ID belongs to this
    tenant and is unidentified before returning."""
    scope = TenantScope(tenant_id=user.tenant_id)

    try:
        id_list = [int(x.strip()) for x in event_ids.split(",") if x.strip()]
    except ValueError:
        return UnidentifiedEventsResponse(items=[], total=0)

    if not id_list:
        return UnidentifiedEventsResponse(items=[], total=0)

    # Cap to 500 to avoid giant IN() clauses.
    id_list = id_list[:500]

    with get_engine().begin() as conn:
        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.camera_id,
                cameras.c.name.label("camera_name"),
                detection_events.c.face_crop_path,
            )
            .select_from(
                detection_events.join(
                    cameras,
                    and_(
                        cameras.c.id == detection_events.c.camera_id,
                        cameras.c.tenant_id == detection_events.c.tenant_id,
                    ),
                )
            )
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.employee_id.is_(None),
                detection_events.c.former_employee_match.is_(False),
                detection_events.c.id.in_(id_list),
            )
            .order_by(detection_events.c.captured_at.desc())
        ).all()

    items = [
        UnidentifiedEventOut(
            id=int(r.id),
            captured_at=r.captured_at,
            camera_id=int(r.camera_id),
            camera_name=str(r.camera_name),
            has_crop=bool(r.face_crop_path),
        )
        for r in rows
    ]
    return UnidentifiedEventsResponse(items=items, total=len(items))


@router.post("/map-to-employee", response_model=MapToEmployeeResponse)
def map_cluster_to_employee(
    user: Annotated[CurrentUser, ADMIN_HR],
    body: MapToEmployeeBody,
) -> MapToEmployeeResponse:
    """Map a cluster of unidentified detection events to an employee.

    For events with face crops + embeddings: copies the already-encrypted
    bytes directly to the employee's reference-photo storage (up to
    MAX_PHOTOS_PER_MAP most-recent events) and stores the existing
    embedding — no InsightFace re-inference needed.

    Updates detection_events.employee_id for ALL provided event IDs so
    they no longer surface on the unidentified-faces page.
    """
    scope = TenantScope(tenant_id=user.tenant_id)

    with get_engine().begin() as conn:
        # 1. Validate employee belongs to this tenant.
        emp_row = conn.execute(
            select(
                employees.c.id,
                employees.c.employee_code,
                employees.c.full_name,
                employees.c.status,
            ).where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.id == body.employee_id,
            )
        ).first()
        if emp_row is None:
            raise HTTPException(status_code=404, detail="employee_not_found")
        if emp_row.status == "deleted":
            raise HTTPException(status_code=422, detail="employee_is_deleted")

        # 2. Find which of the requested event IDs are still unidentified in
        #    this tenant (defend against concurrent mappings or stale IDs).
        event_rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.face_crop_path,
                detection_events.c.embedding,
                detection_events.c.captured_at,
            )
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.employee_id.is_(None),
                detection_events.c.former_employee_match.is_(False),
                detection_events.c.id.in_(body.event_ids),
            )
            .order_by(detection_events.c.captured_at.desc())
        ).all()

        valid_ids = [int(r.id) for r in event_rows]
        if not valid_ids:
            raise HTTPException(status_code=422, detail="no_valid_events")

        employee_id = int(emp_row.id)
        employee_code = str(emp_row.employee_code)
        employee_name = str(emp_row.full_name)

        # 3. Copy the caller-selected face crops as employee reference photos.
        #    Each assignment carries its own angle tag; we only copy events
        #    that exist in this tenant, are still unidentified, and have a
        #    crop + embedding on disk.
        valid_event_map = {int(r.id): r for r in event_rows}
        photo_ids: list[int] = []

        for assignment in body.photo_assignments:
            ev = valid_event_map.get(assignment.event_id)
            if ev is None or not ev.face_crop_path or not ev.embedding:
                continue
            try:
                src = Path(str(ev.face_crop_path))
                if not src.exists() or src.stat().st_size == 0:
                    continue
                encrypted_bytes = src.read_bytes()
                angle = assignment.angle

                directory = storage_dir(scope.tenant_id, employee_code, angle)
                directory.mkdir(parents=True, exist_ok=True)
                dest = directory / f"{uuid.uuid4().hex}.jpg"
                dest.write_bytes(encrypted_bytes)

                photo_id = create_photo_row(
                    conn,
                    scope,
                    employee_id=employee_id,
                    angle=angle,
                    file_path=str(dest),
                    approved_by_user_id=user.id,
                    uploaded_by_user_id=user.id,
                    approval_status="approved",
                )
                # Copy encrypted embedding bytes directly — same Fernet key, no re-inference.
                conn.execute(
                    update(employee_photos)
                    .where(
                        employee_photos.c.id == photo_id,
                        employee_photos.c.tenant_id == scope.tenant_id,
                    )
                    .values(embedding=bytes(ev.embedding))
                )
                photo_ids.append(photo_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "map_cluster: failed to copy crop for event %s: %s",
                    assignment.event_id,
                    type(exc).__name__,
                )

        # 4. Attribute all valid events to the employee.
        conn.execute(
            update(detection_events)
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(valid_ids),
            )
            .values(employee_id=employee_id)
        )

        # 5. Audit.
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="unidentified_face.mapped",
            entity_type="employee",
            entity_id=str(employee_id),
            after={
                "employee_code": employee_code,
                "employee_name": employee_name,
                "mapped_events": len(valid_ids),
                "photos_created": len(photo_ids),
            },
        )

    # 6. Invalidate matcher cache so new reference photos are used immediately.
    try:
        from maugood.identification.matcher import matcher_cache  # noqa: PLC0415

        matcher_cache.invalidate_employee(employee_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "map_cluster: cache invalidation failed: %s", type(exc).__name__
        )

    return MapToEmployeeResponse(
        mapped_events=len(valid_ids),
        photos_created=len(photo_ids),
        photo_ids=photo_ids,
    )
