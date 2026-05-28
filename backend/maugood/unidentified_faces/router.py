"""Unidentified Faces clustering endpoints.

``GET /api/unidentified-faces``
    Returns paginated face clusters computed on demand from the
    ``detection_events`` rows where ``employee_id IS NULL`` and
    ``former_employee_match = FALSE``.

    Clusters are sorted by size (largest first) then by ``last_seen``
    descending.  Pagination is over *clusters*, not events.

``GET /api/unidentified-faces/raw``
    Returns every unidentified detection event individually, paginated,
    with no similarity grouping.  Supports the "All Unknown Faces" tab
    that lets operators review every face in chronological order.

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
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import and_, func, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.db import cameras, detection_events, employee_photos, employees, get_engine
from maugood.employees.photos import create_photo_row, storage_dir
from maugood.tenants.scope import TenantScope
from maugood.unidentified_faces.clustering import (
    DEFAULT_CLUSTER_THRESHOLD,
    FaceCluster,
    MAX_EVENTS_PER_RUN,
    RawEvent,
    cluster_events,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/unidentified-faces", tags=["unidentified-faces"])


# ---------------------------------------------------------------------------
# Cluster cache
# ---------------------------------------------------------------------------
# Clustering is deterministic given (filter, threshold, dataset). We cache
# the result keyed by the filter parameters plus a cheap dataset
# fingerprint computed via a single COUNT+MAX aggregate query.  The
# fingerprint changes whenever:
#   - a new unidentified detection is inserted   (count + max_id rise)
#   - a row is mapped to an employee             (count drops)
#   - a row is deleted                           (count drops)
#   - a row's embedding lands after the fact     (with_embedding rises)
# so cache entries auto-invalidate without explicit hooks.
#
# Different thresholds produce different cache keys → moving the slider
# computes once per distinct value, then is instant for the duration the
# dataset is stable.

@dataclass
class _CachedClusterResult:
    clusters: list[FaceCluster]
    total_events: int
    events_with_embedding: int
    events_without_embedding: int
    capped: bool


_CLUSTER_CACHE_MAX = 64
_CLUSTER_CACHE: "OrderedDict[tuple, _CachedClusterResult]" = OrderedDict()
_CLUSTER_CACHE_LOCK = Lock()


def _cluster_cache_get(key: tuple) -> Optional[_CachedClusterResult]:
    with _CLUSTER_CACHE_LOCK:
        val = _CLUSTER_CACHE.get(key)
        if val is not None:
            _CLUSTER_CACHE.move_to_end(key)
        return val


def _cluster_cache_put(key: tuple, val: _CachedClusterResult) -> None:
    with _CLUSTER_CACHE_LOCK:
        _CLUSTER_CACHE[key] = val
        _CLUSTER_CACHE.move_to_end(key)
        while len(_CLUSTER_CACHE) > _CLUSTER_CACHE_MAX:
            _CLUSTER_CACHE.popitem(last=False)

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
    # Per-event metadata parallel to ``event_ids`` — see clustering module.
    # Drives in-cluster filter chips on the frontend.
    event_similarities: list[float] = []
    event_qualities: list[str] = []        # "high" | "medium" | "low" | "unknown"
    event_face_types: list[str] = []       # "front" | "side" | "partial" | "unknown"


class UnidentifiedFacesResponse(BaseModel):
    clusters: list[FaceClusterOut]
    # Pagination over clusters
    total_clusters: int
    page: int
    page_size: int
    # Summary stats for the header banner
    total_unidentified_events: int
    events_with_embedding: int
    events_without_embedding: int  # detections that have no embedding and cannot be clustered
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


class RawFaceEventOut(BaseModel):
    """One unidentified detection event with embedding presence flag."""
    id: int
    captured_at: datetime
    camera_id: int
    camera_name: str
    has_crop: bool
    has_embedding: bool


class RawUnidentifiedResponse(BaseModel):
    items: list[RawFaceEventOut]
    total: int
    page: int
    page_size: int
    events_without_embedding: int   # total across date range, regardless of filter


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
# "Mapped Employees" sub-tab schemas
# ---------------------------------------------------------------------------
# These power the secondary tabs introduced under both "All Unknown Faces"
# and "Similarity Groups": instead of clustering or listing unidentified
# detections, they surface detections that DO have an ``employee_id``
# — i.e. faces that were already attributed to a real employee (either
# matched live or mapped by an operator via Map-to-Employee).
#
# Same filter envelope as the unidentified views (date range + camera +
# pagination) so an operator can pivot between "what's unknown" and
# "what's mapped" without losing their place.


class MappedFaceEventOut(BaseModel):
    """One mapped detection event — flat list view (parallels
    ``RawFaceEventOut`` but with the employee join attached)."""

    id: int
    captured_at: datetime
    camera_id: int
    camera_name: str
    has_crop: bool
    employee_id: int
    employee_name: Optional[str] = None
    employee_code: Optional[str] = None
    confidence: Optional[float] = None  # NULL for legacy / hand-mapped rows


class MappedFacesResponse(BaseModel):
    items: list[MappedFaceEventOut]
    total: int
    page: int
    page_size: int


class MappedEmployeeGroupOut(BaseModel):
    """One employee with their mapped-detection rollup — cluster view
    grouped by employee_id (parallels ``FaceClusterOut`` but anchored
    to a real identity instead of a centroid)."""

    employee_id: int
    employee_name: Optional[str] = None
    employee_code: Optional[str] = None
    count: int
    first_seen: datetime
    last_seen: datetime
    camera_ids: list[int]
    camera_names: list[str]
    # Up to 8 most recent crop event_ids so the card can render preview
    # tiles + the modal gallery can navigate without a follow-up call.
    sample_event_ids: list[int]
    avg_confidence: Optional[float] = None


class MappedEmployeesResponse(BaseModel):
    items: list[MappedEmployeeGroupOut]
    total: int
    page: int
    page_size: int
    total_events: int  # sum of count across every employee in the filter
    total_employees: int  # distinct employees touched


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

    # Common filter used by both the fingerprint and the full select.
    def _apply_filter(stmt):
        stmt = stmt.where(
            detection_events.c.tenant_id == scope.tenant_id,
            detection_events.c.employee_id.is_(None),
            detection_events.c.former_employee_match.is_(False),
        )
        if camera_id is not None:
            stmt = stmt.where(detection_events.c.camera_id == camera_id)
        if start is not None:
            stmt = stmt.where(detection_events.c.captured_at >= start)
        if end is not None:
            stmt = stmt.where(detection_events.c.captured_at <= end)
        return stmt

    fingerprint_q = _apply_filter(
        select(
            func.count(detection_events.c.id).label("total"),
            func.count(detection_events.c.embedding).label("with_emb"),
            func.max(detection_events.c.id).label("max_id"),
        )
    )

    with get_engine().begin() as conn:
        fp = conn.execute(fingerprint_q).first()
        fp_total = int(fp.total or 0) if fp else 0
        fp_with_emb = int(fp.with_emb or 0) if fp else 0
        fp_max_id = int(fp.max_id) if fp and fp.max_id is not None else 0

        # Cache key — filter identity + dataset fingerprint. Any change to
        # the underlying rows (insert/map/delete/embedding-fill) flips at
        # least one of (total, with_emb, max_id).
        cache_key = (
            scope.tenant_id,
            start.isoformat() if start else None,
            end.isoformat() if end else None,
            camera_id,
            round(threshold, 4),
            fp_total,
            fp_with_emb,
            fp_max_id,
        )

        cached = _cluster_cache_get(cache_key)
        if cached is not None:
            all_clusters_unfiltered = cached.clusters
            total_events = cached.total_events
            events_with_embedding = cached.events_with_embedding
            events_without_embedding = cached.events_without_embedding
            capped = cached.capped
        else:
            base = (
                _apply_filter(
                    select(
                        detection_events.c.id,
                        detection_events.c.embedding,
                        detection_events.c.face_crop_path,
                        detection_events.c.captured_at,
                        detection_events.c.camera_id,
                        detection_events.c.bbox,
                        cameras.c.name.label("camera_name"),
                    ).select_from(
                        detection_events.join(
                            cameras,
                            and_(
                                cameras.c.id == detection_events.c.camera_id,
                                cameras.c.tenant_id == detection_events.c.tenant_id,
                            ),
                        )
                    )
                )
                .order_by(detection_events.c.captured_at.desc())
            )
            rows = conn.execute(base).all()
            total_events = len(rows)
            rows_with_embedding = [r for r in rows if r.embedding is not None]
            events_with_embedding = len(rows_with_embedding)
            events_without_embedding = total_events - events_with_embedding
            capped = events_with_embedding > MAX_EVENTS_PER_RUN

            raw = [
                RawEvent(
                    id=int(r.id),
                    embedding_enc=bytes(r.embedding),
                    face_crop_path=str(r.face_crop_path) if r.face_crop_path else None,
                    captured_at=r.captured_at,
                    camera_id=int(r.camera_id),
                    camera_name=str(r.camera_name),
                    bbox=dict(r.bbox) if r.bbox else None,
                )
                for r in rows_with_embedding
            ]

            all_clusters_unfiltered = cluster_events(raw, threshold=threshold)
            _cluster_cache_put(
                cache_key,
                _CachedClusterResult(
                    clusters=all_clusters_unfiltered,
                    total_events=total_events,
                    events_with_embedding=events_with_embedding,
                    events_without_embedding=events_without_embedding,
                    capped=capped,
                ),
            )

    # min_count is a cheap post-filter — keep it out of the cache key so
    # operators can tweak it without forcing a re-cluster.
    all_clusters = [c for c in all_clusters_unfiltered if c.count >= min_count]
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
                event_similarities=[round(s, 3) for s in c.event_similarities],
                event_qualities=c.event_qualities,
                event_face_types=c.event_face_types,
            )
            for c in page_clusters
        ],
        total_clusters=total_clusters,
        page=page,
        page_size=page_size,
        total_unidentified_events=total_events,
        events_with_embedding=events_with_embedding,
        events_without_embedding=events_without_embedding,
        capped=capped,
    )


@router.get("/raw", response_model=RawUnidentifiedResponse)
def list_raw_unidentified(
    user: Annotated[CurrentUser, ADMIN_HR],
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    camera_id: Annotated[Optional[int], Query()] = None,
    has_embedding: Annotated[Optional[bool], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 48,
) -> RawUnidentifiedResponse:
    """All unidentified events, paginated, with no clustering.

    Powers the "All Unknown Faces" tab.  Supports an optional
    ``has_embedding`` filter so operators can focus on events that can
    (or cannot) be similarity-clustered.  The ``events_without_embedding``
    summary count is always the full date-range total, regardless of the
    ``has_embedding`` filter value, so the banner never disappears.
    """
    scope = TenantScope(tenant_id=user.tenant_id)
    if start is None:
        start = _default_start()

    # Conditions shared by all three queries below.
    base = [
        detection_events.c.tenant_id == scope.tenant_id,
        detection_events.c.employee_id.is_(None),
        detection_events.c.former_employee_match.is_(False),
    ]
    if camera_id is not None:
        base.append(detection_events.c.camera_id == camera_id)
    if start is not None:
        base.append(detection_events.c.captured_at >= start)
    if end is not None:
        base.append(detection_events.c.captured_at <= end)

    # Filtered conditions (may also include the embedding filter).
    filtered = list(base)
    if has_embedding is True:
        filtered.append(detection_events.c.embedding.isnot(None))
    elif has_embedding is False:
        filtered.append(detection_events.c.embedding.is_(None))

    join_from = detection_events.join(
        cameras,
        and_(
            cameras.c.id == detection_events.c.camera_id,
            cameras.c.tenant_id == detection_events.c.tenant_id,
        ),
    )

    with get_engine().begin() as conn:
        # Total matching the (possibly filtered) conditions.
        total = conn.execute(
            select(func.count())
            .select_from(detection_events)
            .where(*filtered)
        ).scalar_one()

        # No-embedding count — always uses the unfiltered base so the
        # summary banner shows the true picture regardless of filter.
        events_without_embedding = conn.execute(
            select(func.count())
            .select_from(detection_events)
            .where(*base, detection_events.c.embedding.is_(None))
        ).scalar_one()

        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.camera_id,
                cameras.c.name.label("camera_name"),
                detection_events.c.face_crop_path,
                detection_events.c.embedding,
            )
            .select_from(join_from)
            .where(*filtered)
            .order_by(detection_events.c.captured_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()

    items = [
        RawFaceEventOut(
            id=int(r.id),
            captured_at=r.captured_at,
            camera_id=int(r.camera_id),
            camera_name=str(r.camera_name),
            has_crop=bool(r.face_crop_path),
            has_embedding=r.embedding is not None,
        )
        for r in rows
    ]

    return RawUnidentifiedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        events_without_embedding=int(events_without_embedding),
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


# ---------------------------------------------------------------------------
# Mapped Employees endpoints (sub-tabs under both top tabs)
# ---------------------------------------------------------------------------
# ``/mapped``           — flat paginated list (powers "All Unknown Faces →
#                          Mapped Employees")
# ``/mapped-clusters``  — grouped by employee_id (powers "Similarity
#                          Groups → Mapped Employees")
#
# Same date/camera filter shape as ``/raw`` so the surrounding filter
# bar in the UI works unchanged when the operator pivots tabs.


@router.get("/mapped", response_model=MappedFacesResponse)
def list_mapped_events(
    user: Annotated[CurrentUser, ADMIN_HR],
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    camera_id: Annotated[Optional[int], Query()] = None,
    employee_id: Annotated[Optional[int], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 48,
) -> MappedFacesResponse:
    """Detection events with a real ``employee_id`` set.

    Excludes ``former_employee_match=true`` rows so a deleted/inactive
    employee re-detection (P28.7 lifecycle path) doesn't pollute the
    Mapped Employees view — those have a dedicated report.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    if start is None:
        start = _default_start()

    conditions = [
        detection_events.c.tenant_id == scope.tenant_id,
        detection_events.c.employee_id.isnot(None),
        detection_events.c.former_employee_match.is_(False),
    ]
    if camera_id is not None:
        conditions.append(detection_events.c.camera_id == camera_id)
    if employee_id is not None:
        conditions.append(detection_events.c.employee_id == employee_id)
    if start is not None:
        conditions.append(detection_events.c.captured_at >= start)
    if end is not None:
        conditions.append(detection_events.c.captured_at <= end)

    join_from = (
        detection_events
        .join(
            cameras,
            and_(
                cameras.c.id == detection_events.c.camera_id,
                cameras.c.tenant_id == detection_events.c.tenant_id,
            ),
        )
        .outerjoin(
            employees,
            and_(
                employees.c.id == detection_events.c.employee_id,
                employees.c.tenant_id == detection_events.c.tenant_id,
            ),
        )
    )

    with get_engine().begin() as conn:
        total = conn.execute(
            select(func.count())
            .select_from(detection_events)
            .where(*conditions)
        ).scalar_one()

        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.camera_id,
                cameras.c.name.label("camera_name"),
                detection_events.c.face_crop_path,
                detection_events.c.employee_id,
                detection_events.c.confidence,
                employees.c.full_name.label("employee_name"),
                employees.c.employee_code,
            )
            .select_from(join_from)
            .where(*conditions)
            .order_by(detection_events.c.captured_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()

    items = [
        MappedFaceEventOut(
            id=int(r.id),
            captured_at=r.captured_at,
            camera_id=int(r.camera_id),
            camera_name=str(r.camera_name),
            has_crop=bool(r.face_crop_path),
            employee_id=int(r.employee_id),
            employee_name=str(r.employee_name) if r.employee_name else None,
            employee_code=str(r.employee_code) if r.employee_code else None,
            confidence=float(r.confidence) if r.confidence is not None else None,
        )
        for r in rows
    ]
    return MappedFacesResponse(
        items=items,
        total=int(total),
        page=page,
        page_size=page_size,
    )


@router.get("/mapped-clusters", response_model=MappedEmployeesResponse)
def list_mapped_clusters(
    user: Annotated[CurrentUser, ADMIN_HR],
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    camera_id: Annotated[Optional[int], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 24,
) -> MappedEmployeesResponse:
    """Group mapped detection events by employee_id.

    Returns one entry per employee with their count + first/last seen +
    camera names + up to 8 sample event_ids (newest first, only events
    with a crop on disk so the UI can preview).

    Pagination is over employees, not events; the result is ordered by
    count desc (most-active employee first) then by employee name.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    if start is None:
        start = _default_start()

    base_conditions = [
        detection_events.c.tenant_id == scope.tenant_id,
        detection_events.c.employee_id.isnot(None),
        detection_events.c.former_employee_match.is_(False),
    ]
    if camera_id is not None:
        base_conditions.append(detection_events.c.camera_id == camera_id)
    if start is not None:
        base_conditions.append(detection_events.c.captured_at >= start)
    if end is not None:
        base_conditions.append(detection_events.c.captured_at <= end)

    with get_engine().begin() as conn:
        # Aggregate per employee. Camera names are aggregated as a
        # comma-separated string via string_agg(DISTINCT …) because
        # array_agg over a joined column requires extra GROUP BY.
        agg_rows = conn.execute(
            select(
                detection_events.c.employee_id,
                employees.c.full_name.label("employee_name"),
                employees.c.employee_code,
                func.count(detection_events.c.id).label("count"),
                func.min(detection_events.c.captured_at).label("first_seen"),
                func.max(detection_events.c.captured_at).label("last_seen"),
                func.avg(detection_events.c.confidence).label("avg_confidence"),
            )
            .select_from(
                detection_events.outerjoin(
                    employees,
                    and_(
                        employees.c.id == detection_events.c.employee_id,
                        employees.c.tenant_id == detection_events.c.tenant_id,
                    ),
                )
            )
            .where(*base_conditions)
            .group_by(
                detection_events.c.employee_id,
                employees.c.full_name,
                employees.c.employee_code,
            )
            .order_by(
                func.count(detection_events.c.id).desc(),
                employees.c.full_name.asc(),
            )
        ).all()

        total_employees = len(agg_rows)
        total_events = sum(int(r.count) for r in agg_rows)

        # Page the aggregate result.
        offset = (page - 1) * page_size
        page_rows = agg_rows[offset : offset + page_size]
        if not page_rows:
            return MappedEmployeesResponse(
                items=[],
                total=total_employees,
                page=page,
                page_size=page_size,
                total_events=total_events,
                total_employees=total_employees,
            )

        page_emp_ids = [int(r.employee_id) for r in page_rows]

        # Per-page camera-name list. One SELECT — group by employee +
        # camera, then fold client-side. Keeps the SQL portable and
        # bounded since ``page_emp_ids`` is ≤ ``page_size``.
        cam_rows = conn.execute(
            select(
                detection_events.c.employee_id,
                detection_events.c.camera_id,
                cameras.c.name.label("camera_name"),
                func.count(detection_events.c.id).label("cam_count"),
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
                *base_conditions,
                detection_events.c.employee_id.in_(page_emp_ids),
            )
            .group_by(
                detection_events.c.employee_id,
                detection_events.c.camera_id,
                cameras.c.name,
            )
        ).all()

        cams_by_emp: dict[int, list[tuple[int, str]]] = {}
        for cr in cam_rows:
            cams_by_emp.setdefault(int(cr.employee_id), []).append(
                (int(cr.camera_id), str(cr.camera_name))
            )

        # Per-page sample event_ids (most-recent crop events, max 8 per
        # employee). One pass with row_number() WITHIN PARTITION would
        # be cleaner but adds a window-function dependency for marginal
        # win — the iteration below keeps the SQL surface tiny.
        sample_rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.employee_id,
                detection_events.c.captured_at,
            )
            .where(
                *base_conditions,
                detection_events.c.employee_id.in_(page_emp_ids),
                detection_events.c.face_crop_path.isnot(None),
            )
            .order_by(detection_events.c.captured_at.desc())
        ).all()

        samples_by_emp: dict[int, list[int]] = {}
        for s in sample_rows:
            eid = int(s.employee_id)
            bucket = samples_by_emp.setdefault(eid, [])
            if len(bucket) < 8:
                bucket.append(int(s.id))

    items: list[MappedEmployeeGroupOut] = []
    for r in page_rows:
        eid = int(r.employee_id)
        cams = cams_by_emp.get(eid, [])
        items.append(
            MappedEmployeeGroupOut(
                employee_id=eid,
                employee_name=str(r.employee_name) if r.employee_name else None,
                employee_code=str(r.employee_code) if r.employee_code else None,
                count=int(r.count),
                first_seen=r.first_seen,
                last_seen=r.last_seen,
                camera_ids=[c[0] for c in cams],
                camera_names=[c[1] for c in cams],
                sample_event_ids=samples_by_emp.get(eid, []),
                avg_confidence=(
                    float(r.avg_confidence) if r.avg_confidence is not None else None
                ),
            )
        )

    return MappedEmployeesResponse(
        items=items,
        total=total_employees,
        page=page,
        page_size=page_size,
        total_events=total_events,
        total_employees=total_employees,
    )
