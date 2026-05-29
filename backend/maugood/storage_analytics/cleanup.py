"""Clip-video cleanup — preview + soft-clear.

The cleanup surface operates exclusively on ``person_clips``. Only the
on-disk video file and the row's accounting columns (``file_path``,
``filesize_bytes``) are touched; ``face_crops``, ``detection_events``,
``employee_photos``, and ``attendance_records`` are intentionally
untouched. That matches the operator-facing promise: "remove the
heavy video, keep everything extracted from it".

The implementation is **synchronous with a hard per-call cap**:

* Selecting matching rows uses ``LIMIT cap + 1`` so we know cheaply
  whether more work remains; the caller (HTTP request) loops until
  ``has_more`` is false. A cap-sized batch is small enough to finish
  inside a normal HTTP timeout but large enough that a few thousand
  clips reclaim in a single round-trip.
* The disk unlink is best-effort. A missing file is not an error
  (the row still moves to soft-cleared state); an OS-level failure
  is logged at WARN and the row still moves on, because keeping the
  row in a non-cleared state would mean an operator gets the same
  failing file forever.

The ``ClipCleanupFilter`` accepts exactly one of three time modes:

* ``older_than_hours`` — clips whose ``clip_start`` is more than N
  hours in the past.
* ``older_than_days`` — same, in days.
* ``start_date`` + ``end_date`` — a closed local-date range. The
  range is evaluated against the local-clock representation of
  ``clip_start`` (so an operator picking "2026-05-01 to 2026-05-07"
  gets the days they expect regardless of where the clip happens
  to fall on UTC midnight).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, text, update
from sqlalchemy.engine import Connection

from maugood.auth.audit import write_audit
from maugood.db import cameras, person_clips, tenant_settings
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Per-call deletion cap. Keeps a single HTTP request bounded; the
# frontend loops until has_more is false. 5,000 rows × ~20 MB each ≈
# 100 GB reclaimed per call, which is well above any realistic pilot
# need but still fits inside the synchronous request window.
CLEANUP_CAP: int = 5000

# Bounds on the hour/day filter modes — defence in depth on top of
# the API-layer validators.
MAX_HOURS: int = 24 * 365  # one year in hours
MAX_DAYS: int = 365 * 10   # ten years in days


class CleanupFilterError(ValueError):
    """The supplied filter is invalid (zero modes set, multiple modes set,
    inverted range, etc.). Raised by ``resolve_cutoff`` so the API
    handler can translate to HTTP 400 with a precise reason."""


@dataclass(frozen=True)
class ClipCleanupFilter:
    """One of the three time modes must be set, never more than one."""

    older_than_hours: Optional[int] = None
    older_than_days: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    camera_id: Optional[int] = None

    def mode(self) -> str:
        if self.older_than_hours is not None:
            return "hours"
        if self.older_than_days is not None:
            return "days"
        if self.start_date is not None or self.end_date is not None:
            return "range"
        return "none"


@dataclass
class CameraImpactRow:
    camera_id: int
    camera_name: str
    clip_count: int
    total_bytes: int


@dataclass
class ClipCleanupPreview:
    clip_count: int
    total_bytes: int
    oldest_clip_at: Optional[datetime] = None
    newest_clip_at: Optional[datetime] = None
    by_camera: list[CameraImpactRow] = field(default_factory=list)
    capped: bool = False  # True if matching set exceeds CLEANUP_CAP


@dataclass
class ClipCleanupResult:
    deleted_count: int
    bytes_freed: int
    files_unlinked: int
    files_missing: int
    files_failed: int
    has_more: bool


# ───────────────────────── filter resolution ──────────────────────────


def _tenant_timezone(conn: Connection, scope: TenantScope) -> ZoneInfo:
    """Read the tenant's IANA timezone with a safe fallback to UTC."""

    row = conn.execute(
        select(tenant_settings.c.timezone).where(
            tenant_settings.c.tenant_id == scope.tenant_id
        )
    ).first()
    tz_name = str(row.timezone) if row is not None else "UTC"
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def resolve_cutoff(
    filt: ClipCleanupFilter,
    *,
    tz: ZoneInfo,
    now: Optional[datetime] = None,
) -> tuple[datetime, Optional[datetime]]:
    """Translate the filter into a ``(start_exclusive, end_inclusive)``
    pair on ``person_clips.clip_start``.

    * Hour/day modes return ``(<beginning_of_time>, cutoff)`` so the
      WHERE clause is ``clip_start < cutoff``.
    * Range mode returns ``(start_of_start_date_local, end_of_end_date_local)``
      so both bounds are honoured.

    The "beginning of time" sentinel is a fixed faraway-past timestamp
    (year 1970) — the on-disk clip data started in 2024, so this
    cleanly catches everything.
    """

    mode = filt.mode()
    if mode == "none":
        raise CleanupFilterError(
            "exactly one filter mode required: older_than_hours, "
            "older_than_days, or start_date+end_date"
        )

    # Reject combinations.
    set_modes = [
        filt.older_than_hours is not None,
        filt.older_than_days is not None,
        filt.start_date is not None or filt.end_date is not None,
    ]
    if sum(set_modes) > 1:
        raise CleanupFilterError(
            "only one filter mode may be set per request"
        )

    now = now or datetime.now(tz=timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)

    if mode == "hours":
        h = int(filt.older_than_hours or 0)
        if h <= 0 or h > MAX_HOURS:
            raise CleanupFilterError(
                f"older_than_hours must be 1..{MAX_HOURS}"
            )
        return (epoch, now - timedelta(hours=h))

    if mode == "days":
        d = int(filt.older_than_days or 0)
        if d <= 0 or d > MAX_DAYS:
            raise CleanupFilterError(
                f"older_than_days must be 1..{MAX_DAYS}"
            )
        return (epoch, now - timedelta(days=d))

    # range mode
    if filt.start_date is None or filt.end_date is None:
        raise CleanupFilterError(
            "range mode requires both start_date and end_date"
        )
    if filt.start_date > filt.end_date:
        raise CleanupFilterError(
            "start_date must be on or before end_date"
        )
    start_dt = datetime.combine(filt.start_date, time.min, tzinfo=tz)
    end_dt = datetime.combine(filt.end_date, time.max, tzinfo=tz)
    return (start_dt.astimezone(timezone.utc), end_dt.astimezone(timezone.utc))


def _base_where(
    scope: TenantScope,
    *,
    start_at: datetime,
    end_at: Optional[datetime],
    camera_id: Optional[int],
):
    """Build the WHERE-clause tuple shared by preview + run queries.

    The cleanup operates only on rows that still have a video on
    disk — ``file_path IS NOT NULL`` and ``clip_file_deleted_at IS NULL``
    together exclude both never-recorded rows and already-cleared rows.
    """

    clauses = [
        person_clips.c.tenant_id == scope.tenant_id,
        person_clips.c.clip_file_deleted_at.is_(None),
        person_clips.c.file_path.is_not(None),
        person_clips.c.clip_start >= start_at,
    ]
    if end_at is not None:
        clauses.append(person_clips.c.clip_start <= end_at)
    if camera_id is not None:
        clauses.append(person_clips.c.camera_id == camera_id)
    return clauses


# ──────────────────────────── preview ─────────────────────────────────


def preview_clip_cleanup(
    conn: Connection,
    scope: TenantScope,
    filt: ClipCleanupFilter,
    *,
    now: Optional[datetime] = None,
) -> ClipCleanupPreview:
    """Aggregate counts + sizes for the rows that would be cleared.

    Cheap query — no row fetch, all on the index added in migration
    0069. Per-camera breakdown is grouped so the UI can show "Camera
    A: 1,200 clips / 4.2 GB; Camera B: 47 / 80 MB".
    """

    tz = _tenant_timezone(conn, scope)
    start_at, end_at = resolve_cutoff(filt, tz=tz, now=now)
    clauses = _base_where(
        scope, start_at=start_at, end_at=end_at, camera_id=filt.camera_id
    )

    summary = conn.execute(
        select(
            func.count().label("clip_count"),
            func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label(
                "total_bytes"
            ),
            func.min(person_clips.c.clip_start).label("oldest"),
            func.max(person_clips.c.clip_start).label("newest"),
        ).where(*clauses)
    ).one()

    per_camera = conn.execute(
        select(
            person_clips.c.camera_id,
            func.coalesce(cameras.c.name, text("'(deleted)'")).label("camera_name"),
            func.count().label("clip_count"),
            func.coalesce(func.sum(person_clips.c.filesize_bytes), 0).label(
                "total_bytes"
            ),
        )
        .select_from(
            person_clips.outerjoin(
                cameras,
                (cameras.c.id == person_clips.c.camera_id)
                & (cameras.c.tenant_id == scope.tenant_id),
            )
        )
        .where(*clauses)
        .group_by(person_clips.c.camera_id, cameras.c.name)
        .order_by(func.sum(person_clips.c.filesize_bytes).desc())
    ).fetchall()

    total = int(summary.clip_count or 0)
    return ClipCleanupPreview(
        clip_count=total,
        total_bytes=int(summary.total_bytes or 0),
        oldest_clip_at=summary.oldest,
        newest_clip_at=summary.newest,
        by_camera=[
            CameraImpactRow(
                camera_id=int(row.camera_id),
                camera_name=str(row.camera_name or f"Camera {row.camera_id}"),
                clip_count=int(row.clip_count or 0),
                total_bytes=int(row.total_bytes or 0),
            )
            for row in per_camera
        ],
        capped=total > CLEANUP_CAP,
    )


# ──────────────────────────── run ─────────────────────────────────────


def _unlink_file(file_path_str: str) -> tuple[bool, bool]:
    """Best-effort delete of a clip's on-disk video.

    Returns ``(file_was_there, unlink_failed)``. A missing file is
    not an error — the soft-clear still proceeds. A real OS failure
    (read-only mount, permission denied) is logged and the row also
    still soft-clears, because leaving the row in a dirty state means
    the next sweep would try the same failing path forever.
    """

    p = Path(file_path_str)
    if not p.exists():
        return (False, False)
    try:
        p.unlink()
        return (True, False)
    except OSError as exc:
        logger.warning("clip cleanup: failed to delete %s: %s", p, exc)
        return (True, True)


def run_clip_cleanup(
    conn: Connection,
    scope: TenantScope,
    filt: ClipCleanupFilter,
    *,
    actor_user_id: Optional[int] = None,
    cap: int = CLEANUP_CAP,
    now: Optional[datetime] = None,
) -> ClipCleanupResult:
    """Soft-clear up to ``cap`` matching clip videos.

    Pulls ``cap + 1`` IDs to detect whether more work remains; the
    extra row is not processed. Unlinks disk files first (so a row
    that survives a crash mid-unlink can still be retried via
    ``file_path``), then UPDATEs the rows in a single statement to
    ``clip_file_deleted_at = now()``, ``file_path = NULL``,
    ``filesize_bytes = 0``. Writes one audit row summarising the
    batch.
    """

    tz = _tenant_timezone(conn, scope)
    start_at, end_at = resolve_cutoff(filt, tz=tz, now=now)
    clauses = _base_where(
        scope, start_at=start_at, end_at=end_at, camera_id=filt.camera_id
    )
    fetched = conn.execute(
        select(
            person_clips.c.id,
            person_clips.c.file_path,
            person_clips.c.filesize_bytes,
        )
        .where(*clauses)
        .order_by(person_clips.c.clip_start.asc())
        .limit(cap + 1)
    ).fetchall()

    has_more = len(fetched) > cap
    targets = fetched[:cap]

    if not targets:
        return ClipCleanupResult(
            deleted_count=0,
            bytes_freed=0,
            files_unlinked=0,
            files_missing=0,
            files_failed=0,
            has_more=False,
        )

    ids: list[int] = []
    bytes_freed = 0
    files_unlinked = 0
    files_missing = 0
    files_failed = 0
    for row in targets:
        ids.append(int(row.id))
        bytes_freed += int(row.filesize_bytes or 0)
        if row.file_path:
            existed, failed = _unlink_file(str(row.file_path))
            if not existed:
                files_missing += 1
            elif failed:
                files_failed += 1
            else:
                files_unlinked += 1

    now_utc = datetime.now(tz=timezone.utc)
    conn.execute(
        update(person_clips)
        .where(
            person_clips.c.tenant_id == scope.tenant_id,
            person_clips.c.id.in_(ids),
        )
        .values(
            clip_file_deleted_at=now_utc,
            file_path=None,
            filesize_bytes=0,
        )
    )

    # Audit row carries the filter shape verbatim so an operator can
    # reproduce or audit-trail the deletion later.
    audit_payload: dict = {
        "filter": {
            "mode": filt.mode(),
            "older_than_hours": filt.older_than_hours,
            "older_than_days": filt.older_than_days,
            "start_date": filt.start_date.isoformat() if filt.start_date else None,
            "end_date": filt.end_date.isoformat() if filt.end_date else None,
            "camera_id": filt.camera_id,
        },
        "deleted_count": len(ids),
        "bytes_freed": bytes_freed,
        "files_unlinked": files_unlinked,
        "files_missing": files_missing,
        "files_failed": files_failed,
        "has_more": has_more,
    }
    write_audit(
        conn,
        tenant_id=scope.tenant_id,
        actor_user_id=actor_user_id,
        action="clip_cleanup.executed",
        entity_type="person_clips",
        entity_id=str(scope.tenant_id),
        after=audit_payload,
    )

    return ClipCleanupResult(
        deleted_count=len(ids),
        bytes_freed=bytes_freed,
        files_unlinked=files_unlinked,
        files_missing=files_missing,
        files_failed=files_failed,
        has_more=has_more,
    )


# ────────────────────── tenant retention setting ─────────────────────


def get_clip_retention_days(conn: Connection, scope: TenantScope) -> Optional[int]:
    """Read the per-tenant auto-cleanup threshold (NULL = disabled)."""

    row = conn.execute(
        select(tenant_settings.c.clip_retention_days).where(
            tenant_settings.c.tenant_id == scope.tenant_id
        )
    ).first()
    if row is None or row.clip_retention_days is None:
        return None
    return int(row.clip_retention_days)


__all__ = [
    "CLEANUP_CAP",
    "CameraImpactRow",
    "CleanupFilterError",
    "ClipCleanupFilter",
    "ClipCleanupPreview",
    "ClipCleanupResult",
    "get_clip_retention_days",
    "preview_clip_cleanup",
    "resolve_cutoff",
    "run_clip_cleanup",
]
