"""FastAPI router for ``/api/devices/*`` — Admin-only.

Attendance-device registry CRUD. Credentials are Fernet-encrypted before
persist and NEVER appear in a response, audit row, or log line (only host
+ port + serial do). Cross-tenant ``{device_id}`` returns 404, never 403
(403 would leak existence) — every lookup filters ``WHERE tenant_id``.

The serial is read from the device on create via the driver; on an
unreachable device it falls back to an ``UNVERIFIED-…`` placeholder so
registration still works in dev. ``sync-users`` is a stub until the
``device_users`` table lands.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.db import get_engine
from maugood.devices import repository as repo
from maugood.devices import sync_users as sync_users_service
from maugood.devices.crypto import encrypt_credentials
from maugood.devices.drivers import hikvision
from maugood.devices.schemas import (
    DeviceCreateIn,
    DeviceListOut,
    DeviceOut,
    DevicePatchIn,
    DeviceUserListOut,
    DeviceUserOut,
    SyncUsersResult,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/devices", tags=["devices"])

ADMIN = Depends(require_role("Admin"))


def _row_to_out(row: repo.DeviceRow) -> DeviceOut:
    return DeviceOut(
        id=row.id,
        name=row.name,
        location=row.location,
        driver=row.driver,
        host=row.host,
        port=row.port,
        door_no=row.door_no,
        serial_number=row.serial_number,
        model=row.model,
        firmware=row.firmware,
        enabled=row.enabled,
        enrollment_scope=row.enrollment_scope,
        health_status=row.health_status,
        users_synced=row.users_synced,
        last_user_sync_at=row.last_user_sync_at,
        last_seen_at=row.last_seen_at,
        created_at=row.created_at,
    )


def _audit_payload(row: repo.DeviceRow) -> dict:
    """Recorded on every audit row — never the credentials token."""

    return {
        "name": row.name,
        "location": row.location,
        "driver": row.driver,
        "host": row.host,
        "port": row.port,
        "serial_number": row.serial_number,
        "door_no": row.door_no,
        "enrollment_scope": row.enrollment_scope,
        "enabled": row.enabled,
        "health_status": row.health_status,
    }


@router.get("", response_model=DeviceListOut)
def list_devices_endpoint(user: Annotated[CurrentUser, ADMIN]) -> DeviceListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_devices(conn, scope)
    return DeviceListOut(items=[_row_to_out(r) for r in rows])


@router.post("", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
def create_device_endpoint(
    payload: DeviceCreateIn,
    user: Annotated[CurrentUser, ADMIN],
) -> DeviceOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    # Read the device identity (serial/model/firmware). Best-effort:
    # unreachable → fallback serial + health 'unreachable'.
    info = hikvision.read_info(
        payload.host, payload.port, payload.username, payload.password
    )
    health = "online" if info.reachable else "unreachable"

    encrypted = encrypt_credentials(payload.username, payload.password)

    with get_engine().begin() as conn:
        try:
            new_id = repo.create_device(
                conn,
                scope,
                name=payload.name,
                location=payload.location,
                driver=payload.driver,
                host=payload.host,
                port=payload.port,
                credentials_encrypted=encrypted,
                serial_number=info.serial_number,
                model=info.model,
                firmware=info.firmware,
                door_no=payload.door_no,
                enrollment_scope=payload.enrollment_scope,
                enabled=payload.enabled,
                health_status=health,
            )
        except IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "serial_number",
                    "message": "This device (serial) is already registered.",
                },
            ) from exc
        created = repo.get_device(conn, scope, new_id)
        assert created is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.created",
            entity_type="device",
            entity_id=str(new_id),
            after=_audit_payload(created),
        )

    logger.info(
        "device created: id=%s name=%r host=%s serial=%s reachable=%s",
        new_id,
        payload.name,
        payload.host,
        info.serial_number,
        info.reachable,
    )
    return _row_to_out(created)


@router.patch("/{device_id}", response_model=DeviceOut)
def patch_device_endpoint(
    device_id: int,
    payload: DevicePatchIn,
    user: Annotated[CurrentUser, ADMIN],
) -> DeviceOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)

    with get_engine().begin() as conn:
        before = repo.get_device(conn, scope, device_id)
        if before is None:
            raise HTTPException(status_code=404, detail="device not found")

        values: dict[str, object] = {}
        for field in (
            "name",
            "location",
            "driver",
            "host",
            "port",
            "door_no",
            "enrollment_scope",
            "enabled",
        ):
            if field in provided:
                values[field] = provided[field]

        # Credential rotation — require both or neither.
        has_user = bool(provided.get("username"))
        has_pass = bool(provided.get("password"))
        if has_user or has_pass:
            if not (has_user and has_pass):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "field": "credentials",
                        "message": "Provide both username and password to rotate.",
                    },
                )
            values["credentials_encrypted"] = encrypt_credentials(
                provided["username"], provided["password"]
            )

        if not values:
            return _row_to_out(before)

        repo.update_device(conn, scope, device_id, values=values)
        after = repo.get_device(conn, scope, device_id)
        assert after is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.updated",
            entity_type="device",
            entity_id=str(device_id),
            before=_audit_payload(before),
            after=_audit_payload(after),
        )

    logger.info("device updated: id=%s host=%s", device_id, after.host)
    return _row_to_out(after)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_device_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        before = repo.get_device(conn, scope, device_id)
        if before is None:
            raise HTTPException(status_code=404, detail="device not found")
        repo.delete_device(conn, scope, device_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.deleted",
            entity_type="device",
            entity_id=str(device_id),
            before=_audit_payload(before),
        )
    logger.info("device deleted: id=%s host=%s", device_id, before.host)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/{device_id}/sync-users", response_model=SyncUsersResult)
def sync_users_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> SyncUsersResult:
    """Pull the device user list into ``device_users`` and auto-map each to a
    Maugood employee by employee code.

    Real ISAPI pull (best-effort). An unreachable device returns the
    current stored counts with ``reachable=false`` and leaves rows intact —
    it never wipes ``device_users`` on a failed pull.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_device(conn, scope, device_id)
        if row is None:
            raise HTTPException(status_code=404, detail="device not found")
        synced, unmapped, reachable = sync_users_service.sync_device_users(
            conn, scope, row
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.users_synced",
            entity_type="device",
            entity_id=str(device_id),
            after={
                "synced": synced,
                "unmapped": unmapped,
                "reachable": reachable,
            },
        )
    logger.info(
        "device sync-users: id=%s synced=%s unmapped=%s reachable=%s",
        device_id,
        synced,
        unmapped,
        reachable,
    )
    return SyncUsersResult(synced=synced, unmapped=unmapped, reachable=reachable)


@router.get("/{device_id}/users", response_model=DeviceUserListOut)
def list_device_users_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> DeviceUserListOut:
    """List the users synced from a device (+ their employee mapping)."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_device(conn, scope, device_id)
        if row is None:
            raise HTTPException(status_code=404, detail="device not found")
        rows = repo.list_device_users(conn, scope, device_id)
    return DeviceUserListOut(
        items=[
            DeviceUserOut(
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
    )
