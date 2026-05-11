"""Pydantic models for the face_crops API."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class FaceCropOut(BaseModel):
    """Single face crop returned by the API."""

    id: int
    camera_id: int
    camera_name: str = ""
    person_clip_id: int
    event_timestamp: str
    face_index: int
    quality_score: float
    width: int
    height: int
    created_at: datetime


class FaceCropListResponse(BaseModel):
    items: list[FaceCropOut]
    total: int
    page: int
    page_size: int


class FaceCropStats(BaseModel):
    total_crops: int
    per_camera: list[dict]


class ClipsProcessingStatus(BaseModel):
    pending: int = 0
    processing: int = 0
    processed: int = 0
    failed: int = 0
    total: int = 0
    is_processing: bool = False


class ProcessResult(BaseModel):
    total: int = 0
    processed: int = 0
    failed: int = 0
    saved_crops: int = 0
    error: Optional[str] = None


class FaceCropInGroup(BaseModel):
    """A single face crop within a clip group."""

    id: int
    face_index: int
    quality_score: float
    width: int
    height: int
    created_at: datetime


class ClipGroup(BaseModel):
    """One clip with its extracted face crops."""

    person_clip_id: int
    camera_id: int
    camera_name: str = ""
    clip_start: Optional[str] = None
    clip_end: Optional[str] = None
    duration_seconds: float = 0
    track_count: int = 0
    crops: list[FaceCropInGroup] = []


class FaceCropsByClipResponse(BaseModel):
    groups: list[ClipGroup]
    total_groups: int
    total_crops: int
