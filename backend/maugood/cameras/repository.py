"""Tenant-scoped SQL for the cameras table.

Mirrors the pattern from ``maugood.employees.repository``: every function
takes a ``TenantScope`` and filters every statement on
``scope.tenant_id``. The plaintext RTSP URL never exits this module —
callers get either the encrypted token (internal decrypt-to-use scopes)
or, for client-facing paths, the row's stripped host via
``CameraRow.rtsp_host``.

P28.5b: ``enabled`` was split into ``worker_enabled`` + ``display_enabled``
and the per-camera ``capture_config`` JSONB knob bag was added. The
``CameraRow`` dataclass surfaces all three.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from maugood.cameras.rtsp import rtsp_host
from maugood.db import cameras
from maugood.tenants.scope import TenantScope


# P28.5b: defaults used when a row's ``capture_config`` is missing a
# specific key (forward compat: a future phase can add new knobs and
# old rows still load cleanly). Values match prototype-reference
# constants — do not change without testing on real footage.
DEFAULT_CAPTURE_CONFIG: dict[str, Any] = {
    "max_faces_per_event": 10,
    "max_event_duration_sec": 60,
    # Deprecated runtime no-op (see ``cameras/schemas.py``); kept for
    # backward compat with migration 0027's JSONB shape.
    "min_face_quality_to_save": 0.0,
    "save_full_frames": False,
}


def _normalise_capture_config(raw: Optional[dict]) -> dict[str, Any]:
    """Merge a row's ``capture_config`` JSONB onto the defaults.

    Defensive against rows written by older code that omits a knob, or
    that stored an unexpected key. Unknown keys pass through (so a
    future phase's knob round-trips), known keys get type coercion to
    keep the API stable.
    """

    out = dict(DEFAULT_CAPTURE_CONFIG)
    if isinstance(raw, dict):
        out.update(raw)
    # Type coercion for the four canonical knobs.
    if "max_faces_per_event" in out:
        out["max_faces_per_event"] = int(out["max_faces_per_event"])
    if "max_event_duration_sec" in out:
        out["max_event_duration_sec"] = int(out["max_event_duration_sec"])
    if "min_face_quality_to_save" in out:
        out["min_face_quality_to_save"] = float(out["min_face_quality_to_save"])
    if "save_full_frames" in out:
        out["save_full_frames"] = bool(out["save_full_frames"])
    return out


@dataclass(frozen=True, slots=True)
class CameraRow:
    id: int
    name: str
    location: str
    rtsp_url_encrypted: str
    rtsp_host: str
    worker_enabled: bool
    display_enabled: bool
    detection_enabled: bool = True
    # Migration 0034 — running human-readable code (CAM-001 etc.).
    camera_code: str = ""
    # Migration 0034 — zone tag.
    zone: Optional[str] = None
    capture_config: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CAPTURE_CONFIG))
    created_at: datetime = field(default_factory=datetime.now)
    last_seen_at: Optional[datetime] = None
    images_captured_24h: int = 0
    # P28.8 metadata. Auto-detected (worker writes) + manual (Admin).
    detected_resolution_w: Optional[int] = None
    detected_resolution_h: Optional[int] = None
    detected_fps: Optional[float] = None
    detected_codec: Optional[str] = None
    detected_at: Optional[datetime] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    mount_location: Optional[str] = None


def _decrypt_and_parse_host(token: str) -> str:
    """Decrypt-to-parse: brief in-memory plaintext, discarded immediately."""

    # Local import so the repository module stays cheap to load in tests
    # that don't touch Fernet.
    from maugood.cameras.rtsp import decrypt_url

    plain = decrypt_url(token)
    try:
        return rtsp_host(plain)
    finally:
        # Python strings are immutable; there's no secure zero, but at
        # least we drop the reference so it's eligible for GC.
        del plain


def _row_to_camera(row) -> CameraRow:
    return CameraRow(
        id=int(row.id),
        name=str(row.name),
        location=str(row.location),
        rtsp_url_encrypted=str(row.rtsp_url_encrypted),
        rtsp_host=_decrypt_and_parse_host(row.rtsp_url_encrypted),
        worker_enabled=bool(row.worker_enabled),
        display_enabled=bool(row.display_enabled),
        detection_enabled=bool(row.detection_enabled),
        camera_code=str(row.camera_code) if row.camera_code is not None else "",
        zone=row.zone,
        capture_config=_normalise_capture_config(row.capture_config),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        images_captured_24h=int(row.images_captured_24h),
        detected_resolution_w=row.detected_resolution_w,
        detected_resolution_h=row.detected_resolution_h,
        detected_fps=(
            float(row.detected_fps) if row.detected_fps is not None else None
        ),
        detected_codec=row.detected_codec,
        detected_at=row.detected_at,
        brand=row.brand,
        model=row.model,
        mount_location=row.mount_location,
    )


# All read paths share this column tuple so a future column add only
# touches the SELECT once.
_SELECT_COLUMNS = (
    cameras.c.id,
    cameras.c.name,
    cameras.c.location,
    cameras.c.rtsp_url_encrypted,
    cameras.c.worker_enabled,
    cameras.c.display_enabled,
    cameras.c.detection_enabled,
    cameras.c.camera_code,
    cameras.c.zone,
    cameras.c.capture_config,
    cameras.c.created_at,
    cameras.c.last_seen_at,
    cameras.c.images_captured_24h,
    cameras.c.detected_resolution_w,
    cameras.c.detected_resolution_h,
    cameras.c.detected_fps,
    cameras.c.detected_codec,
    cameras.c.detected_at,
    cameras.c.brand,
    cameras.c.model,
    cameras.c.mount_location,
)


def next_camera_code(conn: Connection, scope: TenantScope) -> str:
    """Return the next ``CAM-{N:03d}`` code for the tenant.

    Reads existing camera_code values, parses any that match the
    canonical ``CAM-NNN`` pattern, and returns ``CAM-`` + (max+1)
    zero-padded to 3 digits. Operator can override the format on
    create — uniqueness is enforced by the per-tenant DB constraint.
    """

    import re as _re  # noqa: PLC0415

    rows = conn.execute(
        select(cameras.c.camera_code).where(
            cameras.c.tenant_id == scope.tenant_id,
        )
    ).all()
    pat = _re.compile(r"^CAM-(\d+)$", _re.IGNORECASE)
    max_n = 0
    for r in rows:
        if r.camera_code is None:
            continue
        m = pat.match(str(r.camera_code))
        if m is not None:
            n = int(m.group(1))
            if n > max_n:
                max_n = n
    return f"CAM-{max_n + 1:03d}"


def list_cameras(conn: Connection, scope: TenantScope) -> list[CameraRow]:
    rows = conn.execute(
        select(*_SELECT_COLUMNS)
        .where(cameras.c.tenant_id == scope.tenant_id)
        .order_by(cameras.c.name.asc())
    ).all()
    return [_row_to_camera(r) for r in rows]


def get_camera(
    conn: Connection, scope: TenantScope, camera_id: int
) -> Optional[CameraRow]:
    row = conn.execute(
        select(*_SELECT_COLUMNS).where(
            cameras.c.tenant_id == scope.tenant_id, cameras.c.id == camera_id
        )
    ).first()
    return _row_to_camera(row) if row is not None else None


def create_camera(
    conn: Connection,
    scope: TenantScope,
    *,
    name: str,
    location: str,
    rtsp_url_encrypted: str,
    worker_enabled: bool = True,
    display_enabled: bool = True,
    detection_enabled: bool = True,
    camera_code: Optional[str] = None,
    zone: Optional[str] = None,
    capture_config: Optional[dict[str, Any]] = None,
) -> int:
    # Auto-generate the running code when the caller didn't supply
    # one. ``next_camera_code`` reads the current MAX(code) for the
    # tenant and returns "CAM-{N+1:03d}". Operator override stays
    # subject to the unique constraint.
    if not camera_code:
        camera_code = next_camera_code(conn, scope)

    values: dict[str, Any] = {
        "tenant_id": scope.tenant_id,
        "name": name,
        "location": location,
        "camera_code": camera_code,
        "zone": zone,
        "rtsp_url_encrypted": rtsp_url_encrypted,
        "worker_enabled": worker_enabled,
        "display_enabled": display_enabled,
        "detection_enabled": detection_enabled,
    }
    if capture_config is not None:
        values["capture_config"] = _normalise_capture_config(capture_config)

    new_id = conn.execute(
        insert(cameras).values(**values).returning(cameras.c.id)
    ).scalar_one()
    return int(new_id)


def update_camera(
    conn: Connection,
    scope: TenantScope,
    camera_id: int,
    *,
    values: dict[str, object],
) -> None:
    if not values:
        return
    conn.execute(
        update(cameras)
        .where(
            cameras.c.id == camera_id, cameras.c.tenant_id == scope.tenant_id
        )
        .values(**values)
    )


def delete_camera(conn: Connection, scope: TenantScope, camera_id: int) -> None:
    conn.execute(
        delete(cameras).where(
            cameras.c.id == camera_id, cameras.c.tenant_id == scope.tenant_id
        )
    )
