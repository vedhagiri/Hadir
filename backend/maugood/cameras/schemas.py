"""Pydantic schemas for the cameras API.

``rtsp_url`` only ever travels inbound (create/update). Outbound
responses expose ``rtsp_host`` — the parsed host/port — and nothing
else credential-adjacent.

P28.5b: ``enabled`` was split into ``worker_enabled`` (capture pipeline
on/off) + ``display_enabled`` (Live Capture surfacing on/off), and
``capture_config`` (per-camera knob bag) added.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class CaptureConfig(BaseModel):
    """Per-camera capture knobs. Bounds match the P28.5b validation
    UI: max_faces 1-50, duration 5-600s, quality 0.0-1.0 (step 0.05),
    full-frame save toggle. Defaults from prototype-reference."""

    model_config = ConfigDict(extra="forbid")

    max_faces_per_event: int = Field(default=10, ge=1, le=50)
    max_event_duration_sec: int = Field(default=60, ge=5, le=600)
    # Deprecated (post-fix-detector-mode-preflight): runtime no-op.
    # Kept on the schema so existing JSON validates; pose-aware quality
    # ranking is reserved for v1.x. See docs/phases/
    # fix-detector-mode-preflight.md Layer 2.
    min_face_quality_to_save: float = Field(default=0.0, ge=0.0, le=1.0)
    save_full_frames: bool = False


class CameraOut(BaseModel):
    id: int
    # Migration 0034 — running human-readable code (CAM-001 etc.).
    # Auto-assigned on create; uniquely scoped per tenant. Operator
    # can rename later via PATCH.
    camera_code: str
    name: str
    location: str
    # Migration 0034 — zone tag (Entry / Exit / Lobby / Parking /
    # Office / Outdoor / Other). Free text for forward compat.
    zone: Optional[str] = None
    rtsp_host: str
    worker_enabled: bool
    display_enabled: bool
    # Migration 0033 — when False the worker keeps reading frames but
    # the analyzer skips ``detect`` and no detection_events are
    # written. Default True (current behaviour). See
    # docs/phases/cameras-detection-toggle.md.
    detection_enabled: bool
    # Migration 0049 — when False the capture pipeline keeps running
    # (detection, tracking, events) but no video clip is written to
    # disk and no person_clips row is inserted.
    clip_recording_enabled: bool = True
    # Migration 0072 — per-camera live face-recognition/matching gate.
    # The analyzer runs full recognition only when
    # ``detection_enabled AND live_matching_enabled``.
    live_matching_enabled: bool = False
    # Migration 0052 — which detector drives the clip-recording
    # trigger. 'face' (default, pre-migration behaviour), 'body'
    # (YOLO person count drives it — Option 2 surface), 'both' (OR).
    clip_detection_source: str = "face"
    capture_config: CaptureConfig
    created_at: datetime
    last_seen_at: Optional[datetime] = None
    images_captured_24h: int
    # P28.8 — auto-detected (worker writes) + manual (Admin writes).
    detected_resolution_w: Optional[int] = None
    detected_resolution_h: Optional[int] = None
    detected_fps: Optional[float] = None
    detected_codec: Optional[str] = None
    detected_at: Optional[datetime] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    mount_location: Optional[str] = None


class CameraListOut(BaseModel):
    items: list[CameraOut]


class CameraBulkUpdateIn(BaseModel):
    """Body for ``POST /api/cameras/bulk-update``. Drives the Cameras
    page "Bulk Actions" feature — flip any of the four operational
    toggles across many cameras in one call.

    Every toggle is optional + nullable; only the keys the operator
    actually sends (and that aren't ``None``) are applied. At least one
    toggle must resolve to a value — the router rejects an all-``None``
    body with 400. This endpoint deliberately touches ONLY the four
    booleans; it never accepts or audits an ``rtsp_url``.
    """

    camera_ids: list[int] = Field(min_length=1)
    worker_enabled: Optional[bool] = None
    display_enabled: Optional[bool] = None
    detection_enabled: Optional[bool] = None
    clip_recording_enabled: Optional[bool] = None
    # Migration 0072 — per-camera live-matching toggle, bulk variant.
    live_matching_enabled: Optional[bool] = None


class CameraBulkUpdateResult(BaseModel):
    """Response for the bulk-update endpoint. ``cameras`` carries the
    updated rows (so the frontend can refresh in place); ``not_found``
    lists the requested ids that didn't resolve in this tenant — the
    tenant-isolation + unknown-id path (never a 403)."""

    updated: int
    not_found: list[int]
    cameras: list[CameraOut]


class CameraCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=200)
    # Optional zone tag. The form offers a curated list (Entry / Exit
    # / Lobby / Parking / Office / Outdoor / Other) but the schema
    # accepts any string ≤ 32 chars so future tenants can extend.
    zone: Optional[str] = Field(default=None, max_length=32)
    # Optional — when omitted the backend auto-generates the next
    # sequential CAM-{N:03d}. Operator can override on add (e.g.
    # match an external numbering scheme).
    camera_code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    # Accepted schemes validated in rtsp.parse_rtsp_url.
    rtsp_url: str = Field(min_length=8, max_length=2048)
    # Defaults flipped to False so a freshly-added camera does nothing
    # until the operator explicitly turns on what they want. The DB
    # column server_defaults stay True for backwards compat with any
    # out-of-band INSERT — the API path is the only writer that
    # honours these.
    worker_enabled: bool = False
    display_enabled: bool = False
    detection_enabled: bool = False
    clip_recording_enabled: bool = False
    # Migration 0072 — per-camera live-matching gate. Default False so a
    # freshly-added camera does nothing until the operator turns it on.
    live_matching_enabled: bool = False
    # Migration 0052 / 0053 — 'face' | 'body' | 'both'. Default
    # bumped from 'face' to 'body' in migration 0053: a stationary
    # seated employee whose face is hidden (looking down at a desk,
    # back-to-camera) still keeps the clip alive because YOLO body
    # detection finds them regardless of motion.
    clip_detection_source: str = Field(default="body", pattern=r"^(face|body|both)$")
    capture_config: CaptureConfig = Field(default_factory=CaptureConfig)
    # Optional brand tag. The frontend offers a curated dropdown
    # (Samsung, Hikvision, Dahua, CP Plus, Axis, Panasonic, Others)
    # used purely to render a brand-coloured chip next to the camera
    # name; the schema stays free-form so future brands can be added
    # without a migration.
    brand: Optional[str] = Field(default=None, max_length=64)


class CameraPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    location: Optional[str] = Field(default=None, max_length=200)
    zone: Optional[str] = Field(default=None, max_length=32)
    camera_code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    # Optional — present value replaces the encrypted token; omitted
    # value leaves the stored credential untouched. The UI's ``***``
    # placeholder on edit is the client half of this contract.
    rtsp_url: Optional[str] = Field(default=None, min_length=8, max_length=2048)
    worker_enabled: Optional[bool] = None
    display_enabled: Optional[bool] = None
    detection_enabled: Optional[bool] = None
    clip_recording_enabled: Optional[bool] = None
    # Migration 0072 — per-camera live-matching gate.
    live_matching_enabled: Optional[bool] = None
    clip_detection_source: Optional[str] = Field(
        default=None, pattern=r"^(face|body|both)$"
    )
    # PATCH expects a complete CaptureConfig when present (UI sends
    # the whole bag). A future API version could accept partial
    # updates by switching to a dedicated CaptureConfigPatch model.
    capture_config: Optional[CaptureConfig] = None
    brand: Optional[str] = Field(default=None, max_length=64)


# --- Import / export (bulk JSON transfer) ----------------------------------
#
# The export carries the operator's choice from the AskUserQuestion: the
# FULL plaintext ``rtsp_url`` (credentials included) so a round-trip
# import recreates cameras with no re-entry. The downloadable file is the
# only place the plaintext travels — audit rows + server logs still carry
# ``rtsp_host`` at most (see the cameras router red line). Treat the
# export file as a secret.


class CameraExportItem(BaseModel):
    """One camera's configuration in an export file. Mirrors the
    create/patch API surface; runtime + auto-detected state
    (``detected_*``, ``last_seen_at``, ``images_captured_24h``) is
    deliberately omitted — the export is configuration, not telemetry."""

    camera_code: str
    name: str
    location: str
    zone: Optional[str] = None
    rtsp_url: str  # PLAINTEXT — see module note above.
    worker_enabled: bool
    display_enabled: bool
    detection_enabled: bool
    clip_recording_enabled: bool
    # Migration 0072 — per-camera live-matching gate.
    live_matching_enabled: bool = False
    clip_detection_source: str
    capture_config: CaptureConfig
    brand: Optional[str] = None


class CameraExportFile(BaseModel):
    """Top-level export payload. ``version`` lets a future import reject
    or migrate an incompatible shape."""

    version: int
    exported_at: datetime
    tenant_slug: Optional[str] = None
    count: int
    cameras: list[CameraExportItem]


class CameraImportItem(BaseModel):
    """One camera row from an uploaded file. Every field is optional and
    loosely typed so a single malformed row produces a per-row error in
    the preview rather than a request-level 422. Extra keys from a
    round-tripped export (``detected_*`` etc.) are ignored."""

    model_config = ConfigDict(extra="ignore")

    camera_code: Optional[str] = None
    name: Optional[str] = None
    location: Optional[str] = None
    zone: Optional[str] = None
    rtsp_url: Optional[str] = None
    worker_enabled: Optional[bool] = None
    display_enabled: Optional[bool] = None
    detection_enabled: Optional[bool] = None
    clip_recording_enabled: Optional[bool] = None
    # Migration 0072 — per-camera live-matching gate.
    live_matching_enabled: Optional[bool] = None
    clip_detection_source: Optional[str] = None
    capture_config: Optional[dict] = None
    brand: Optional[str] = None


class CameraImportRequest(BaseModel):
    """Body for both preview + commit. ``on_existing`` selects how a row
    that matches an existing camera (by ``camera_code``) is treated —
    ``update`` rewrites it, ``skip`` leaves it untouched. New cameras are
    always created; rows whose RTSP stream duplicates an existing camera
    are always skipped."""

    model_config = ConfigDict(extra="ignore")

    cameras: list[CameraImportItem] = Field(default_factory=list)
    on_existing: Literal["update", "skip"] = "update"


CameraImportAction = Literal["create", "update", "skip", "error"]


class CameraImportPreviewRow(BaseModel):
    index: int  # 1-based position in the uploaded file
    action: CameraImportAction
    camera_code: Optional[str] = None
    name: Optional[str] = None
    rtsp_host: Optional[str] = None  # credentials stripped, for display
    matched_camera_id: Optional[int] = None
    message: str


class CameraImportSummary(BaseModel):
    create: int = 0
    update: int = 0
    skip: int = 0
    error: int = 0


class CameraImportPreview(BaseModel):
    summary: CameraImportSummary
    rows: list[CameraImportPreviewRow]


CameraImportResultAction = Literal["created", "updated", "skipped", "error"]


class CameraImportResultRow(BaseModel):
    index: int
    action: CameraImportResultAction
    camera_code: Optional[str] = None
    name: Optional[str] = None
    message: str


class CameraImportResult(BaseModel):
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    rows: list[CameraImportResultRow]
