"""Bulk JSON import/export for cameras — pure logic, no DB, no IO.

``build_export_payload`` turns a list of ``CameraRow`` (plus an injected
decrypt function) into a ``CameraExportFile``. The export carries the
PLAINTEXT ``rtsp_url`` per the operator's explicit choice — the
downloadable file is the only place credentials travel; the router's
audit rows + logs still carry ``rtsp_host`` at most.

``classify_imports`` is the heart of the preview: given the tenant's
existing cameras (pre-decrypted to canonical stream ids) and the
uploaded rows, it decides per row whether it will create, update, skip
(duplicate) or error — and validates every field so a single bad row
surfaces as a per-row message instead of a request-level 422. Keeping it
pure means the whole decision matrix is unit-testable without a database.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from pydantic import ValidationError

from maugood.cameras.rtsp import canonical_stream_id, parse_rtsp_url
from maugood.cameras.schemas import (
    CameraExportFile,
    CameraExportItem,
    CameraImportItem,
    CaptureConfig,
)

EXPORT_SCHEMA_VERSION = 1


def build_export_payload(
    rows,
    *,
    decrypt_url: Callable[[str], str],
    tenant_slug: Optional[str],
    exported_at: datetime,
) -> CameraExportFile:
    """Build the export file. ``rows`` is an iterable of ``CameraRow``.

    A row whose stored URL can't be decrypted is skipped (it would be
    useless on re-import anyway); ``count`` reflects what's actually
    included.
    """

    items: list[CameraExportItem] = []
    for row in rows:
        try:
            plain_url = decrypt_url(row.rtsp_url_encrypted)
        except Exception:  # noqa: BLE001 — skip undecryptable rows
            continue
        items.append(
            CameraExportItem(
                camera_code=row.camera_code,
                name=row.name,
                location=row.location,
                zone=row.zone,
                rtsp_url=plain_url,
                worker_enabled=row.worker_enabled,
                display_enabled=row.display_enabled,
                detection_enabled=row.detection_enabled,
                clip_recording_enabled=row.clip_recording_enabled,
                live_matching_enabled=row.live_matching_enabled,
                capture_config=CaptureConfig.model_validate(row.capture_config),
                brand=row.brand,
            )
        )
    return CameraExportFile(
        version=EXPORT_SCHEMA_VERSION,
        exported_at=exported_at,
        tenant_slug=tenant_slug,
        count=len(items),
        cameras=items,
    )


@dataclass(frozen=True, slots=True)
class ExistingCamera:
    """The slice of an existing camera the classifier needs. ``canon`` is
    ``None`` when the stored URL couldn't be decrypted."""

    id: int
    name: str
    camera_code: str
    canon: Optional[str]


@dataclass(frozen=True, slots=True)
class ClassifiedRow:
    """Per-row verdict + the normalised data the apply step needs so it
    never re-parses or re-validates."""

    index: int  # 1-based position in the uploaded file
    action: str  # create | update | skip | error
    item: CameraImportItem
    matched_id: Optional[int]
    rtsp_host: Optional[str]
    message: str
    capture_config: Optional[dict]  # validated + canonicalised, for apply


def _norm(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    return v or None


def classify_imports(
    existing: list[ExistingCamera],
    items: list[CameraImportItem],
    *,
    mode: str,
) -> list[ClassifiedRow]:
    """Classify each uploaded row. ``mode`` is ``"update"`` or ``"skip"``
    and only governs rows that match an existing camera by
    ``camera_code``."""

    by_code: dict[str, ExistingCamera] = {}
    by_canon: dict[str, ExistingCamera] = {}
    for cam in existing:
        if cam.camera_code:
            by_code.setdefault(cam.camera_code, cam)
        if cam.canon:
            by_canon.setdefault(cam.canon, cam)

    # Within-file dedup: a code/stream already claimed by an earlier row
    # that will create or update.
    seen_codes: set[str] = set()
    seen_canons: set[str] = set()

    out: list[ClassifiedRow] = []
    for i, item in enumerate(items, start=1):
        code = _norm(item.camera_code)
        name = _norm(item.name)
        raw_url = _norm(item.rtsp_url)

        # --- field parsing / validation -------------------------------
        host: Optional[str] = None
        canon: Optional[str] = None
        url_error: Optional[str] = None
        if raw_url:
            try:
                host = parse_rtsp_url(raw_url).host
                canon = canonical_stream_id(raw_url)
            except ValueError as exc:
                url_error = str(exc)

        cap_dict: Optional[dict] = None
        field_error: Optional[str] = None
        if (
            "capture_config" in item.model_fields_set
            and item.capture_config is not None
        ):
            try:
                cap_dict = CaptureConfig.model_validate(
                    item.capture_config
                ).model_dump()
            except ValidationError:
                field_error = "invalid capture_config"

        matched = by_code.get(code) if code else None
        stream_owner = by_canon.get(canon) if canon else None

        # --- decision matrix: set action / message / matched_id ------
        action: str
        message: str
        matched_id: Optional[int] = None

        if matched is not None:
            # Update path (row matched an existing camera by code).
            if raw_url and url_error is not None:
                action, message = "error", f"invalid rtsp_url: {url_error}"
            elif field_error is not None:
                action, message = "error", field_error
            elif stream_owner is not None and stream_owner.id != matched.id:
                action = "error"
                message = f"RTSP stream already used by '{stream_owner.name}'"
            elif code in seen_codes:
                action, message = "skip", "duplicate camera_code within file"
            elif mode == "skip":
                seen_codes.add(code)  # type: ignore[arg-type]
                action = "skip"
                message = f"camera '{code}' already exists (skipped)"
            else:
                seen_codes.add(code)  # type: ignore[arg-type]
                if canon:
                    seen_canons.add(canon)
                action, message, matched_id = (
                    "update",
                    "will update existing camera",
                    matched.id,
                )
        # No code match → create, or skip because the stream already exists.
        elif stream_owner is not None:
            action = "skip"
            message = f"RTSP stream already exists as '{stream_owner.name}'"
        elif name is None:
            action, message = "error", "name is required to create a camera"
        elif raw_url is None:
            action, message = "error", "rtsp_url is required to create a camera"
        elif url_error is not None:
            action, message = "error", f"invalid rtsp_url: {url_error}"
        elif field_error is not None:
            action, message = "error", field_error
        elif code is not None and code in seen_codes:
            action, message = "skip", "duplicate camera_code within file"
        elif canon is not None and canon in seen_canons:
            action, message = "skip", "duplicate RTSP stream within file"
        else:
            if code is not None:
                seen_codes.add(code)
            if canon is not None:
                seen_canons.add(canon)
            action, message = "create", "will create new camera"

        out.append(
            ClassifiedRow(
                index=i,
                action=action,
                item=item,
                matched_id=matched_id,
                rtsp_host=host,
                message=message,
                capture_config=cap_dict,
            )
        )

    return out
