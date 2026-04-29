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
from typing import Optional

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
    worker_enabled: bool = True
    display_enabled: bool = True
    detection_enabled: bool = True
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
    # PATCH expects a complete CaptureConfig when present (UI sends
    # the whole bag). A future API version could accept partial
    # updates by switching to a dedicated CaptureConfigPatch model.
    capture_config: Optional[CaptureConfig] = None
    brand: Optional[str] = Field(default=None, max_length=64)
