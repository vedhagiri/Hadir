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
    min_face_quality_to_save: float = Field(default=0.35, ge=0.0, le=1.0)
    save_full_frames: bool = False


class CameraOut(BaseModel):
    id: int
    name: str
    location: str
    rtsp_host: str
    worker_enabled: bool
    display_enabled: bool
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
    # Accepted schemes validated in rtsp.parse_rtsp_url.
    rtsp_url: str = Field(min_length=8, max_length=2048)
    worker_enabled: bool = True
    display_enabled: bool = True
    capture_config: CaptureConfig = Field(default_factory=CaptureConfig)


class CameraPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    location: Optional[str] = Field(default=None, max_length=200)
    # Optional — present value replaces the encrypted token; omitted
    # value leaves the stored credential untouched. The UI's ``***``
    # placeholder on edit is the client half of this contract.
    rtsp_url: Optional[str] = Field(default=None, min_length=8, max_length=2048)
    worker_enabled: Optional[bool] = None
    display_enabled: Optional[bool] = None
    # PATCH expects a complete CaptureConfig when present (UI sends
    # the whole bag). A future API version could accept partial
    # updates by switching to a dedicated CaptureConfigPatch model.
    capture_config: Optional[CaptureConfig] = None
