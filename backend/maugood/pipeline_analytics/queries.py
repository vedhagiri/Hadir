"""Read-side aggregation for the Pipeline Analytics tab.

Joins ``clip_processing_results`` (per clip × use-case perf metrics) with
``person_clips`` (clip facts) + ``cameras`` (name). Every query filters
``cpr.tenant_id == scope.tenant_id`` AND runs inside the request's
``tenant_context`` (search_path) — tenant-isolated on both the wall and
the floor.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.engine import Connection

from maugood.db import cameras
from maugood.db import clip_processing_results as cpr
from maugood.db import person_clips as pc
from maugood.tenants.scope import TenantScope

# Per-stage timing columns surfaced as avg/min/max/p95 in the summary.
# Ordered as the pipeline runs so the comparison reads top-to-bottom:
# queue → load → decode → detection(extract) → crop → match → total.
_METRICS: tuple[tuple[str, Any], ...] = (
    ("total", cpr.c.duration_ms),
    ("queue", cpr.c.queue_wait_ms),
    ("load", cpr.c.clip_load_ms),
    ("decode", cpr.c.frame_decode_ms),
    ("extract", cpr.c.face_extract_duration_ms),
    ("lockwait", cpr.c.detect_lock_wait_ms),
    ("detect", cpr.c.detect_compute_ms),
    ("crop", cpr.c.face_crop_ms),
    ("match", cpr.c.match_duration_ms),
)


def _apply_filters(
    stmt,
    scope: TenantScope,
    *,
    use_case: Optional[str],
    camera_id: Optional[int],
    start: Optional[datetime],
    end: Optional[datetime],
    status: Optional[str],
):
    stmt = stmt.where(cpr.c.tenant_id == scope.tenant_id)
    if use_case in ("uc1", "uc2"):
        stmt = stmt.where(cpr.c.use_case == use_case)
    if camera_id is not None:
        stmt = stmt.where(pc.c.camera_id == camera_id)
    if start is not None:
        stmt = stmt.where(pc.c.clip_start >= start)
    if end is not None:
        stmt = stmt.where(pc.c.clip_start <= end)
    if status in ("completed", "failed", "processing", "pending"):
        stmt = stmt.where(cpr.c.status == status)
    return stmt


def _round(v: Any, nd: int = 0) -> Optional[float]:
    if v is None:
        return None
    return round(float(v), nd) if nd else int(round(float(v)))


def summary(
    conn: Connection,
    scope: TenantScope,
    *,
    use_case: Optional[str] = None,
    camera_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    status: Optional[str] = "completed",
) -> list[dict[str, Any]]:
    """Per-use-case aggregates (avg/min/max/p95 of each stage time plus
    CPU/memory + crop counts). Returns one dict per use case present."""

    cols: list[Any] = [cpr.c.use_case.label("use_case"), func.count().label("count")]
    for name, col in _METRICS:
        cols.append(func.avg(col).label(f"avg_{name}"))
        cols.append(func.min(col).label(f"min_{name}"))
        cols.append(func.max(col).label(f"max_{name}"))
        cols.append(
            func.percentile_cont(0.95)
            .within_group(col.asc())
            .label(f"p95_{name}")
        )
    cols.append(func.avg(cpr.c.cpu_percent).label("avg_cpu"))
    cols.append(func.avg(cpr.c.memory_mb).label("avg_mem"))
    cols.append(func.max(cpr.c.memory_mb).label("max_mem"))
    cols.append(func.avg(cpr.c.face_crop_count).label("avg_crops"))
    cols.append(func.sum(cpr.c.face_crop_count).label("total_crops"))
    cols.append(func.avg(cpr.c.frames_sampled).label("avg_frames_sampled"))
    cols.append(func.avg(cpr.c.frames_motion_skipped).label("avg_frames_skipped"))
    cols.append(func.avg(cpr.c.frames_detected).label("avg_frames_detected"))
    cols.append(func.avg(cpr.c.faces_detected).label("avg_faces_detected"))

    stmt = (
        select(*cols)
        .select_from(
            cpr.join(pc, pc.c.id == cpr.c.person_clip_id)
        )
        .group_by(cpr.c.use_case)
        .order_by(cpr.c.use_case.asc())
    )
    stmt = _apply_filters(
        stmt, scope, use_case=use_case, camera_id=camera_id,
        start=start, end=end, status=status,
    )

    out: list[dict[str, Any]] = []
    for r in conn.execute(stmt).all():
        row: dict[str, Any] = {"use_case": r.use_case, "count": int(r.count)}
        for name, _col in _METRICS:
            row[f"avg_{name}_ms"] = _round(getattr(r, f"avg_{name}"))
            row[f"min_{name}_ms"] = _round(getattr(r, f"min_{name}"))
            row[f"max_{name}_ms"] = _round(getattr(r, f"max_{name}"))
            row[f"p95_{name}_ms"] = _round(getattr(r, f"p95_{name}"))
        row["avg_cpu_percent"] = _round(r.avg_cpu, 1)
        row["avg_memory_mb"] = _round(r.avg_mem, 1)
        row["max_memory_mb"] = _round(r.max_mem, 1)
        row["avg_face_crops"] = _round(r.avg_crops, 1)
        row["total_face_crops"] = int(r.total_crops or 0)
        row["avg_frames_sampled"] = _round(r.avg_frames_sampled, 1)
        row["avg_frames_skipped"] = _round(r.avg_frames_skipped, 1)
        row["avg_frames_detected"] = _round(r.avg_frames_detected, 1)
        row["avg_faces_detected"] = _round(r.avg_faces_detected, 1)
        out.append(row)
    return out


# Columns returned by the per-clip list + CSV export (kept in one place
# so the table, the CSV header, and the row builder never drift).
CLIP_COLUMNS: tuple[str, ...] = (
    "clip_id", "use_case", "camera_id", "camera_name", "status",
    "created_at", "started_at", "ended_at",
    "queue_wait_ms", "clip_load_ms", "frame_decode_ms",
    "duration_ms", "face_extract_duration_ms",
    "detect_lock_wait_ms", "detect_compute_ms",
    "face_crop_ms", "match_duration_ms",
    "frames_sampled", "frames_motion_skipped", "frames_detected",
    "faces_detected",
    "face_crop_count", "cpu_percent", "memory_mb",
    "fps", "frame_count", "duration_seconds", "filesize_bytes",
    "error",
)


def _clip_select():
    return (
        select(
            cpr.c.person_clip_id.label("clip_id"),
            cpr.c.use_case,
            pc.c.camera_id,
            cameras.c.name.label("camera_name"),
            cpr.c.status,
            cpr.c.created_at,
            cpr.c.started_at,
            cpr.c.ended_at,
            cpr.c.queue_wait_ms,
            cpr.c.clip_load_ms,
            cpr.c.frame_decode_ms,
            cpr.c.duration_ms,
            cpr.c.face_extract_duration_ms,
            cpr.c.detect_lock_wait_ms,
            cpr.c.detect_compute_ms,
            cpr.c.face_crop_ms,
            cpr.c.match_duration_ms,
            cpr.c.frames_sampled,
            cpr.c.frames_motion_skipped,
            cpr.c.frames_detected,
            cpr.c.faces_detected,
            cpr.c.face_crop_count,
            cpr.c.cpu_percent,
            cpr.c.memory_mb,
            pc.c.fps_recorded.label("fps"),
            pc.c.frame_count,
            pc.c.duration_seconds,
            pc.c.filesize_bytes,
            cpr.c.error,
        )
        .select_from(
            cpr.join(pc, pc.c.id == cpr.c.person_clip_id).outerjoin(
                cameras, cameras.c.id == pc.c.camera_id
            )
        )
    )


def _row_to_dict(r) -> dict[str, Any]:
    return {
        "clip_id": int(r.clip_id),
        "use_case": r.use_case,
        "camera_id": int(r.camera_id) if r.camera_id is not None else None,
        "camera_name": r.camera_name,
        "status": r.status,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "queue_wait_ms": r.queue_wait_ms,
        "clip_load_ms": r.clip_load_ms,
        "frame_decode_ms": r.frame_decode_ms,
        "duration_ms": r.duration_ms,
        "face_extract_duration_ms": r.face_extract_duration_ms,
        "detect_lock_wait_ms": r.detect_lock_wait_ms,
        "detect_compute_ms": r.detect_compute_ms,
        "face_crop_ms": r.face_crop_ms,
        "match_duration_ms": r.match_duration_ms,
        "frames_sampled": r.frames_sampled,
        "frames_motion_skipped": r.frames_motion_skipped,
        "frames_detected": r.frames_detected,
        "faces_detected": r.faces_detected,
        "face_crop_count": int(r.face_crop_count or 0),
        "cpu_percent": r.cpu_percent,
        "memory_mb": r.memory_mb,
        "fps": round(float(r.fps), 2) if r.fps is not None else None,
        "frame_count": int(r.frame_count or 0),
        "duration_seconds": (
            round(float(r.duration_seconds), 2)
            if r.duration_seconds is not None else None
        ),
        "filesize_bytes": int(r.filesize_bytes or 0),
        "error": r.error,
    }


def list_clips(
    conn: Connection,
    scope: TenantScope,
    *,
    use_case: Optional[str] = None,
    camera_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, Any]], int]:
    """Paginated per-clip metric rows, slowest first."""

    base = _apply_filters(
        _clip_select(), scope, use_case=use_case, camera_id=camera_id,
        start=start, end=end, status=status,
    )
    total = conn.execute(
        select(func.count()).select_from(base.subquery())
    ).scalar_one()
    rows = conn.execute(
        base.order_by(cpr.c.duration_ms.desc().nullslast())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return [_row_to_dict(r) for r in rows], int(total)


def all_clips_for_export(
    conn: Connection,
    scope: TenantScope,
    *,
    use_case: Optional[str] = None,
    camera_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    status: Optional[str] = None,
    cap: int = 50000,
) -> list[dict[str, Any]]:
    """Every matching row (capped) for the CSV export, slowest first."""

    base = _apply_filters(
        _clip_select(), scope, use_case=use_case, camera_id=camera_id,
        start=start, end=end, status=status,
    )
    rows = conn.execute(
        base.order_by(cpr.c.duration_ms.desc().nullslast()).limit(cap)
    ).all()
    return [_row_to_dict(r) for r in rows]
