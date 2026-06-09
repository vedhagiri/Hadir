"""FastAPI router for ``/api/cameras/*`` — Admin-only.

Every response, audit row, and error message is written to use
``rtsp_host`` at most. A log line or response body containing
``rtsp://user:pass@…`` is a bug — grep the container logs for it before
shipping.

P28.5b: CRUD now accepts/returns ``worker_enabled``, ``display_enabled``,
and ``capture_config`` (the per-camera knob bag). Audit ``before`` /
``after`` carry the full row state so an auditor can see exactly what
flipped on every operator action.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import Response as BytesResponse
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.cameras import repository as repo
from maugood.cameras import rtsp as rtsp_io
from maugood.cameras import transfer
from maugood.cameras.schemas import (
    CameraBulkUpdateIn,
    CameraBulkUpdateResult,
    CameraCreateIn,
    CameraExportFile,
    CameraImportPreview,
    CameraImportPreviewRow,
    CameraImportRequest,
    CameraImportResult,
    CameraImportResultRow,
    CameraImportSummary,
    CameraListOut,
    CameraOut,
    CameraPatchIn,
    CaptureConfig,
)
from maugood.capture import capture_manager
from maugood.db import get_engine
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

ADMIN = Depends(require_role("Admin"))


# Canonical stream-id lives in ``rtsp.py`` so the bulk-import classifier
# (``cameras.transfer``) and this router agree on what "the same stream"
# means. Kept as a module alias so existing references stay terse.
_canonical_stream_id = rtsp_io.canonical_stream_id


def _check_duplicate_url(
    scope: TenantScope,
    plain_url: str,
    brand: str | None,
    *,
    excluding_id: int | None = None,
) -> None:
    """BUG-032 / BUG-033 — refuse to save a camera that points at a
    stream another camera in the same tenant already uses. Pre-check
    instead of an IntegrityError because RTSP URLs are stored
    Fernet-encrypted (so a database-level UNIQUE on ciphertext doesn't
    help — every encrypt() returns a different ciphertext)."""
    new_canon = _canonical_stream_id(plain_url)
    new_brand = (brand or "").strip().lower()
    with get_engine().begin() as conn:
        rows = repo.list_cameras(conn, scope)
    for row in rows:
        if excluding_id is not None and row.id == excluding_id:
            continue
        try:
            existing_plain = rtsp_io.decrypt_url(row.rtsp_url_encrypted)
        except Exception:  # noqa: BLE001
            continue
        existing_canon = _canonical_stream_id(existing_plain)
        if existing_canon == new_canon:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "rtsp_url",
                    "code": "duplicate_rtsp_url",
                    "existing_camera_id": row.id,
                    "existing_camera_name": row.name,
                    "message": (
                        f"This camera/RTSP URL is already added "
                        f"(as '{row.name}'). Delete the existing camera "
                        f"first to add it again."
                    ),
                },
            )
        # BUG-033 — same brand + same host = almost certainly the same
        # physical device (some cameras expose multiple sub-streams via
        # different paths). Block this combo too so the operator isn't
        # tracking the same hardware under two names.
        if (
            new_brand
            and (row.brand or "").strip().lower() == new_brand
            and rtsp_io.rtsp_host(existing_plain) == rtsp_io.rtsp_host(plain_url)
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "rtsp_url",
                    "message": (
                        f"Camera '{row.name}' uses the same brand and host "
                        f"({brand} @ {rtsp_io.rtsp_host(existing_plain)}). "
                        f"Confirm this isn't the same physical device."
                    ),
                },
            )


def _row_to_out(row: repo.CameraRow) -> CameraOut:
    return CameraOut(
        id=row.id,
        camera_code=row.camera_code,
        name=row.name,
        location=row.location,
        zone=row.zone,
        rtsp_host=row.rtsp_host,
        worker_enabled=row.worker_enabled,
        display_enabled=row.display_enabled,
        detection_enabled=row.detection_enabled,
        clip_recording_enabled=row.clip_recording_enabled,
        live_matching_enabled=row.live_matching_enabled,
        capture_config=CaptureConfig.model_validate(row.capture_config),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        images_captured_24h=row.images_captured_24h,
        detected_resolution_w=row.detected_resolution_w,
        detected_resolution_h=row.detected_resolution_h,
        detected_fps=row.detected_fps,
        detected_codec=row.detected_codec,
        detected_at=row.detected_at,
        brand=row.brand,
        model=row.model,
        mount_location=row.mount_location,
    )


def _audit_payload(row: repo.CameraRow) -> dict:
    """The slice of camera state we record on every audit row.

    Carries the full operational state (both flags + the knob bag)
    so a before/after pair captures any flip without ambiguity. Never
    contains the encrypted token or the plaintext URL — only the
    parsed host.
    """

    return {
        "name": row.name,
        "camera_code": row.camera_code,
        "zone": row.zone,
        "location": row.location,
        "rtsp_host": row.rtsp_host,
        "worker_enabled": row.worker_enabled,
        "display_enabled": row.display_enabled,
        "detection_enabled": row.detection_enabled,
        "clip_recording_enabled": row.clip_recording_enabled,
        "live_matching_enabled": row.live_matching_enabled,
        "capture_config": dict(row.capture_config),
    }


def _load_existing(
    conn: Connection, scope: TenantScope
) -> list[transfer.ExistingCamera]:
    """Snapshot existing cameras for the import classifier — decrypt each
    stored URL once to its canonical stream id so the classifier never
    re-lists or re-decrypts per row."""

    out: list[transfer.ExistingCamera] = []
    for r in repo.list_cameras(conn, scope):
        try:
            canon = rtsp_io.canonical_stream_id(
                rtsp_io.decrypt_url(r.rtsp_url_encrypted)
            )
        except Exception:  # noqa: BLE001 — undecryptable row can't conflict
            canon = None
        out.append(
            transfer.ExistingCamera(
                id=r.id, name=r.name, camera_code=r.camera_code, canon=canon
            )
        )
    return out


def _bool_or(value: bool | None, default: bool) -> bool:
    return default if value is None else bool(value)


@router.get("", response_model=CameraListOut)
def list_cameras_endpoint(user: Annotated[CurrentUser, ADMIN]) -> CameraListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_cameras(conn, scope)
    return CameraListOut(items=[_row_to_out(r) for r in rows])


@router.get("/export", response_model=CameraExportFile)
def export_cameras_endpoint(
    user: Annotated[CurrentUser, ADMIN],
    ids: Annotated[Optional[str], Query()] = None,
) -> CameraExportFile:
    """Export camera configuration as JSON. ``?ids=1,2,3`` exports the
    named cameras; omit it to export every camera in the tenant.

    The payload carries the PLAINTEXT ``rtsp_url`` per the operator's
    chosen behaviour (full round-trip). The audit row records only the
    count + ids — never a URL."""

    scope = TenantScope(tenant_id=user.tenant_id)
    selected: Optional[set[int]] = None
    if ids:
        selected = set()
        for part in ids.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                selected.add(int(part))
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "field": "ids",
                        "message": "ids must be comma-separated integers",
                    },
                ) from exc

    with get_engine().begin() as conn:
        rows = repo.list_cameras(conn, scope)
        if selected is not None:
            rows = [r for r in rows if r.id in selected]
        payload = transfer.build_export_payload(
            rows,
            decrypt_url=rtsp_io.decrypt_url,
            tenant_slug=None,
            exported_at=datetime.now(tz=timezone.utc),
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.exported",
            entity_type="camera",
            entity_id=None,
            after={"count": payload.count, "camera_ids": [r.id for r in rows]},
        )
    logger.info(
        "cameras exported: tenant=%s count=%s", scope.tenant_id, payload.count
    )
    return payload


@router.post("/import-preview", response_model=CameraImportPreview)
def preview_import_cameras_endpoint(
    payload: CameraImportRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraImportPreview:
    """Dry-run: classify every uploaded row (create / update / skip /
    error) without writing anything. Drives the preview table."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = _load_existing(conn, scope)
    classified = transfer.classify_imports(
        existing, payload.cameras, mode=payload.on_existing
    )

    counts = {"create": 0, "update": 0, "skip": 0, "error": 0}
    rows: list[CameraImportPreviewRow] = []
    for row in classified:
        counts[row.action] += 1
        rows.append(
            CameraImportPreviewRow(
                index=row.index,
                action=row.action,  # type: ignore[arg-type]
                camera_code=(row.item.camera_code or "").strip() or None,
                name=(row.item.name or "").strip() or None,
                rtsp_host=row.rtsp_host,
                matched_camera_id=row.matched_id,
                message=row.message,
            )
        )
    return CameraImportPreview(
        summary=CameraImportSummary(**counts), rows=rows
    )


@router.post("/import", response_model=CameraImportResult)
def import_cameras_endpoint(
    payload: CameraImportRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraImportResult:
    """Apply an import. Creates new cameras, updates existing ones (when
    ``on_existing='update'``), and skips duplicates. Each create/update
    runs in its own transaction so one bad row doesn't roll back the
    rest — mirrors the employee-import contract."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = _load_existing(conn, scope)
    classified = transfer.classify_imports(
        existing, payload.cameras, mode=payload.on_existing
    )

    created = updated = skipped = errors = 0
    created_ids: list[int] = []
    updated_ids: list[int] = []
    result_rows: list[CameraImportResultRow] = []

    for row in classified:
        item = row.item
        if row.action == "create":
            try:
                with get_engine().begin() as conn:
                    new_id = repo.create_camera(
                        conn,
                        scope,
                        name=(item.name or "").strip(),
                        location=(item.location or "").strip(),
                        rtsp_url_encrypted=rtsp_io.encrypt_url(
                            (item.rtsp_url or "").strip()
                        ),
                        worker_enabled=_bool_or(item.worker_enabled, False),
                        display_enabled=_bool_or(item.display_enabled, False),
                        detection_enabled=_bool_or(item.detection_enabled, False),
                        clip_recording_enabled=_bool_or(
                            item.clip_recording_enabled, False
                        ),
                        live_matching_enabled=_bool_or(
                            item.live_matching_enabled, False
                        ),
                        camera_code=(item.camera_code or "").strip() or None,
                        zone=item.zone,
                        capture_config=row.capture_config,
                        brand=item.brand,
                    )
                    created_row = repo.get_camera(conn, scope, new_id)
                    assert created_row is not None
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="camera.created",
                        entity_type="camera",
                        entity_id=str(new_id),
                        after=_audit_payload(created_row),
                    )
                created += 1
                created_ids.append(new_id)
                result_rows.append(
                    CameraImportResultRow(
                        index=row.index,
                        action="created",
                        camera_code=created_row.camera_code,
                        name=created_row.name,
                        message="created",
                    )
                )
            except IntegrityError:
                errors += 1
                result_rows.append(
                    CameraImportResultRow(
                        index=row.index,
                        action="error",
                        camera_code=(item.camera_code or "").strip() or None,
                        name=(item.name or "").strip() or None,
                        message="camera_code already exists",
                    )
                )
            except Exception:  # noqa: BLE001
                errors += 1
                logger.warning("camera import: create failed on row %s", row.index)
                result_rows.append(
                    CameraImportResultRow(
                        index=row.index,
                        action="error",
                        camera_code=(item.camera_code or "").strip() or None,
                        name=(item.name or "").strip() or None,
                        message="could not create camera",
                    )
                )
        elif row.action == "update" and row.matched_id is not None:
            try:
                with get_engine().begin() as conn:
                    before = repo.get_camera(conn, scope, row.matched_id)
                    if before is None:
                        raise RuntimeError("camera vanished mid-import")
                    fs = item.model_fields_set
                    values: dict[str, object] = {}
                    if "name" in fs and item.name is not None:
                        values["name"] = item.name.strip()
                    if "location" in fs and item.location is not None:
                        values["location"] = item.location.strip()
                    if "zone" in fs:
                        values["zone"] = item.zone
                    if "worker_enabled" in fs and item.worker_enabled is not None:
                        values["worker_enabled"] = bool(item.worker_enabled)
                    if "display_enabled" in fs and item.display_enabled is not None:
                        values["display_enabled"] = bool(item.display_enabled)
                    if (
                        "detection_enabled" in fs
                        and item.detection_enabled is not None
                    ):
                        values["detection_enabled"] = bool(item.detection_enabled)
                    if (
                        "clip_recording_enabled" in fs
                        and item.clip_recording_enabled is not None
                    ):
                        values["clip_recording_enabled"] = bool(
                            item.clip_recording_enabled
                        )
                    if (
                        "live_matching_enabled" in fs
                        and item.live_matching_enabled is not None
                    ):
                        values["live_matching_enabled"] = bool(
                            item.live_matching_enabled
                        )
                    if row.capture_config is not None:
                        values["capture_config"] = row.capture_config
                    if "brand" in fs:
                        values["brand"] = item.brand
                    if "rtsp_url" in fs and item.rtsp_url is not None:
                        values["rtsp_url_encrypted"] = rtsp_io.encrypt_url(
                            item.rtsp_url.strip()
                        )
                    repo.update_camera(conn, scope, row.matched_id, values=values)
                    after = repo.get_camera(conn, scope, row.matched_id)
                    assert after is not None
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="camera.updated",
                        entity_type="camera",
                        entity_id=str(row.matched_id),
                        before=_audit_payload(before),
                        after=_audit_payload(after),
                    )
                updated += 1
                updated_ids.append(row.matched_id)
                result_rows.append(
                    CameraImportResultRow(
                        index=row.index,
                        action="updated",
                        camera_code=after.camera_code,
                        name=after.name,
                        message="updated",
                    )
                )
            except Exception:  # noqa: BLE001
                errors += 1
                logger.warning("camera import: update failed on row %s", row.index)
                result_rows.append(
                    CameraImportResultRow(
                        index=row.index,
                        action="error",
                        camera_code=(item.camera_code or "").strip() or None,
                        name=(item.name or "").strip() or None,
                        message="could not update camera",
                    )
                )
        elif row.action == "skip":
            skipped += 1
            result_rows.append(
                CameraImportResultRow(
                    index=row.index,
                    action="skipped",
                    camera_code=(item.camera_code or "").strip() or None,
                    name=(item.name or "").strip() or None,
                    message=row.message,
                )
            )
        else:
            errors += 1
            result_rows.append(
                CameraImportResultRow(
                    index=row.index,
                    action="error",
                    camera_code=(item.camera_code or "").strip() or None,
                    name=(item.name or "").strip() or None,
                    message=row.message,
                )
            )

    with get_engine().begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.imported",
            entity_type="camera",
            entity_id=None,
            after={
                "created": created,
                "updated": updated,
                "skipped": skipped,
                "errors": errors,
                "on_existing": payload.on_existing,
            },
        )

    # Hot-reload capture workers for everything we touched (after commit).
    for cid in created_ids:
        capture_manager.on_camera_created(cid, tenant_id=scope.tenant_id)
    for cid in updated_ids:
        capture_manager.on_camera_updated(cid, tenant_id=scope.tenant_id)

    logger.info(
        "cameras imported: tenant=%s created=%s updated=%s skipped=%s errors=%s",
        scope.tenant_id,
        created,
        updated,
        skipped,
        errors,
    )
    return CameraImportResult(
        created=created,
        updated=updated,
        skipped=skipped,
        errors=errors,
        rows=result_rows,
    )


@router.post("/bulk-update", response_model=CameraBulkUpdateResult)
def bulk_update_cameras_endpoint(
    payload: CameraBulkUpdateIn,
    user: Annotated[CurrentUser, ADMIN],
) -> CameraBulkUpdateResult:
    """Flip any of the operational toggles
    (``worker_enabled`` / ``display_enabled`` / ``detection_enabled`` /
    ``clip_recording_enabled`` / ``live_matching_enabled``) across many
    cameras in one call.

    Mirrors the single PATCH mechanics. Unknown / cross-tenant
    ``camera_id`` values fall silently into ``not_found`` — never a 403
    (403 would leak existence; this is the tenant-isolation guard,
    relying on ``repo.get_camera``'s ``WHERE tenant_id`` filter). This
    endpoint touches ONLY the four booleans — it never reads, writes,
    logs, or audits an ``rtsp_url``.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)

    toggle_keys = (
        "worker_enabled",
        "display_enabled",
        "detection_enabled",
        "clip_recording_enabled",
        "live_matching_enabled",
    )
    toggle_values: dict[str, object] = {
        key: provided[key]
        for key in toggle_keys
        if key in provided and provided[key] is not None
    }
    if not toggle_values:
        raise HTTPException(
            status_code=400,
            detail={
                "field": "toggles",
                "message": (
                    "at least one of worker_enabled/display_enabled/"
                    "detection_enabled/clip_recording_enabled/"
                    "live_matching_enabled is required"
                ),
            },
        )

    # De-duplicate while preserving the operator's order.
    seen: set[int] = set()
    ordered_ids: list[int] = []
    for cid in payload.camera_ids:
        if cid not in seen:
            seen.add(cid)
            ordered_ids.append(cid)

    not_found: list[int] = []
    updated_ids: list[int] = []
    updated_rows: list[repo.CameraRow] = []

    with get_engine().begin() as conn:
        for cid in ordered_ids:
            before = repo.get_camera(conn, scope, cid)
            if before is None:
                # Cross-tenant / unknown id — silent not_found, never 403.
                not_found.append(cid)
                continue
            repo.update_camera(conn, scope, cid, values=dict(toggle_values))
            after = repo.get_camera(conn, scope, cid)
            assert after is not None
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="camera.updated",
                entity_type="camera",
                entity_id=str(cid),
                before=_audit_payload(before),
                after={**_audit_payload(after), "bulk_update": True},
            )
            updated_ids.append(cid)
            updated_rows.append(after)

    # Hot-reload capture workers for everything we touched (after commit)
    # so worker / detection toggles take effect immediately.
    for cid in updated_ids:
        capture_manager.on_camera_updated(cid, tenant_id=scope.tenant_id)

    logger.info(
        "cameras bulk-updated: tenant=%s updated=%s not_found=%s",
        scope.tenant_id,
        len(updated_ids),
        len(not_found),
    )
    return CameraBulkUpdateResult(
        updated=len(updated_ids),
        not_found=not_found,
        cameras=[_row_to_out(r) for r in updated_rows],
    )


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

    # BUG-032 / BUG-033 — refuse duplicate RTSP URL (same stream) and
    # the same brand+host combo before we encrypt + persist.
    _check_duplicate_url(scope, payload.rtsp_url, payload.brand)

    encrypted = rtsp_io.encrypt_url(payload.rtsp_url)

    with get_engine().begin() as conn:
        try:
            new_id = repo.create_camera(
                conn,
                scope,
                name=payload.name,
                location=payload.location,
                rtsp_url_encrypted=encrypted,
                worker_enabled=payload.worker_enabled,
                display_enabled=payload.display_enabled,
                detection_enabled=payload.detection_enabled,
                clip_recording_enabled=payload.clip_recording_enabled,
                live_matching_enabled=payload.live_matching_enabled,
                camera_code=payload.camera_code,
                zone=payload.zone,
                capture_config=payload.capture_config.model_dump(),
                brand=payload.brand,
            )
        except IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "camera_code",
                    "message": "camera code already exists",
                },
            ) from exc
        created = repo.get_camera(conn, scope, new_id)
        assert created is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="camera.created",
            entity_type="camera",
            entity_id=str(new_id),
            after=_audit_payload(created),
        )

    logger.info(
        "camera created: id=%s name=%r host=%s", new_id, payload.name, parts.host
    )
    capture_manager.on_camera_created(new_id, tenant_id=scope.tenant_id)
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
        if "camera_code" in provided:
            values["camera_code"] = provided["camera_code"]
        if "zone" in provided:
            values["zone"] = provided["zone"]
        if "worker_enabled" in provided:
            values["worker_enabled"] = provided["worker_enabled"]
        if "display_enabled" in provided:
            values["display_enabled"] = provided["display_enabled"]
        if "detection_enabled" in provided:
            values["detection_enabled"] = provided["detection_enabled"]
        if "clip_recording_enabled" in provided:
            values["clip_recording_enabled"] = provided["clip_recording_enabled"]
        if "live_matching_enabled" in provided:
            values["live_matching_enabled"] = provided["live_matching_enabled"]
        if "capture_config" in provided and provided["capture_config"] is not None:
            # CaptureConfig is a Pydantic model — model_dump() canonicalises
            # the JSONB shape so two writes of equivalent payloads produce
            # the same DB row.
            values["capture_config"] = provided["capture_config"]
        if "brand" in provided:
            values["brand"] = provided["brand"]

        if "rtsp_url" in provided and provided["rtsp_url"] is not None:
            try:
                parts = rtsp_io.parse_rtsp_url(provided["rtsp_url"])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            # BUG-032 / BUG-033 — same dedup check on patch, excluding
            # the row being edited.
            _check_duplicate_url(
                scope,
                provided["rtsp_url"],
                provided.get("brand") or before.brand,
                excluding_id=camera_id,
            )
            values["rtsp_url_encrypted"] = rtsp_io.encrypt_url(
                provided["rtsp_url"]
            )
            new_host = parts.host

        repo.update_camera(conn, scope, camera_id, values=values)
        after = repo.get_camera(conn, scope, camera_id)
        assert after is not None

        # Audit before/after carries the full operational state so any
        # diff (worker toggle, display toggle, knob change, host change)
        # is visible at a glance to an auditor.
        audit_before = _audit_payload(before)
        audit_after = _audit_payload(after)
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
    capture_manager.on_camera_updated(camera_id, tenant_id=scope.tenant_id)
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
            before=_audit_payload(before),
        )
    logger.info("camera deleted: id=%s host=%s", camera_id, before.rtsp_host)
    capture_manager.on_camera_deleted(camera_id, tenant_id=scope.tenant_id)
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
