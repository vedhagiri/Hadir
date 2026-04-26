"""Tenant-scoped SQL for the cameras table.

Mirrors the pattern from ``hadir.employees.repository``: every function
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

from hadir.cameras.rtsp import rtsp_host
from hadir.db import cameras
from hadir.tenants.scope import TenantScope


# P28.5b: defaults used when a row's ``capture_config`` is missing a
# specific key (forward compat: a future phase can add new knobs and
# old rows still load cleanly). Values match prototype-reference
# constants — do not change without testing on real footage.
DEFAULT_CAPTURE_CONFIG: dict[str, Any] = {
    "max_faces_per_event": 10,
    "max_event_duration_sec": 60,
    "min_face_quality_to_save": 0.35,
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
    capture_config: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CAPTURE_CONFIG))
    created_at: datetime = field(default_factory=datetime.now)
    last_seen_at: Optional[datetime] = None
    images_captured_24h: int = 0


def _decrypt_and_parse_host(token: str) -> str:
    """Decrypt-to-parse: brief in-memory plaintext, discarded immediately."""

    # Local import so the repository module stays cheap to load in tests
    # that don't touch Fernet.
    from hadir.cameras.rtsp import decrypt_url

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
        capture_config=_normalise_capture_config(row.capture_config),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        images_captured_24h=int(row.images_captured_24h),
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
    cameras.c.capture_config,
    cameras.c.created_at,
    cameras.c.last_seen_at,
    cameras.c.images_captured_24h,
)


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
    capture_config: Optional[dict[str, Any]] = None,
) -> int:
    values: dict[str, Any] = {
        "tenant_id": scope.tenant_id,
        "name": name,
        "location": location,
        "rtsp_url_encrypted": rtsp_url_encrypted,
        "worker_enabled": worker_enabled,
        "display_enabled": display_enabled,
    }
    if capture_config is not None:
        # The DB has a server_default; only override when the caller
        # actually supplied a value, so a missing key inherits the
        # current server default rather than ours from this module.
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
