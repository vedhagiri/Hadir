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
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.config import get_settings
from maugood.db import get_engine, tenant_context
from maugood.devices import processor
from maugood.devices import repository as repo
from maugood.devices import sync_users as sync_users_service
from maugood.devices import tokens
from maugood.devices.crypto import encrypt_credentials
from maugood.devices.schemas import (
    AutoMapResult,
    DeviceCreateIn,
    DeviceEventListOut,
    DeviceEventOut,
    DeviceListOut,
    DeviceOut,
    DevicePatchIn,
    DeviceUserListOut,
    DeviceUserOut,
    MapDeviceUserIn,
    MapDeviceUserResult,
    SyncUsersResult,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/devices", tags=["devices"])

ADMIN = Depends(require_role("Admin"))


def _push_url(token: str, device_name: str) -> str:
    """Build the exact string an operator pastes into the terminal."""

    base = get_settings().device_push_base_url.rstrip("/")
    return f"{base}/hik/{token}?device_name={_slug(device_name)}"


def _slug(value: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in value.lower())
    return "-".join(part for part in out.split("-") if part) or "device"


def _row_to_out(
    row: repo.DeviceRow,
    *,
    reveal_token: bool = False,
    users_total: int = 0,
    users_unmapped: int = 0,
) -> DeviceOut:
    """Shape a row for the API.

    ``reveal_token`` decrypts the stored push token so the UI can show the
    URL. It is safe here — the caller is an authenticated Admin — but the
    value must never reach a log line or an audit payload.
    """

    token: Optional[str] = None
    url: Optional[str] = None
    if reveal_token and row.push_token_encrypted:
        try:
            token = tokens.decrypt_token(row.push_token_encrypted)
            url = _push_url(token, row.name)
        except Exception:  # noqa: BLE001
            # A key rotation can orphan an old ciphertext. Surface the
            # device without its URL rather than failing the whole list;
            # the operator can regenerate.
            logger.warning(
                "could not decrypt push token for device id=%s", row.id
            )

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
        connection_mode=row.connection_mode,
        push_url=url,
        push_token=token,
        last_event_at=row.last_event_at,
        clock_suspect=row.clock_suspect,
        reported_device_name=row.reported_device_name,
        users_total=users_total,
        users_unmapped=users_unmapped,
    )


def _audit_payload(row: repo.DeviceRow) -> dict:
    """Recorded on every audit row.

    Never the credentials blob and never the push token — an audit row is
    readable by anyone with audit access, and the token is a live
    credential that would let its holder post attendance for this tenant.
    """

    return {
        "name": row.name,
        "location": row.location,
        "driver": row.driver,
        "connection_mode": row.connection_mode,
        "host": row.host,
        "port": row.port,
        "serial_number": row.serial_number,
        "door_no": row.door_no,
        "enrollment_scope": row.enrollment_scope,
        "enabled": row.enabled,
        "health_status": row.health_status,
    }


def _register_token(
    *, tenant_id: int, tenant_schema: str, device_id: int, token_hash: str
) -> None:
    """Write the global routing row, outside the tenant's own schema."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.register(
                conn,
                token_hash=token_hash,
                tenant_id=tenant_id,
                tenant_schema=tenant_schema,
                device_id=device_id,
            )


def _schema_for(user: CurrentUser) -> str:
    return getattr(user, "tenant_schema", None) or _lookup_schema(user.tenant_id)


def _lookup_schema(tenant_id: int) -> str:
    from maugood.db import tenants  # noqa: PLC0415

    with tenant_context("public"):
        with get_engine().begin() as conn:
            row = conn.execute(
                select(tenants.c.schema_name).where(tenants.c.id == tenant_id)
            ).first()
    if row is None:
        raise HTTPException(status_code=500, detail="tenant not resolvable")
    return str(row.schema_name)


@router.get("", response_model=DeviceListOut)
def list_devices_endpoint(user: Annotated[CurrentUser, ADMIN]) -> DeviceListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_devices(conn, scope)
        counts = {
            r.id: repo.count_device_users(conn, scope, r.id) for r in rows
        }
    return DeviceListOut(
        items=[
            _row_to_out(
                r,
                reveal_token=True,
                users_total=counts[r.id][0],
                users_unmapped=counts[r.id][1],
            )
            for r in rows
        ]
    )


@router.post("", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
def create_device_endpoint(
    payload: DeviceCreateIn,
    user: Annotated[CurrentUser, ADMIN],
) -> DeviceOut:
    """Register a push device and mint its token.

    Nothing is contacted here — the device may not even be powered on yet.
    We hand back a URL; the operator pastes it into the terminal, and the
    device introduces itself with its first event.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    schema = _schema_for(user)

    token = tokens.mint_token()
    token_hash = tokens.hash_token(token)

    with get_engine().begin() as conn:
        new_id = repo.create_push_device(
            conn,
            scope,
            name=payload.name,
            location=payload.location,
            driver=payload.driver,
            enabled=payload.enabled,
            push_token_hash=token_hash,
            push_token_encrypted=tokens.encrypt_token(token),
        )
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

    _register_token(
        tenant_id=scope.tenant_id,
        tenant_schema=schema,
        device_id=new_id,
        token_hash=token_hash,
    )

    logger.info("device created: id=%s name=%r mode=push", new_id, payload.name)
    return _row_to_out(created, reveal_token=True)


@router.post("/{device_id}/regenerate-token", response_model=DeviceOut)
def regenerate_token_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> DeviceOut:
    """Issue a new token and revoke the old one immediately.

    The terminal must be reconfigured with the new URL; until it is, its
    posts resolve to a revoked row and are refused. That is the intended
    behaviour for a leaked URL — availability is the lesser concern.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    schema = _schema_for(user)

    token = tokens.mint_token()
    token_hash = tokens.hash_token(token)

    with get_engine().begin() as conn:
        before = repo.get_device(conn, scope, device_id)
        if before is None:
            raise HTTPException(status_code=404, detail="device not found")
        repo.update_device(
            conn,
            scope,
            device_id,
            values={
                "push_token_hash": token_hash,
                "push_token_encrypted": tokens.encrypt_token(token),
                "connection_mode": "push",
            },
        )
        after = repo.get_device(conn, scope, device_id)
        assert after is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.push_token_rotated",
            entity_type="device",
            entity_id=str(device_id),
            before=_audit_payload(before),
            after=_audit_payload(after),
        )

    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.revoke_for_device(
                conn, tenant_id=scope.tenant_id, device_id=device_id
            )
            tokens.register(
                conn,
                token_hash=token_hash,
                tenant_id=scope.tenant_id,
                tenant_schema=schema,
                device_id=device_id,
            )

    logger.info("device push token rotated: id=%s", device_id)
    return _row_to_out(after, reveal_token=True)


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
            return _row_to_out(before, reveal_token=True)

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

    logger.info("device updated: id=%s", device_id)
    return _row_to_out(after, reveal_token=True)


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

    # Drop the global routing rows too, or a decommissioned terminal keeps
    # resolving to a tenant whose device row no longer exists.
    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.delete_for_device(
                conn, tenant_id=scope.tenant_id, device_id=device_id
            )

    logger.info("device deleted: id=%s", device_id)
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
                first_seen_at=r.first_seen_at,
                last_seen_at=r.last_seen_at,
                taps_count=r.taps_count,
                source=r.source,
                employee_code=r.employee_code,
                employee_name=r.employee_name,
            )
            for r in rows
        ]
    )


@router.get("/{device_id}/events", response_model=DeviceEventListOut)
def list_device_events_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
    limit: int = Query(default=100, ge=1, le=500),
) -> DeviceEventListOut:
    """Raw taps this terminal has reported, newest first."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        if repo.get_device(conn, scope, device_id) is None:
            raise HTTPException(status_code=404, detail="device not found")
        rows = repo.list_device_events(conn, scope, device_id, limit=limit)
    return DeviceEventListOut(
        items=[
            DeviceEventOut(
                id=r.id,
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
    )


@router.post(
    "/{device_id}/users/{device_user_id}/map", response_model=MapDeviceUserResult
)
def map_device_user_endpoint(
    device_id: int,
    device_user_id: str,
    payload: MapDeviceUserIn,
    user: Annotated[CurrentUser, ADMIN],
) -> MapDeviceUserResult:
    """Point a person the device reported at a Maugood employee.

    Taps that arrived before the mapping existed were parked rather than
    dropped, so mapping replays them and recalculates the affected days.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    schema = _schema_for(user)
    scope = TenantScope(tenant_id=scope.tenant_id, tenant_schema=schema)

    with get_engine().begin() as conn:
        if repo.get_device(conn, scope, device_id) is None:
            raise HTTPException(status_code=404, detail="device not found")

        if payload.employee_id is not None and not _employee_exists(
            conn, scope, payload.employee_id
        ):
            # Cross-tenant employee id must not be distinguishable from a
            # nonexistent one.
            raise HTTPException(status_code=404, detail="employee not found")

        ok = repo.map_device_user(
            conn,
            scope,
            device_id=device_id,
            device_user_id=device_user_id,
            employee_id=payload.employee_id,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="device user not found")

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="device.user_mapped",
            entity_type="device_user",
            entity_id=f"{device_id}:{device_user_id}",
            after={
                "device_id": device_id,
                "device_user_id": device_user_id,
                "employee_id": payload.employee_id,
            },
        )

    replayed = 0
    if payload.employee_id is not None:
        replayed = processor.replay_for_device_user(
            scope,
            device_id=device_id,
            device_user_id=device_user_id,
            employee_id=payload.employee_id,
        )

    logger.info(
        "device user mapped: device_id=%s device_user_id=%s employee_id=%s "
        "replayed=%s",
        device_id,
        device_user_id,
        payload.employee_id,
        replayed,
    )
    return MapDeviceUserResult(
        device_user_id=device_user_id,
        employee_id=payload.employee_id,
        replayed=replayed,
    )


@router.post("/{device_id}/users/auto-map", response_model=AutoMapResult)
def auto_map_endpoint(
    device_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> AutoMapResult:
    """Match every unmapped device person whose id equals an employee code."""

    scope = TenantScope(tenant_id=user.tenant_id)
    schema = _schema_for(user)
    scope = TenantScope(tenant_id=scope.tenant_id, tenant_schema=schema)

    matched: list[tuple[str, int]] = []
    with get_engine().begin() as conn:
        if repo.get_device(conn, scope, device_id) is None:
            raise HTTPException(status_code=404, detail="device not found")

        for row in repo.list_device_users(conn, scope, device_id):
            if row.employee_id is not None:
                continue
            employee_id = repo.employee_id_for_code(
                conn, scope, row.device_user_id
            )
            if employee_id is None:
                continue
            repo.map_device_user(
                conn,
                scope,
                device_id=device_id,
                device_user_id=row.device_user_id,
                employee_id=employee_id,
            )
            matched.append((row.device_user_id, employee_id))

        if matched:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="device.users_auto_mapped",
                entity_type="device",
                entity_id=str(device_id),
                after={"device_id": device_id, "mapped": len(matched)},
            )

        _, still_unmapped = repo.count_device_users(conn, scope, device_id)

    replayed = 0
    for device_user_id, employee_id in matched:
        replayed += processor.replay_for_device_user(
            scope,
            device_id=device_id,
            device_user_id=device_user_id,
            employee_id=employee_id,
        )

    logger.info(
        "device users auto-mapped: device_id=%s mapped=%s replayed=%s",
        device_id,
        len(matched),
        replayed,
    )
    return AutoMapResult(
        mapped=len(matched), still_unmapped=still_unmapped, replayed=replayed
    )


def _employee_exists(conn, scope: TenantScope, employee_id: int) -> bool:
    from maugood.db import employees  # noqa: PLC0415

    row = conn.execute(
        select(employees.c.id).where(
            employees.c.id == employee_id,
            employees.c.tenant_id == scope.tenant_id,
        )
    ).first()
    return row is not None
