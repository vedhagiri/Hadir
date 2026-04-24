"""Tenant-scoped SQL for the cameras table.

Mirrors the pattern from ``hadir.employees.repository``: every function
takes a ``TenantScope`` and filters every statement on
``scope.tenant_id``. The plaintext RTSP URL never exits this module —
callers get either the encrypted token (internal decrypt-to-use scopes)
or, for client-facing paths, the row's stripped host via
``CameraRow.rtsp_host``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from hadir.cameras.rtsp import rtsp_host
from hadir.db import cameras
from hadir.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class CameraRow:
    id: int
    name: str
    location: str
    rtsp_url_encrypted: str
    rtsp_host: str
    enabled: bool
    created_at: datetime
    last_seen_at: Optional[datetime]
    images_captured_24h: int


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
        enabled=bool(row.enabled),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        images_captured_24h=int(row.images_captured_24h),
    )


def list_cameras(conn: Connection, scope: TenantScope) -> list[CameraRow]:
    rows = conn.execute(
        select(
            cameras.c.id,
            cameras.c.name,
            cameras.c.location,
            cameras.c.rtsp_url_encrypted,
            cameras.c.enabled,
            cameras.c.created_at,
            cameras.c.last_seen_at,
            cameras.c.images_captured_24h,
        )
        .where(cameras.c.tenant_id == scope.tenant_id)
        .order_by(cameras.c.name.asc())
    ).all()
    return [_row_to_camera(r) for r in rows]


def get_camera(
    conn: Connection, scope: TenantScope, camera_id: int
) -> Optional[CameraRow]:
    row = conn.execute(
        select(
            cameras.c.id,
            cameras.c.name,
            cameras.c.location,
            cameras.c.rtsp_url_encrypted,
            cameras.c.enabled,
            cameras.c.created_at,
            cameras.c.last_seen_at,
            cameras.c.images_captured_24h,
        ).where(
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
    enabled: bool,
) -> int:
    new_id = conn.execute(
        insert(cameras)
        .values(
            tenant_id=scope.tenant_id,
            name=name,
            location=location,
            rtsp_url_encrypted=rtsp_url_encrypted,
            enabled=enabled,
        )
        .returning(cameras.c.id)
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
