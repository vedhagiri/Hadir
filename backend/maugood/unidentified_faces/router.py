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
from maugood.employees.photos import (
    MAX_REFERENCE_PHOTOS_PER_EMPLOYEE,
    content_sha256,
    count_photos,
    create_photo_row,
    decrypt_bytes,
    photo_hash_exists,
    storage_dir,
)
from maugood.tenants.scope import TenantScope, get_tenant_scope
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


def _cluster_cache_evict_tenant(tenant_id: int) -> int:
    """Drop every cached cluster result for this tenant.

    Called after any write that changes which events are unidentified
    (currently: ``map_cluster_to_employee``). Defence in depth on top
    of the fingerprint-based key invalidation — the cache key already
    flips on a ``count(employee_id IS NULL)`` drop, but evicting on
    write means a stale entry can never linger even if the fingerprint
    math drifts in a future change.
    """
    evicted = 0
    with _CLUSTER_CACHE_LOCK:
        # The cache key is a tuple whose first element is tenant_id.
        # Collect → delete to avoid mutating during iteration.
        targets = [k for k in _CLUSTER_CACHE if k and k[0] == tenant_id]
        for k in targets:
            del _CLUSTER_CACHE[k]
            evicted += 1
    return evicted

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
# Two-workflow Map-to-Employee schemas (reference vs attendance)
# ---------------------------------------------------------------------------
# Both workflows attribute the chosen events to ``employee_id`` (which
# removes them from Unknown Faces / Similarity Groups) AND recompute
# attendance for every tenant-local date the events touch — the
# attribution is a real fact and every downstream surface that reads
# off ``detection_events.employee_id`` or ``attendance_records`` would
# go stale otherwise. They differ in the *additional* training-side
# effect that's appropriate for the operator's intent:
#
#   Reference Image Mapping
#     - Copies selected face crops into ``employee_photos`` (training
#       set) so future automatic matching gets stronger.
#     - Invalidates the matcher cache so the new reference vectors are
#       picked up immediately by the live capture pipeline.
#
#   Attendance Event Mapping
#     - Does NOT copy crops as reference photos (the operator is
#       correcting a missed attribution, not curating training data).
#     - Does NOT invalidate matcher cache (no training data changed).
#
# Schema split rather than a single endpoint with a ``mode`` field
# because the response shape, the audit action, and the downstream
# data-sync semantics differ between the two — keeping them as
# distinct endpoints makes the operator's intent explicit in audit
# rows and removes branching from the request body.


class MapAsReferenceBody(BaseModel):
    employee_id: int
    event_ids: list[int]
    photo_assignments: list[PhotoAssignment] = []

    @field_validator("event_ids")
    @classmethod
    def _validate_event_ids(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("event_ids must not be empty")
        return v[:200]


class MapAsAttendanceBody(BaseModel):
    """Attendance correction — no photo copies, attendance recompute on."""

    employee_id: int
    event_ids: list[int]

    @field_validator("event_ids")
    @classmethod
    def _validate_event_ids(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("event_ids must not be empty")
        return v[:200]


class MapAsAttendanceResponse(BaseModel):
    mapped_events: int
    employee_id: int
    employee_name: Optional[str] = None
    employee_code: Optional[str] = None
    # ISO date strings (YYYY-MM-DD) for every tenant-local calendar day
    # that had at least one attribution + recompute. Surfaced so the
    # UI can pivot the operator to "review attendance for these dates".
    attendance_dates_recomputed: list[str]


class UnmapEventsBody(BaseModel):
    """Revert a previous Map-to-Employee operation.

    Accepts a list of detection_event IDs. Every row in the list that
    has ``employee_id IS NOT NULL`` gets its attribution cleared so the
    event returns to the unidentified pool. Rows without an employee_id
    are silently ignored (idempotent).
    """

    event_ids: list[int]

    @field_validator("event_ids")
    @classmethod
    def _validate_event_ids(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("event_ids must not be empty")
        return v[:200]


class UnmapEventsResponse(BaseModel):
    unmapped_events: int
    affected_employee_ids: list[int]
    # ISO date strings (YYYY-MM-DD) — every tenant-local day where at
    # least one attendance row got recomputed after the unmap.
    attendance_dates_recomputed: list[str]


class UnmapByEmployeeBody(BaseModel):
    """Per-employee bulk revert — unmaps every event attributed to
    ``employee_id`` within the same date/camera envelope the Mapped
    Employees view used. Used by the "Unmap" button on each employee
    rollup card so the operator's intent ("revert this entire
    mapping") matches the click.
    """

    employee_id: int
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    camera_id: Optional[int] = None


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
    # Migration 0067. ``manual_reference`` or ``manual_attendance``
    # (the ``/mapped`` endpoint filters auto-matches out, but the field
    # is still surfaced so the UI can show a per-row chip).
    mapping_source: Optional[str] = None


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
    # Migration 0067. Set of distinct ``mapping_source`` values across
    # the rows that contributed to this group — the cluster card can
    # show a chip ("Reference", "Attendance", or "Mixed") without
    # fetching individual rows.
    mapping_sources: list[str] = []


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
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> MapToEmployeeResponse:
    """Map a cluster of unidentified detection events to an employee.

    For events with face crops + embeddings: copies the already-encrypted
    bytes directly to the employee's reference-photo storage (up to
    MAX_PHOTOS_PER_MAP most-recent events) and stores the existing
    embedding — no InsightFace re-inference needed.

    Updates detection_events.employee_id for ALL provided event IDs so
    they no longer surface on the unidentified-faces page. Attendance
    rows for every tenant-local date covered by the events are
    recomputed so the daily attendance view, the calendar, and the
    day-detail drawer reflect the new attribution immediately.
    """
    # Recompute helpers are local-imported to avoid a circular at module
    # load time (scheduler imports from maugood.attendance.repository
    # which imports from db, which we re-enter here).
    from maugood.attendance import scheduler as att_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    affected_dates: set = set()

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
        # Same per-employee cap + duplicate guard as the upload paths.
        # Crops are system-generated images so type/size validation is
        # not applicable; the count cap and content-hash dedup are.
        current_count = count_photos(conn, scope, employee_id)
        seen_hashes: set[str] = set()

        for assignment in body.photo_assignments:
            ev = valid_event_map.get(assignment.event_id)
            if ev is None or not ev.face_crop_path or not ev.embedding:
                continue
            if current_count >= MAX_REFERENCE_PHOTOS_PER_EMPLOYEE:
                # Employee already at the reference-image cap — stop
                # copying crops (events are still attributed below).
                break
            try:
                src = Path(str(ev.face_crop_path))
                if not src.exists() or src.stat().st_size == 0:
                    continue
                encrypted_bytes = src.read_bytes()
                angle = assignment.angle

                # Duplicate guard — hash the plaintext so a crop dedupes
                # against uploaded reference images too. Best-effort: if
                # decrypt fails the photo still stores with a null hash.
                sha: Optional[str] = None
                try:
                    sha = content_sha256(decrypt_bytes(encrypted_bytes))
                except Exception:  # noqa: BLE001
                    sha = None
                if sha is not None and (
                    sha in seen_hashes
                    or photo_hash_exists(conn, scope, employee_id, sha)
                ):
                    continue

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
                    content_sha256=sha,
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
                if sha is not None:
                    seen_hashes.add(sha)
                current_count += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "map_cluster: failed to copy crop for event %s: %s",
                    assignment.event_id,
                    type(exc).__name__,
                )

        # 4. Attribute all valid events to the employee. ``mapping_source``
        #    is tagged ``manual_reference`` (migration 0067) so the
        #    Mapped Employees review tabs surface these rows — auto-
        #    matches stay filtered out.
        conn.execute(
            update(detection_events)
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(valid_ids),
            )
            .values(
                employee_id=employee_id,
                mapping_source="manual_reference",
            )
        )

        # 4b. Compute the unique tenant-local calendar days touched by
        #     the events so we can recompute their attendance rows
        #     post-commit. ``captured_at`` is TIMESTAMPTZ (UTC) — convert
        #     via the tenant's configured timezone (P11) so the dates
        #     align with what the attendance engine keys on.
        settings = load_tenant_settings(conn, scope)
        tz = local_tz_for(settings)
        for r in event_rows:
            ts = r.captured_at
            if ts is None:
                continue
            local = ts.astimezone(tz)
            affected_dates.add(local.date())

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
                "attendance_dates": sorted(d.isoformat() for d in affected_dates),
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

    # 7. Defence-in-depth: drop the tenant's entries from the cluster
    #    cache so the next /api/unidentified-faces call computes a fresh
    #    clustering against the post-map dataset. The fingerprint key
    #    already changes on this write (employee_id IS NULL count drops),
    #    so a stale entry would never be looked up — but evicting on
    #    write costs ~µs and removes the dependency on the math.
    evicted = _cluster_cache_evict_tenant(scope.tenant_id)
    if evicted:
        logger.debug(
            "map_cluster: evicted %d stale cluster cache entries for tenant %d",
            evicted, scope.tenant_id,
        )

    # 8. Recompute attendance for each affected (employee, date). The
    #    helper handles its own transactional boundary and is
    #    idempotent. A failure on one date doesn't abort the others —
    #    we log and continue so partial recovery is still useful. This
    #    is what makes the Day Detail Drawer + Daily Attendance row
    #    + Calendar pivot pick up the new attribution without an
    #    operator-triggered "Regenerate".
    for the_date in sorted(affected_dates):
        try:
            att_scheduler.recompute_for(
                scope, employee_id=employee_id, the_date=the_date
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "map_cluster: recompute failed employee=%d date=%s: %s",
                employee_id, the_date, type(exc).__name__,
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
    """Manually-mapped detection events.

    Filters to the two operator-triggered mapping sources
    (``manual_reference`` / ``manual_attendance``) — auto live-matches
    are excluded because the Mapped Employees tab is for review of
    corrective / curated work, not the auto-match firehose. Camera
    Logs is the surface for auto-matched detections.

    Also excludes ``former_employee_match=true`` rows so a deleted/
    inactive employee re-detection (P28.7 lifecycle path) doesn't
    pollute the view — those have a dedicated report.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    if start is None:
        start = _default_start()

    conditions = [
        detection_events.c.tenant_id == scope.tenant_id,
        detection_events.c.employee_id.isnot(None),
        detection_events.c.former_employee_match.is_(False),
        # Migration 0067 — manual mappings only.
        detection_events.c.mapping_source.in_(
            ["manual_reference", "manual_attendance"]
        ),
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
                detection_events.c.mapping_source,
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
            mapping_source=(
                str(r.mapping_source) if r.mapping_source is not None else None
            ),
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
    """Group manually-mapped detection events by employee_id.

    Returns one entry per employee with their count + first/last seen +
    camera names + up to 8 sample event_ids (newest first, only events
    with a crop on disk so the UI can preview). Filters to the two
    operator-triggered mapping sources (``manual_reference`` /
    ``manual_attendance``) — auto live-matches are excluded because
    the Mapped Employees subtab is for review of corrective / curated
    work (migration 0067).

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
        # Migration 0067 — manual mappings only.
        detection_events.c.mapping_source.in_(
            ["manual_reference", "manual_attendance"]
        ),
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

        # Distinct mapping_source values per employee on this page so
        # the cluster card chip can render "Reference" / "Attendance" /
        # "Mixed" without fetching individual rows (migration 0067).
        source_rows = conn.execute(
            select(
                detection_events.c.employee_id,
                detection_events.c.mapping_source,
            )
            .where(
                *base_conditions,
                detection_events.c.employee_id.in_(page_emp_ids),
            )
            .distinct()
        ).all()
        sources_by_emp: dict[int, list[str]] = {}
        for sr in source_rows:
            if sr.mapping_source is None:
                continue
            bucket_s = sources_by_emp.setdefault(int(sr.employee_id), [])
            if sr.mapping_source not in bucket_s:
                bucket_s.append(str(sr.mapping_source))

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
                mapping_sources=sorted(sources_by_emp.get(eid, [])),
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


# ---------------------------------------------------------------------------
# Map-to-Employee — Reference workflow
# ---------------------------------------------------------------------------


@router.post("/map-as-reference", response_model=MapToEmployeeResponse)
def map_as_reference(
    user: Annotated[CurrentUser, ADMIN_HR],
    body: MapAsReferenceBody,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> MapToEmployeeResponse:
    """Reference Image Mapping — improve future recognition.

    Attributes every selected event to ``employee_id`` (removing them
    from the unidentified pool) AND copies the operator-selected
    crops into ``employee_photos`` for training. Matcher cache is
    invalidated so the live pipeline starts matching against the new
    reference vectors on the very next capture.

    Attendance is recomputed for every tenant-local date covered by
    the events — the attribution side-effect is identical to the
    ``/map-as-attendance`` workflow, only the additional
    reference-photo copy step is different. Without the recompute the
    Day Detail Drawer + Daily Attendance row + Calendar would lag
    behind ``detection_events.employee_id`` (which they read off live)
    until the next 15-min scheduler tick.
    """
    # The reference workflow is byte-for-byte equivalent to the
    # legacy ``map-to-employee`` endpoint — we just expose it under
    # a name that names the operator's intent. Keeping a single
    # implementation prevents drift between the two surfaces.
    legacy_body = MapToEmployeeBody(
        employee_id=body.employee_id,
        event_ids=body.event_ids,
        photo_assignments=body.photo_assignments,
    )
    return map_cluster_to_employee(user=user, body=legacy_body, scope=scope)


# ---------------------------------------------------------------------------
# Map-to-Employee — Attendance workflow
# ---------------------------------------------------------------------------


@router.post("/map-as-attendance", response_model=MapAsAttendanceResponse)
def map_as_attendance(
    user: Annotated[CurrentUser, ADMIN_HR],
    body: MapAsAttendanceBody,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> MapAsAttendanceResponse:
    """Attendance Event Mapping — correct a missed live match.

    Attributes every selected event to ``employee_id`` (removing them
    from the unidentified pool), then triggers an attendance recompute
    for every tenant-local calendar day covered by the events. Camera
    Logs / Matched Clips / Day Detail Drawer all reflect the new
    attribution immediately because they read straight off
    ``detection_events.employee_id``; the recompute additionally
    refreshes the ``attendance_records`` row so the per-day timeline
    + status pill update for the operator.

    No reference photos are copied — that's the
    ``/map-as-reference`` workflow's job. Use this when you're
    fixing a missed attribution for a real attendance event, not
    when you're curating training data.
    """
    # Tenant-local timezone — used to convert event captured_at (UTC)
    # into the calendar day that attendance_records is keyed on.
    # ``load_tenant_settings`` + ``local_tz_for`` live alongside the
    # attendance repository (not in a standalone ``tenant_settings``
    # module — that was a first-guess wrong path that 500'd at import).
    from maugood.attendance import scheduler as att_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    with get_engine().begin() as conn:
        # 1. Validate employee.
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

        # 2. Pull still-unidentified events.
        event_rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
            )
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.employee_id.is_(None),
                detection_events.c.former_employee_match.is_(False),
                detection_events.c.id.in_(body.event_ids),
            )
        ).all()

        valid_ids = [int(r.id) for r in event_rows]
        if not valid_ids:
            raise HTTPException(status_code=422, detail="no_valid_events")

        employee_id = int(emp_row.id)
        employee_code = str(emp_row.employee_code)
        employee_name = str(emp_row.full_name)

        # 3. Attribute every event in one bulk UPDATE. ``mapping_source``
        #    is tagged ``manual_attendance`` (migration 0067) so the
        #    Mapped Employees review tabs include these rows.
        conn.execute(
            update(detection_events)
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(valid_ids),
            )
            .values(
                employee_id=employee_id,
                mapping_source="manual_attendance",
            )
        )

        # 4. Compute the unique tenant-local calendar days touched by
        #    the events. ``captured_at`` is UTC; convert via the
        #    tenant's configured timezone so the dates align with
        #    what the attendance engine expects.
        settings = load_tenant_settings(conn, scope)
        tz = local_tz_for(settings)
        dates: set = set()
        for r in event_rows:
            ts = r.captured_at
            if ts is None:
                continue
            # ``captured_at`` is stored as TIMESTAMPTZ → already aware.
            local = ts.astimezone(tz)
            dates.add(local.date())

        # 5. Audit BEFORE recompute so the audit row exists even if
        #    one of the recomputes raises.
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="unidentified_face.mapped_attendance",
            entity_type="employee",
            entity_id=str(employee_id),
            after={
                "employee_code": employee_code,
                "employee_name": employee_name,
                "mapped_events": len(valid_ids),
                "attendance_dates": sorted(d.isoformat() for d in dates),
            },
        )

    # 6. Defence in depth: drop the tenant's cluster cache entries.
    evicted = _cluster_cache_evict_tenant(scope.tenant_id)
    if evicted:
        logger.debug(
            "map_as_attendance: evicted %d stale cluster cache entries "
            "for tenant %d",
            evicted, scope.tenant_id,
        )

    # 7. Recompute attendance for each affected (employee, date). The
    #    helper handles its own transactional boundary and is
    #    idempotent. A failure on one date doesn't abort the others —
    #    we log and continue so partial recovery is still useful.
    recomputed: list[str] = []
    for the_date in sorted(dates):
        try:
            if att_scheduler.recompute_for(
                scope, employee_id=employee_id, the_date=the_date
            ):
                recomputed.append(the_date.isoformat())
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "map_as_attendance: recompute failed employee=%d date=%s: %s",
                employee_id, the_date, type(exc).__name__,
            )

    return MapAsAttendanceResponse(
        mapped_events=len(valid_ids),
        employee_id=employee_id,
        employee_name=employee_name,
        employee_code=employee_code,
        attendance_dates_recomputed=recomputed,
    )


# ---------------------------------------------------------------------------
# Unmap — revert a previous Map-to-Employee operation
# ---------------------------------------------------------------------------


@router.post("/unmap-events", response_model=UnmapEventsResponse)
def unmap_events(
    user: Annotated[CurrentUser, ADMIN_HR],
    body: UnmapEventsBody,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> UnmapEventsResponse:
    """Revert mapped events back to the unidentified pool.

    Per-row effect:
      * ``detection_events.employee_id`` → NULL.
      * ``detection_events.former_employee_match`` → False AND
        ``former_match_employee_id`` → NULL — so the row is fully
        unattributed and shows up in Unknown Faces / Similarity Groups
        on the next read. The operator can re-map later (correct
        employee, training, or attendance) without state mismatches.
      * ``confidence`` left alone — it's a historical match score, not
        an attribution flag, and clearing it would erase forensic info.

    Side-effects:
      * For every (previous_employee_id, tenant_local_date) pair the
        unmapped events covered, attendance is recomputed (the
        employee's in/out times will shift if these events were the
        boundary detections).
      * Matcher cache is invalidated for every previously-attributed
        employee. The next live capture re-evaluates from scratch.
      * Cluster cache is evicted for the tenant — the events
        re-entering the unidentified pool change the fingerprint, but
        we evict explicitly so the next /api/unidentified-faces call
        is guaranteed fresh.

    What's NOT touched:
      * Reference photos copied via the Reference workflow stay on
        ``employee_photos`` — they're an independent asset; delete
        them via Employee → Reference Photos if they were copied
        from these specific events. The unmap audit row carries the
        affected event IDs so an operator can reconcile if needed.
    """
    from maugood.attendance import scheduler as att_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    # Dedup so a sloppy frontend doesn't re-fire the same row.
    event_ids = list(dict.fromkeys(body.event_ids))

    with get_engine().begin() as conn:
        # Snapshot every targeted row's previous attribution. Filter on
        # the live employee_id (or former_match_employee_id) so a row
        # that's already unattributed is a no-op for that ID.
        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.employee_id,
                detection_events.c.former_match_employee_id,
                detection_events.c.former_employee_match,
            )
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(event_ids),
            )
        ).all()

        # Filter to rows that actually have something to unmap.
        affected_rows = [
            r for r in rows
            if r.employee_id is not None or r.former_employee_match
        ]
        if not affected_rows:
            return UnmapEventsResponse(
                unmapped_events=0,
                affected_employee_ids=[],
                attendance_dates_recomputed=[],
            )

        affected_ids = [int(r.id) for r in affected_rows]

        # Capture which employees were attributed BEFORE we clear the
        # column. Need this for: (a) attendance recompute, (b) matcher
        # cache invalidation, (c) audit row.
        emp_dates: dict[int, set] = {}
        former_only_employees: set[int] = set()
        for r in affected_rows:
            if r.employee_id is not None:
                eid = int(r.employee_id)
                if r.captured_at is not None:
                    emp_dates.setdefault(eid, set()).add(r.captured_at)
            elif r.former_match_employee_id is not None:
                former_only_employees.add(int(r.former_match_employee_id))

        affected_employees = sorted(
            set(emp_dates.keys()) | former_only_employees
        )

        # Bulk UPDATE — clear the attribution columns in one round.
        # ``mapping_source`` clears to NULL so a future re-map writes
        # the right tag (migration 0067).
        conn.execute(
            update(detection_events)
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(affected_ids),
            )
            .values(
                employee_id=None,
                former_employee_match=False,
                former_match_employee_id=None,
                mapping_source=None,
            )
        )

        # Tenant timezone — needed to convert captured_at (UTC) into the
        # calendar day attendance_records is keyed on.
        _settings = load_tenant_settings(conn, scope)
        tz = local_tz_for(_settings)
        dates_per_employee: dict[int, set] = {}
        for eid, timestamps in emp_dates.items():
            for ts in timestamps:
                dates_per_employee.setdefault(eid, set()).add(
                    ts.astimezone(tz).date()
                )

        # Audit BEFORE the recompute so the trail exists even if a
        # downstream recompute raises.
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="unidentified_face.unmapped",
            entity_type="detection_event",
            entity_id=",".join(str(i) for i in affected_ids[:20]),
            before={
                "event_ids": affected_ids,
                "previous_employee_ids": sorted(
                    {int(r.employee_id) for r in affected_rows
                     if r.employee_id is not None}
                ),
                "former_employee_ids": sorted(former_only_employees),
            },
            after={
                "unmapped_event_count": len(affected_ids),
                "attendance_dates_to_recompute": sorted(
                    d.isoformat()
                    for ds in dates_per_employee.values()
                    for d in ds
                ),
            },
        )

    # 2. Matcher cache invalidation — per affected employee. Future
    #    captures should not rely on a stale per-employee vector set
    #    (especially if the operator follows up by deleting the
    #    reference photos the mapping had created).
    try:
        from maugood.identification.matcher import matcher_cache  # noqa: PLC0415
        for eid in affected_employees:
            matcher_cache.invalidate_employee(eid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "unmap_events: matcher cache invalidation failed: %s",
            type(exc).__name__,
        )

    # 3. Cluster cache eviction — defence in depth on top of the
    #    fingerprint-based key invalidation.
    _cluster_cache_evict_tenant(scope.tenant_id)

    # 4. Attendance recompute — one call per unique (employee, date).
    #    Failures are logged but don't abort other dates.
    recomputed: set[str] = set()
    for eid, dates in dates_per_employee.items():
        for the_date in sorted(dates):
            try:
                if att_scheduler.recompute_for(
                    scope, employee_id=eid, the_date=the_date
                ):
                    recomputed.add(the_date.isoformat())
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "unmap_events: recompute failed employee=%d date=%s: %s",
                    eid, the_date, type(exc).__name__,
                )

    return UnmapEventsResponse(
        unmapped_events=len(affected_ids),
        affected_employee_ids=affected_employees,
        attendance_dates_recomputed=sorted(recomputed),
    )


@router.post("/unmap-by-employee", response_model=UnmapEventsResponse)
def unmap_by_employee(
    user: Annotated[CurrentUser, ADMIN_HR],
    body: UnmapByEmployeeBody,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
) -> UnmapEventsResponse:
    """Revert every mapped event for one employee within the same
    date/camera envelope the Mapped Employees rollup uses.

    The endpoint selects ``detection_events`` rows matching the filter
    + employee_id (or former_match_employee_id) and reuses the same
    side-effect bundle as ``/unmap-events``:

      * Clear employee_id / former_employee_match / former_match_employee_id
      * Recompute attendance for each affected (employee, date)
      * Invalidate matcher cache + evict cluster cache
      * One ``unidentified_face.unmapped`` audit row covering the
        whole batch (with event count + before/after snapshot)

    Reference photos created earlier by the Reference workflow stay
    intact — same red line as ``/unmap-events``: this endpoint reverts
    the *attribution*, not the training data.
    """
    from maugood.attendance import scheduler as att_scheduler  # noqa: PLC0415
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    # Default date range = last 7 days (matches the page default).
    start = body.start or _default_start()
    end = body.end

    with get_engine().begin() as conn:
        conds = [
            detection_events.c.tenant_id == scope.tenant_id,
            (
                (detection_events.c.employee_id == body.employee_id)
                | (
                    (detection_events.c.former_match_employee_id == body.employee_id)
                    & (detection_events.c.former_employee_match.is_(True))
                )
            ),
        ]
        if body.camera_id is not None:
            conds.append(detection_events.c.camera_id == body.camera_id)
        if start is not None:
            conds.append(detection_events.c.captured_at >= start)
        if end is not None:
            conds.append(detection_events.c.captured_at <= end)

        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.employee_id,
                detection_events.c.former_match_employee_id,
                detection_events.c.former_employee_match,
            ).where(*conds)
        ).all()

        if not rows:
            return UnmapEventsResponse(
                unmapped_events=0,
                affected_employee_ids=[],
                attendance_dates_recomputed=[],
            )

        affected_ids = [int(r.id) for r in rows]
        dates: set = set()
        _settings = load_tenant_settings(conn, scope)
        tz = local_tz_for(_settings)
        for r in rows:
            if r.captured_at is not None:
                dates.add(r.captured_at.astimezone(tz).date())

        conn.execute(
            update(detection_events)
            .where(
                detection_events.c.tenant_id == scope.tenant_id,
                detection_events.c.id.in_(affected_ids),
            )
            .values(
                employee_id=None,
                former_employee_match=False,
                former_match_employee_id=None,
                mapping_source=None,
            )
        )

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="unidentified_face.unmapped",
            entity_type="employee",
            entity_id=str(body.employee_id),
            before={
                "employee_id": body.employee_id,
                "event_count": len(affected_ids),
                "filter": {
                    "start": start.isoformat() if start else None,
                    "end": end.isoformat() if end else None,
                    "camera_id": body.camera_id,
                },
            },
            after={
                "attendance_dates_to_recompute": sorted(
                    d.isoformat() for d in dates
                ),
            },
        )

    # Matcher cache + cluster cache hygiene.
    try:
        from maugood.identification.matcher import matcher_cache  # noqa: PLC0415

        matcher_cache.invalidate_employee(body.employee_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "unmap_by_employee: matcher cache invalidation failed: %s",
            type(exc).__name__,
        )
    _cluster_cache_evict_tenant(scope.tenant_id)

    # Attendance recompute — one call per affected day.
    recomputed: set[str] = set()
    for the_date in sorted(dates):
        try:
            if att_scheduler.recompute_for(
                scope, employee_id=body.employee_id, the_date=the_date
            ):
                recomputed.add(the_date.isoformat())
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "unmap_by_employee: recompute failed employee=%d date=%s: %s",
                body.employee_id, the_date, type(exc).__name__,
            )

    return UnmapEventsResponse(
        unmapped_events=len(affected_ids),
        affected_employee_ids=[body.employee_id],
        attendance_dates_recomputed=sorted(recomputed),
    )
