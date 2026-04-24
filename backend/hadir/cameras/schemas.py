"""Pydantic schemas for the cameras API.

``rtsp_url`` only ever travels inbound (create/update). Outbound
responses expose ``rtsp_host`` — the parsed host/port — and nothing
else credential-adjacent.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class CameraOut(BaseModel):
    id: int
    name: str
    location: str
    rtsp_host: str
    enabled: bool
    created_at: datetime
    last_seen_at: Optional[datetime] = None
    images_captured_24h: int


class CameraListOut(BaseModel):
    items: list[CameraOut]


class CameraCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=200)
    # Accepted schemes validated in rtsp.parse_rtsp_url.
    rtsp_url: str = Field(min_length=8, max_length=2048)
    enabled: bool = True


class CameraPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    location: Optional[str] = Field(default=None, max_length=200)
    # Optional — present value replaces the encrypted token; omitted
    # value leaves the stored credential untouched. The UI's ``***``
    # placeholder on edit is the client half of this contract.
    rtsp_url: Optional[str] = Field(default=None, min_length=8, max_length=2048)
    enabled: Optional[bool] = None
