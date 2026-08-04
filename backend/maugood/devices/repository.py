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

from maugood.db import (
    attendance_devices,
    device_attendance_events,
    device_users,
    employees,
)
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class DeviceRow:
    id: int
    name: str
    location: str
    driver: str
    # Pull-mode only. A push device dials us, so it has no address and no
    # credentials, and does not reveal its serial until the first event.
    host: Optional[str]
    port: Optional[int]
    credentials_encrypted: Optional[str]
    serial_number: Optional[str]
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
    # Push mode (0096).
    connection_mode: str
    push_token_hash: Optional[str]
    push_token_encrypted: Optional[str]
    reported_device_name: Optional[str]
    last_event_at: Optional[datetime]
    clock_suspect: bool


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
        connection_mode=r.connection_mode,
        push_token_hash=r.push_token_hash,
        push_token_encrypted=r.push_token_encrypted,
        reported_device_name=r.reported_device_name,
        last_event_at=r.last_event_at,
        clock_suspect=r.clock_suspect,
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


def create_push_device(
    conn: Connection,
    scope: TenantScope,
    *,
    name: str,
    location: str,
    driver: str,
    enabled: bool,
    push_token_hash: str,
    push_token_encrypted: str,
) -> int:
    """Register a push device. No host, no port, no credentials.

    Everything the pull path reads off the wire — serial, model, firmware —
    is learned from the first event this terminal posts.
    """

    new_id = conn.execute(
        insert(attendance_devices)
        .values(
            tenant_id=scope.tenant_id,
            name=name,
            location=location,
            driver=driver,
            enabled=enabled,
            connection_mode="push",
            push_token_hash=push_token_hash,
            push_token_encrypted=push_token_encrypted,
            health_status="unknown",
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
    first_seen_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    taps_count: int = 0
    source: str = "sync"
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None


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


def discover_device_user(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    device_user_id: str,
    name: Optional[str],
    seen_at: datetime,
) -> Optional[int]:
    """Record a person seen in an event; auto-map by employee code.

    A push device never exposes a user list, so its people are discovered
    from the traffic itself. Returns the mapped ``employee_id`` or ``None``.

    An existing row's ``employee_id`` is never overwritten here — an
    operator's manual mapping outranks a later auto-match attempt.
    """

    employee_id = employee_id_for_code(conn, scope, device_user_id)
    mapping_status = "mapped" if employee_id is not None else "unmapped"

    stmt = pg_insert(device_users).values(
        tenant_id=scope.tenant_id,
        device_id=device_id,
        device_user_id=device_user_id,
        name=name,
        employee_id=employee_id,
        mapping_status=mapping_status,
        source="events",
        first_seen_at=seen_at,
        last_seen_at=seen_at,
        taps_count=1,
    )
    row = conn.execute(
        stmt.on_conflict_do_update(
            constraint="uq_device_users_tenant_device_user",
            set_={
                # Keep the first non-null name we ever saw for this person.
                "name": func.coalesce(device_users.c.name, stmt.excluded.name),
                "last_seen_at": seen_at,
                "taps_count": device_users.c.taps_count + 1,
                "updated_at": func.now(),
            },
        ).returning(device_users.c.employee_id)
    ).first()

    return int(row.employee_id) if row is not None and row.employee_id else None


def map_device_user(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    device_user_id: str,
    employee_id: Optional[int],
) -> bool:
    """Point a discovered device person at a Maugood employee (or clear it).

    Returns False when the row doesn't exist for this tenant + device.
    """

    result = conn.execute(
        update(device_users)
        .where(
            device_users.c.tenant_id == scope.tenant_id,
            device_users.c.device_id == device_id,
            device_users.c.device_user_id == device_user_id,
        )
        .values(
            employee_id=employee_id,
            mapping_status="mapped" if employee_id is not None else "unmapped",
            updated_at=func.now(),
        )
    )
    return bool(result.rowcount)


def list_device_users(
    conn: Connection, scope: TenantScope, device_id: int
) -> list[DeviceUserRow]:
    rows = conn.execute(
        select(
            device_users,
            employees.c.employee_code.label("emp_code"),
            employees.c.full_name.label("emp_name"),
        )
        .select_from(
            device_users.outerjoin(
                employees,
                (employees.c.id == device_users.c.employee_id)
                & (employees.c.tenant_id == device_users.c.tenant_id),
            )
        )
        .where(
            device_users.c.tenant_id == scope.tenant_id,
            device_users.c.device_id == device_id,
        )
        .order_by(
            device_users.c.employee_id.is_(None).desc(),
            device_users.c.device_user_id.asc(),
        )
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
            first_seen_at=r.first_seen_at,
            last_seen_at=r.last_seen_at,
            taps_count=r.taps_count,
            source=r.source,
            employee_code=r.emp_code,
            employee_name=r.emp_name,
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


def count_skipped_taps(
    conn: Connection, scope: TenantScope, device_id: int
) -> int:
    """Taps parked because their person is not mapped to an employee yet."""

    return int(
        conn.execute(
            select(func.count())
            .select_from(device_attendance_events)
            .where(
                device_attendance_events.c.tenant_id == scope.tenant_id,
                device_attendance_events.c.device_id == device_id,
                device_attendance_events.c.status == "skipped",
            )
        ).scalar_one()
    )


# --- device_attendance_events (staging) -------------------------------------


@dataclass(frozen=True, slots=True)
class DeviceEventRow:
    id: int
    device_id: int
    device_user_id: str
    person_name: Optional[str]
    event_serial: str
    occurred_at: datetime
    received_at: datetime
    verify_mode: Optional[str]
    direction: Optional[str]
    status: str
    clock_suspect: bool
    employee_id: Optional[int]


def insert_tap(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    device_user_id: str,
    person_name: Optional[str],
    event_serial: str,
    dedup_key: str,
    occurred_at: datetime,
    verify_mode: Optional[str],
    direction: Optional[str],
    clock_suspect: bool,
    employee_id: Optional[int],
    raw: dict[str, Any],
) -> Optional[int]:
    """Stage one tap. Returns ``None`` when it was already stored.

    Idempotent on ``(tenant_id, dedup_key)`` so a terminal re-posting after
    a missed acknowledgement cannot double-count a person's day.
    """

    row = conn.execute(
        pg_insert(device_attendance_events)
        .values(
            tenant_id=scope.tenant_id,
            device_id=device_id,
            device_user_id=device_user_id,
            person_name=person_name,
            event_serial=event_serial,
            dedup_key=dedup_key,
            occurred_at=occurred_at,
            verify_mode=verify_mode,
            direction=direction,
            clock_suspect=clock_suspect,
            employee_id=employee_id,
            # An unmapped person's tap is parked, not dropped: mapping them
            # later replays it (see processor.replay_for_device_user).
            status="pending" if employee_id is not None else "skipped",
            raw=raw,
        )
        .on_conflict_do_nothing(constraint="uq_device_events_tenant_dedup")
        .returning(device_attendance_events.c.id)
    ).first()
    return int(row.id) if row is not None else None


def list_device_events(
    conn: Connection, scope: TenantScope, device_id: int, *, limit: int = 100
) -> list[DeviceEventRow]:
    rows = conn.execute(
        select(device_attendance_events)
        .where(
            device_attendance_events.c.tenant_id == scope.tenant_id,
            device_attendance_events.c.device_id == device_id,
        )
        .order_by(device_attendance_events.c.received_at.desc())
        .limit(limit)
    ).all()
    return [
        DeviceEventRow(
            id=r.id,
            device_id=r.device_id,
            device_user_id=r.device_user_id,
            person_name=r.person_name,
            event_serial=r.event_serial,
            occurred_at=r.occurred_at,
            received_at=r.received_at,
            verify_mode=r.verify_mode,
            direction=r.direction,
            status=r.status,
            clock_suspect=r.clock_suspect,
            employee_id=r.employee_id,
        )
        for r in rows
    ]


def note_event_received(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    at: datetime,
    reported_device_name: Optional[str],
    clock_suspect: bool,
) -> None:
    """Liveness bookkeeping. Also called for keepalives, which carry no tap.

    ``clock_suspect`` latches on: once a terminal has reported a nonsense
    timestamp the operator needs to see that until they fix and it reports
    a good one, which clears it on the next healthy event.
    """

    values: dict[str, Any] = {
        "last_event_at": at,
        "last_seen_at": at,
        "health_status": "online",
        "clock_suspect": clock_suspect,
        "updated_at": func.now(),
    }
    if reported_device_name:
        values["reported_device_name"] = reported_device_name

    conn.execute(
        update(attendance_devices)
        .where(
            attendance_devices.c.id == device_id,
            attendance_devices.c.tenant_id == scope.tenant_id,
        )
        .values(**values)
    )


def learn_device_identity(
    conn: Connection,
    scope: TenantScope,
    *,
    device_id: int,
    serial_number: Optional[str],
    model: Optional[str],
    firmware: Optional[str],
) -> None:
    """Fill in hardware facts the first time a device reveals them.

    Only writes columns that are still NULL — a terminal that starts
    reporting a different serial must not silently rewrite the registry
    entry an operator already verified.
    """

    values: dict[str, Any] = {}
    if serial_number:
        values["serial_number"] = func.coalesce(
            attendance_devices.c.serial_number, serial_number
        )
    if model:
        values["model"] = func.coalesce(attendance_devices.c.model, model)
    if firmware:
        values["firmware"] = func.coalesce(attendance_devices.c.firmware, firmware)
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
