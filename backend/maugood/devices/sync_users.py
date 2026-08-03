"""User sync — pull a terminal's person list into ``device_users``.

Real ISAPI pull (best-effort): connects to the device, lists its people,
upserts each into ``device_users``, and auto-maps to a Maugood employee by
matching the device person id to ``employees.employee_code``.

If the device is unreachable, it returns ``(0, 0, False)`` and leaves the
existing rows untouched — an unreachable device is NOT "zero users", so we
never wipe the table on a failed pull.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.engine import Connection

from maugood.db import attendance_devices
from maugood.devices import repository as repo
from maugood.devices.crypto import decrypt_credentials
from maugood.devices.drivers import hikvision
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def sync_device_users(
    conn: Connection,
    scope: TenantScope,
    device: repo.DeviceRow,
) -> tuple[int, int, bool]:
    """Pull + upsert + auto-map. Returns ``(synced, unmapped, reachable)``."""

    username, password = decrypt_credentials(device.credentials_encrypted)

    # Only the Hikvision driver exists today; other drivers slot in here.
    users, reachable = hikvision.list_users(
        device.host, device.port, username, password
    )

    if not reachable:
        logger.info(
            "device user sync: unreachable device_id=%s host=%s",
            device.id,
            device.host,
        )
        # Report the current stored counts so the UI still shows state.
        total, unmapped = repo.count_device_users(conn, scope, device.id)
        return total, unmapped, False

    now = datetime.now(tz=timezone.utc)
    for u in users:
        emp_id = repo.employee_id_for_code(conn, scope, u.device_user_id)
        repo.upsert_device_user(
            conn,
            scope,
            device_id=device.id,
            device_user_id=u.device_user_id,
            name=u.name,
            card_no=u.card_no,
            employee_id=emp_id,
            synced_at=now,
        )

    total, unmapped = repo.count_device_users(conn, scope, device.id)

    conn.execute(
        update(attendance_devices)
        .where(
            attendance_devices.c.id == device.id,
            attendance_devices.c.tenant_id == scope.tenant_id,
        )
        .values(users_synced=total, last_user_sync_at=now, health_status="online")
    )

    logger.info(
        "device user sync: device_id=%s pulled=%s total=%s unmapped=%s",
        device.id,
        len(users),
        total,
        unmapped,
    )
    return total, unmapped, True
