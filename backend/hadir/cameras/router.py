"""FastAPI router for ``/api/cameras/*`` — Admin-only.

Every response, audit row, and error message is written to use
``rtsp_host`` at most. A log line or response body containing
``rtsp://user:pass@…`` is a bug — grep the container logs for it before
shipping.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import Response as BytesResponse
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.cameras import repository as repo
from hadir.cameras import rtsp as rtsp_io
from hadir.cameras.schemas import (
    CameraCreateIn,
    CameraListOut,
    CameraOut,
    CameraPatchIn,
)
from hadir.capture import capture_manager
from hadir.db import get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

ADMIN = Depends(require_role("Admin"))


def _row_to_out(row: repo.CameraRow) -> CameraOut:
    return CameraOut(
        id=row.id,
        name=row.name,
        location=row.location,
        rtsp_host=row.rtsp_host,
        enabled=row.enabled,
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        images_captured_24h=row.images_captured_24h,
    )


@router.get("", response_model=CameraListOut)
def list_cameras_endpoint(user: Annotated[CurrentUser, ADMIN]) -> CameraListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_cameras(conn, scope)
    return CameraListOut(items=[_row_to_out(r) for r in rows])


@router.post("", response_model=CameraOut, status_code=status.HTTP_201_CREATED)
def create_camera_endpoint(
    payload: CameraCreateIn,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    try:
        parts = rtsp_io.parse_rtsp_url(payload.rtsp_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    encrypted = rtsp_io.encrypt_url(payload.rtsp_url)

    with get_engine().begin() as conn:
        new_id = repo.create_camera(
            conn,
            scope,
            name=payload.name,
            location=payload.location,
            rtsp_url_encrypted=encrypted,
            enabled=payload.enabled,
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.created",
            entity_type="camera",
            entity_id=str(new_id),
            after={
                "name": payload.name,
                "location": payload.location,
                "rtsp_host": parts.host,
                "enabled": payload.enabled,
            },
        )
        created = repo.get_camera(conn, scope, new_id)
        assert created is not None

    logger.info(
        "camera created: id=%s name=%r host=%s", new_id, payload.name, parts.host
    )
    capture_manager.on_camera_created(new_id)
    return _row_to_out(created)


@router.patch("/{camera_id}", response_model=CameraOut)
def patch_camera_endpoint(
    camera_id: int,
    payload: CameraPatchIn,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)

    with get_engine().begin() as conn:
        before = repo.get_camera(conn, scope, camera_id)
        if before is None:
            raise HTTPException(status_code=404, detail="camera not found")

        values: dict[str, object] = {}
        new_host: str | None = None

        if "name" in provided:
            values["name"] = provided["name"]
        if "location" in provided:
            values["location"] = provided["location"]
        if "enabled" in provided:
            values["enabled"] = provided["enabled"]

        if "rtsp_url" in provided and provided["rtsp_url"] is not None:
            try:
                parts = rtsp_io.parse_rtsp_url(provided["rtsp_url"])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            values["rtsp_url_encrypted"] = rtsp_io.encrypt_url(
                provided["rtsp_url"]
            )
            new_host = parts.host

        repo.update_camera(conn, scope, camera_id, values=values)
        after = repo.get_camera(conn, scope, camera_id)
        assert after is not None

        # Audit carries rtsp_host only. Changed credentials surface as a
        # host change (if the host itself changed); same-host re-key is
        # recorded as `rtsp_url_rotated=True` without any URL content.
        audit_after: dict[str, object] = {
            "name": after.name,
            "location": after.location,
            "enabled": after.enabled,
            "rtsp_host": after.rtsp_host,
        }
        audit_before: dict[str, object] = {
            "name": before.name,
            "location": before.location,
            "enabled": before.enabled,
            "rtsp_host": before.rtsp_host,
        }
        if new_host is not None and new_host == before.rtsp_host:
            audit_after["rtsp_url_rotated"] = True
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.updated",
            entity_type="camera",
            entity_id=str(camera_id),
            before=audit_before,
            after=audit_after,
        )

    logger.info("camera updated: id=%s host=%s", camera_id, after.rtsp_host)
    capture_manager.on_camera_updated(camera_id)
    return _row_to_out(after)


@router.delete("/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_camera_endpoint(
    camera_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        before = repo.get_camera(conn, scope, camera_id)
        if before is None:
            raise HTTPException(status_code=404, detail="camera not found")
        repo.delete_camera(conn, scope, camera_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.deleted",
            entity_type="camera",
            entity_id=str(camera_id),
            before={
                "name": before.name,
                "location": before.location,
                "rtsp_host": before.rtsp_host,
            },
        )
    logger.info("camera deleted: id=%s host=%s", camera_id, before.rtsp_host)
    capture_manager.on_camera_deleted(camera_id)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/{camera_id}/preview")
def preview_camera_endpoint(
    camera_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> BytesResponse:
    """On-demand single frame. Opens the stream, grabs one frame, closes.

    5-second hard timeout. The plaintext RTSP URL only exists inside
    this function and the ``grab_single_frame`` worker thread; it's
    never logged, returned, or audited.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_camera(conn, scope, camera_id)
        if row is None:
            raise HTTPException(status_code=404, detail="camera not found")
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.previewed",
            entity_type="camera",
            entity_id=str(camera_id),
            after={"rtsp_host": row.rtsp_host},
        )

    try:
        plain_url = rtsp_io.decrypt_url(row.rtsp_url_encrypted)
    except RuntimeError as exc:
        logger.warning(
            "preview decrypt failed: id=%s host=%s", camera_id, row.rtsp_host
        )
        raise HTTPException(
            status_code=500, detail="could not decrypt stored URL"
        ) from exc

    try:
        jpeg = rtsp_io.dispatched_grab(plain_url, host_label=row.rtsp_host)
    except RuntimeError as exc:
        # ``str(exc)`` is safe — our own messages ("preview timed out",
        # "could not open stream") don't echo the URL.
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    finally:
        # Best-effort overwrite. Python strings can't really be zeroed
        # but we drop the reference so GC can collect.
        plain_url = ""  # noqa: F841
        del plain_url

    return BytesResponse(content=jpeg, media_type="image/jpeg")
