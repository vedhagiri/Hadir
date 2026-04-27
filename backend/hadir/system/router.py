"""System health endpoints used by the P11 System page.

* ``GET /api/system/health`` — uptime + DB connection count + scheduler
  status + a few headline counts (enrolled employees, today's events,
  today's attendance rows).
* ``GET /api/system/cameras-health`` — per-camera latest snapshot
  (frames_last_minute, reachable, last_seen) plus a 24-hour timeseries
  the frontend renders as a sparkline.
"""

from __future__ import annotations

import os
import time as time_mod
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, desc, func, select, text
from zoneinfo import ZoneInfo

from hadir.attendance import attendance_scheduler
from hadir.attendance.repository import local_tz
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.auth.ratelimit import get_rate_limiter
from hadir.capture import capture_manager
from hadir.db import (
    attendance_records,
    camera_health_snapshots,
    cameras,
    detection_events,
    employee_photos,
    employees,
    get_engine,
)
from hadir.tenants.scope import TenantScope

router = APIRouter(prefix="/api/system", tags=["system"])

ADMIN = Depends(require_role("Admin"))


# Track process startup time once per worker. ``time.monotonic`` would be
# safer against clock changes, but uptime as a wall-clock delta is what
# operators want to see on the System page.
_PROCESS_START_TS = time_mod.time()


class HealthOut(BaseModel):
    backend_uptime_seconds: int
    process_pid: int
    db_connections_active: int
    capture_workers_running: int
    attendance_scheduler_running: bool
    rate_limiter_running: bool
    enrolled_employees: int
    employees_active: int
    cameras_total: int
    cameras_enabled: int
    detection_events_today: int
    attendance_records_today: int


class CameraHealthSeriesPoint(BaseModel):
    captured_at: datetime
    frames_last_minute: int
    reachable: bool


class CameraHealthOut(BaseModel):
    camera_id: int
    name: str
    location: str
    # P28.5b: split worker / display flags. Old API consumers that
    # checked ``enabled`` should switch to ``worker_enabled`` (the
    # operational flag). ``display_enabled`` is supplementary.
    worker_enabled: bool
    display_enabled: bool
    rtsp_host: str
    last_seen_at: Optional[datetime] = None
    latest_frames_last_minute: int
    latest_reachable: bool
    series_24h: list[CameraHealthSeriesPoint]


class CamerasHealthOut(BaseModel):
    items: list[CameraHealthOut]


def _local_today() -> datetime.date:  # type: ignore[name-defined]
    tz = local_tz()
    return datetime.now(timezone.utc).astimezone(tz).date()


def _local_day_bounds_utc(d) -> tuple[datetime, datetime]:  # type: ignore[no-untyped-def]
    tz = local_tz()
    start_local = datetime.combine(d, time(0, 0), tzinfo=tz)
    end_local = datetime.combine(d, time(23, 59, 59, 999999), tzinfo=tz)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


@router.get("/health", response_model=HealthOut)
def get_health(user: Annotated[CurrentUser, ADMIN]) -> HealthOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    today = _local_today()
    day_start_utc, day_end_utc = _local_day_bounds_utc(today)

    with engine.begin() as conn:
        # Postgres `pg_stat_activity` works for the connected database
        # only — exactly what we want.
        try:
            db_conns = int(
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM pg_stat_activity "
                        "WHERE datname = current_database()"
                    )
                ).scalar_one()
            )
        except Exception:
            db_conns = 0

        enrolled = int(
            conn.execute(
                select(func.count(func.distinct(employee_photos.c.employee_id))).where(
                    employee_photos.c.tenant_id == scope.tenant_id,
                    employee_photos.c.embedding.is_not(None),
                )
            ).scalar_one()
        )
        employees_active = int(
            conn.execute(
                select(func.count()).where(
                    employees.c.tenant_id == scope.tenant_id,
                    employees.c.status == "active",
                )
            ).scalar_one()
        )
        cameras_total = int(
            conn.execute(
                select(func.count()).where(cameras.c.tenant_id == scope.tenant_id)
            ).scalar_one()
        )
        cameras_enabled = int(
            conn.execute(
                select(func.count()).where(
                    cameras.c.tenant_id == scope.tenant_id,
                    # P28.5b: ``enabled`` was split into worker_enabled
                    # + display_enabled. The system-health "cameras
                    # enabled" count is the count of cameras whose
                    # capture worker is on (the operationally-relevant
                    # number — display-disabled cameras are still
                    # recording).
                    cameras.c.worker_enabled.is_(True),
                )
            ).scalar_one()
        )
        events_today = int(
            conn.execute(
                select(func.count()).where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.captured_at >= day_start_utc,
                    detection_events.c.captured_at <= day_end_utc,
                )
            ).scalar_one()
        )
        attendance_today = int(
            conn.execute(
                select(func.count()).where(
                    attendance_records.c.tenant_id == scope.tenant_id,
                    attendance_records.c.date == today,
                )
            ).scalar_one()
        )

    uptime = max(0, int(time_mod.time() - _PROCESS_START_TS))
    return HealthOut(
        backend_uptime_seconds=uptime,
        process_pid=os.getpid(),
        db_connections_active=db_conns,
        capture_workers_running=len(capture_manager.active_camera_ids()),
        attendance_scheduler_running=attendance_scheduler._scheduler is not None,  # type: ignore[attr-defined]
        rate_limiter_running=get_rate_limiter()._scheduler is not None,  # type: ignore[attr-defined]
        enrolled_employees=enrolled,
        employees_active=employees_active,
        cameras_total=cameras_total,
        cameras_enabled=cameras_enabled,
        detection_events_today=events_today,
        attendance_records_today=attendance_today,
    )


@router.get("/cameras-health", response_model=CamerasHealthOut)
def cameras_health(user: Annotated[CurrentUser, ADMIN]) -> CamerasHealthOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    items: list[CameraHealthOut] = []
    with engine.begin() as conn:
        cam_rows = camera_repo_list_cameras(conn, scope)

        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        for cam in cam_rows:
            latest = conn.execute(
                select(
                    camera_health_snapshots.c.captured_at,
                    camera_health_snapshots.c.frames_last_minute,
                    camera_health_snapshots.c.reachable,
                )
                .where(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == cam.id,
                )
                .order_by(desc(camera_health_snapshots.c.captured_at))
                .limit(1)
            ).first()

            series_rows = conn.execute(
                select(
                    camera_health_snapshots.c.captured_at,
                    camera_health_snapshots.c.frames_last_minute,
                    camera_health_snapshots.c.reachable,
                )
                .where(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == cam.id,
                    camera_health_snapshots.c.captured_at >= cutoff,
                )
                .order_by(camera_health_snapshots.c.captured_at.asc())
            ).all()

            series = [
                CameraHealthSeriesPoint(
                    captured_at=r.captured_at,
                    frames_last_minute=int(r.frames_last_minute),
                    reachable=bool(r.reachable),
                )
                for r in series_rows
            ]

            items.append(
                CameraHealthOut(
                    camera_id=cam.id,
                    name=cam.name,
                    location=cam.location,
                    worker_enabled=cam.worker_enabled,
                    display_enabled=cam.display_enabled,
                    rtsp_host=cam.rtsp_host,
                    last_seen_at=cam.last_seen_at,
                    latest_frames_last_minute=(
                        int(latest.frames_last_minute) if latest is not None else 0
                    ),
                    latest_reachable=(
                        bool(latest.reachable) if latest is not None else False
                    ),
                    series_24h=series,
                )
            )
    return CamerasHealthOut(items=items)


def camera_repo_list_cameras(conn, scope: TenantScope):  # type: ignore[no-untyped-def]
    """Local helper to avoid a circular import with ``hadir.cameras``."""

    from hadir.cameras import repository as camera_repo  # noqa: PLC0415

    return camera_repo.list_cameras(conn, scope)


# ---------------------------------------------------------------------------
# P28.5c — Detection + Tracker configuration
# ---------------------------------------------------------------------------
#
# Both endpoints are Admin-only and tenant-scoped (the row lives on
# ``tenant_settings`` which is keyed by ``tenant_id``). Audit log
# carries before/after JSONB so an auditor can reconstruct any
# operator change.
#
# Validation is server-side, mirroring the client. Invalid values
# return 400 with the offending field name.

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator  # noqa: E402

from hadir.auth.audit import write_audit  # noqa: E402
from hadir.db import tenant_settings  # noqa: E402
from sqlalchemy import update as sql_update  # noqa: E402


# Allowed detector input sizes — must match
# ``hadir.detection.detectors._load_face_app`` re-prep behaviour.
_ALLOWED_DET_SIZES: tuple[int, ...] = (160, 224, 320, 480, 640)

# Min face dimension surfaced to the UI is 1-D; we square on the way
# in for storage as ``min_face_pixels``. The UI's 20–300 range maps
# here to 400 – 90,000 pixels.
_MIN_FACE_PIXELS_LO = 400
_MIN_FACE_PIXELS_HI = 90_000


class DetectionConfigIn(BaseModel):
    """Inbound shape for ``PUT /api/system/detection-config``.

    All four canonical knobs required — partial updates aren't
    supported (the UI sends the whole bag). Bounds match the
    P28.5c spec; ``mode`` is an enum-as-string.
    """

    model_config = ConfigDict(extra="forbid")

    mode: str
    det_size: int
    min_det_score: float = Field(ge=0.0, le=1.0)
    min_face_pixels: int = Field(
        ge=_MIN_FACE_PIXELS_LO, le=_MIN_FACE_PIXELS_HI
    )
    yolo_conf: float = Field(ge=0.0, le=1.0)
    show_body_boxes: bool

    @field_validator("mode")
    @classmethod
    def _check_mode(cls, v: str) -> str:
        if v not in ("insightface", "yolo+face"):
            raise ValueError(
                "mode must be one of: insightface, yolo+face"
            )
        return v

    @field_validator("det_size")
    @classmethod
    def _check_det_size(cls, v: int) -> int:
        if v not in _ALLOWED_DET_SIZES:
            raise ValueError(
                "det_size must be one of: " + ", ".join(
                    str(x) for x in _ALLOWED_DET_SIZES
                )
            )
        return v


class DetectionConfigOut(DetectionConfigIn):
    """Outbound shape — same fields as inbound."""

    model_config = ConfigDict(extra="ignore")


class TrackerConfigIn(BaseModel):
    """Inbound shape for ``PUT /api/system/tracker-config``."""

    model_config = ConfigDict(extra="forbid")

    iou_threshold: float = Field(ge=0.05, le=0.95)
    timeout_sec: float = Field(ge=0.5, le=30.0)
    max_duration_sec: float = Field(ge=10.0, le=3600.0)


class TrackerConfigOut(TrackerConfigIn):
    model_config = ConfigDict(extra="ignore")


# Defaults — mirror the migration's server_default and the manager's
# fallback constants.
_DETECTION_DEFAULTS = {
    "mode": "insightface",
    "det_size": 320,
    "min_det_score": 0.5,
    "min_face_pixels": 3600,
    "yolo_conf": 0.35,
    "show_body_boxes": False,
}
_TRACKER_DEFAULTS = {
    "iou_threshold": 0.3,
    "timeout_sec": 2.0,
    "max_duration_sec": 60.0,
}


def _load_detection_row(scope: TenantScope) -> dict:
    """Read the row + merge over defaults so missing keys are filled."""

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(
                tenant_settings.c.detection_config,
            ).where(tenant_settings.c.tenant_id == scope.tenant_id)
        ).first()
    out = dict(_DETECTION_DEFAULTS)
    if row is not None and isinstance(row.detection_config, dict):
        out.update(row.detection_config)
    return out


def _load_tracker_row(scope: TenantScope) -> dict:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(
                tenant_settings.c.tracker_config,
            ).where(tenant_settings.c.tenant_id == scope.tenant_id)
        ).first()
    out = dict(_TRACKER_DEFAULTS)
    if row is not None and isinstance(row.tracker_config, dict):
        out.update(row.tracker_config)
    return out


def _ensure_tenant_settings_row(conn, tenant_id: int) -> None:
    """Insert a default tenant_settings row when missing.

    The pilot's ``main`` schema is seeded on migration; tenants
    provisioned via the CLI also seed a row. But a future ad-hoc
    tenant could lack one — this function makes the PUT path safe
    in either case.
    """

    existing = conn.execute(
        select(tenant_settings.c.tenant_id).where(
            tenant_settings.c.tenant_id == tenant_id
        )
    ).first()
    if existing is not None:
        return
    from sqlalchemy import insert as sql_insert  # noqa: PLC0415

    conn.execute(
        sql_insert(tenant_settings).values(tenant_id=tenant_id)
    )


@router.get(
    "/detection-config", response_model=DetectionConfigOut
)
def get_detection_config(
    user: Annotated[CurrentUser, ADMIN],
) -> DetectionConfigOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    return DetectionConfigOut.model_validate(_load_detection_row(scope))


def _validation_to_400(model_cls, raw: dict):  # type: ignore[no-untyped-def]
    """Validate manually so a Pydantic error returns 400 (not the
    FastAPI default 422). The detail names the offending field via
    ``loc``."""

    from fastapi import HTTPException  # noqa: PLC0415

    try:
        return model_cls.model_validate(raw)
    except ValidationError as exc:
        # ``exc.errors()`` returns one entry per failure with a
        # ``loc`` tuple — surface the first as the headline error
        # plus full list for clients that want it.
        errs = exc.errors()
        first = errs[0] if errs else {"loc": ["body"], "msg": str(exc)}
        field = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        msg = first.get("msg", "invalid value")
        raise HTTPException(
            status_code=400,
            detail={
                "field": field or "body",
                "message": msg,
                "errors": [
                    {
                        "field": ".".join(
                            str(x) for x in e.get("loc", []) if x != "body"
                        ),
                        "message": e.get("msg", "invalid"),
                    }
                    for e in errs
                ],
            },
        ) from exc


@router.put(
    "/detection-config", response_model=DetectionConfigOut
)
def put_detection_config(
    payload: dict,
    user: Annotated[CurrentUser, ADMIN],
) -> DetectionConfigOut:
    parsed = _validation_to_400(DetectionConfigIn, payload)
    # Pre-flight: refuse to persist a mode whose runtime deps are
    # missing. Without this guard, the worker's analyzer thread
    # would log ``ModuleNotFoundError`` on every cycle (~6/s) and
    # capture would silently brick — see docs/phases/fix-detector-
    # mode-preflight.md.
    from fastapi import HTTPException  # noqa: PLC0415

    from hadir.detection import is_mode_available  # noqa: PLC0415

    if not is_mode_available(parsed.mode):
        raise HTTPException(
            status_code=400,
            detail={
                "field": "mode",
                "message": (
                    f"detector mode '{parsed.mode}' is not available in "
                    "this build (required runtime dependency missing)"
                ),
            },
        )
    scope = TenantScope(tenant_id=user.tenant_id)
    new_config = parsed.model_dump()
    before = _load_detection_row(scope)
    engine = get_engine()
    with engine.begin() as conn:
        _ensure_tenant_settings_row(conn, scope.tenant_id)
        conn.execute(
            sql_update(tenant_settings)
            .where(tenant_settings.c.tenant_id == scope.tenant_id)
            .values(detection_config=new_config)
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="system.detection_config.updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before=before,
            after=new_config,
        )
    return DetectionConfigOut.model_validate(new_config)


@router.get(
    "/tracker-config", response_model=TrackerConfigOut
)
def get_tracker_config(
    user: Annotated[CurrentUser, ADMIN],
) -> TrackerConfigOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    return TrackerConfigOut.model_validate(_load_tracker_row(scope))


@router.put(
    "/tracker-config", response_model=TrackerConfigOut
)
def put_tracker_config(
    payload: dict,
    user: Annotated[CurrentUser, ADMIN],
) -> TrackerConfigOut:
    parsed = _validation_to_400(TrackerConfigIn, payload)
    scope = TenantScope(tenant_id=user.tenant_id)
    new_config = parsed.model_dump()
    before = _load_tracker_row(scope)
    engine = get_engine()
    with engine.begin() as conn:
        _ensure_tenant_settings_row(conn, scope.tenant_id)
        conn.execute(
            sql_update(tenant_settings)
            .where(tenant_settings.c.tenant_id == scope.tenant_id)
            .values(tracker_config=new_config)
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="system.tracker_config.updated",
            entity_type="tenant_settings",
            entity_id=str(scope.tenant_id),
            before=before,
            after=new_config,
        )
    return TrackerConfigOut.model_validate(new_config)
