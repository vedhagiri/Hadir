"""Tenant-scoped SQL for the ``attendance_devices`` table.

Every function takes a ``TenantScope`` and filters every statement on
``scope.tenant_id`` — the tenant-isolation wall on top of the search_path
floor. The encrypted credentials token never exits this module except to
a decrypt-to-use scope; ``DeviceRow`` surfaces host/port/serial, never the
plaintext username or password.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from maugood.db import attendance_devices, device_users, employees
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class DeviceRow:
    id: int
    name: str
    location: str
    driver: str
    host: str
    port: int
    credentials_encrypted: str
    serial_number: str
    model: Optional[str]
    firmware: Optional[str]
    door_no: Optional[str]
    enrollment_scope: str
    enabled: bool
    health_status: str
    users_synced: int
    last_user_sync_at: Optional[datetime]
    last_seen_at: Optional[datetime]
    created_at: datetime


def _to_row(r: Any) -> DeviceRow:
    return DeviceRow(
        id=r.id,
        name=r.name,
        location=r.location,
        driver=r.driver,
        host=r.host,
        port=r.port,
        credentials_encrypted=r.credentials_encrypted,
        serial_number=r.serial_number,
        model=r.model,
        firmware=r.firmware,
        door_no=r.door_no,
        enrollment_scope=r.enrollment_scope,
        enabled=r.enabled,
        health_status=r.health_status,
        users_synced=r.users_synced,
        last_user_sync_at=r.last_user_sync_at,
        last_seen_at=r.last_seen_at,
        created_at=r.created_at,
    )


def list_devices(conn: Connection, scope: TenantScope) -> list[DeviceRow]:
    rows = conn.execute(
        select(attendance_devices)
        .where(attendance_devices.c.tenant_id == scope.tenant_id)
        .order_by(attendance_devices.c.created_at.desc())
    ).all()
    return [_to_row(r) for r in rows]


def get_device(
    conn: Connection, scope: TenantScope, device_id: int
) -> Optional[DeviceRow]:
    r = conn.execute(
        select(attendance_devices).where(
            attendance_devices.c.id == device_id,
            attendance_devices.c.tenant_id == scope.tenant_id,
        )
    ).first()
    return _to_row(r) if r is not None else None


def create_device(
    conn: Connection,
    scope: TenantScope,
    *,
    name: str,
    location: str,
    driver: str,
    host: str,
    port: int,
    credentials_encrypted: str,
    serial_number: str,
    model: Optional[str],
    firmware: Optional[str],
    door_no: Optional[str],
    enrollment_scope: str,
    enabled: bool,
    health_status: str,
) -> int:
    new_id = conn.execute(
        insert(attendance_devices)
        .values(
            tenant_id=scope.tenant_id,
            name=name,
            location=location,
            driver=driver,
            host=host,
            port=port,
            credentials_encrypted=credentials_encrypted,
            serial_number=serial_number,
            model=model,
            firmware=firmware,
            door_no=door_no,
            enrollment_scope=enrollment_scope,
            enabled=enabled,
            health_status=health_status,
        )
        .returning(attendance_devices.c.id)
    ).scalar_one()
    return int(new_id)


def update_device(
    conn: Connection,
    scope: TenantScope,
    device_id: int,
    *,
    values: dict[str, Any],
) -> None:
    if not values:
        return
    conn.execute(
        update(attendance_devices)
        .where(
            attendance_devices.c.id == device_id,
            attendance_devices.c.tenant_id == scope.tenant_id,
        )
        .values(**values)
    )


def delete_device(conn: Connection, scope: TenantScope, device_id: int) -> None:
    conn.execute(
        delete(attendance_devices).where(
            attendance_devices.c.id == device_id,
            attendance_devices.c.tenant_id == scope.tenant_id,
        )
    )


# --- device_users -----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DeviceUserRow:
    id: int
    device_user_id: str
    name: Optional[str]
    card_no: Optional[str]
    employee_id: Optional[int]
    mapping_status: str
    face_synced: bool
    synced_at: Optional[datetime]


def employee_id_for_code(
    conn: Connection, scope: TenantScope, code: str
) -> Optional[int]:
    """Resolve a device person id (== employee_code) to a Maugood employee.
    Case-insensitive; returns None when unmapped."""

    r = conn.execute(
        select(employees.c.id).where(
            employees.c.tenant_id == scope.tenant_id,
            func.lower(employees.c.employee_code) == code.strip().lower(),
        )
    ).first()
    return int(r.id) if r is not None else None


def upsert_device_user(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    device_user_id: str,
    name: Optional[str],
    card_no: Optional[str],
    employee_id: Optional[int],
    synced_at: datetime,
) -> None:
    """Insert-or-update on (tenant_id, device_id, device_user_id).

    Re-syncing the same person updates the row in place — never a
    duplicate. ``face_synced`` is intentionally NOT touched here (it's
    owned by the enrollment-push path).
    """

    mapping_status = "mapped" if employee_id is not None else "unmapped"
    conn.execute(
        pg_insert(device_users)
        .values(
            tenant_id=scope.tenant_id,
            device_id=device_id,
            device_user_id=device_user_id,
            name=name,
            card_no=card_no,
            employee_id=employee_id,
            mapping_status=mapping_status,
            synced_at=synced_at,
        )
        .on_conflict_do_update(
            constraint="uq_device_users_tenant_device_user",
            set_={
                "name": name,
                "card_no": card_no,
                "employee_id": employee_id,
                "mapping_status": mapping_status,
                "synced_at": synced_at,
                "updated_at": func.now(),
            },
        )
    )


def list_device_users(
    conn: Connection, scope: TenantScope, device_id: int
) -> list[DeviceUserRow]:
    rows = conn.execute(
        select(device_users)
        .where(
            device_users.c.tenant_id == scope.tenant_id,
            device_users.c.device_id == device_id,
        )
        .order_by(device_users.c.device_user_id.asc())
    ).all()
    return [
        DeviceUserRow(
            id=r.id,
            device_user_id=r.device_user_id,
            name=r.name,
            card_no=r.card_no,
            employee_id=r.employee_id,
            mapping_status=r.mapping_status,
            face_synced=r.face_synced,
            synced_at=r.synced_at,
        )
        for r in rows
    ]


def count_device_users(
    conn: Connection, scope: TenantScope, device_id: int
) -> tuple[int, int]:
    """Return ``(total, unmapped)`` for a device."""

    total = conn.execute(
        select(func.count())
        .select_from(device_users)
        .where(
            device_users.c.tenant_id == scope.tenant_id,
            device_users.c.device_id == device_id,
        )
    ).scalar_one()
    unmapped = conn.execute(
        select(func.count())
        .select_from(device_users)
        .where(
            device_users.c.tenant_id == scope.tenant_id,
            device_users.c.device_id == device_id,
            device_users.c.employee_id.is_(None),
        )
    ).scalar_one()
    return int(total), int(unmapped)
