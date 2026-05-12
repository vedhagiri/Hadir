"""Pydantic models for the person_clips API."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class PersonClipOut(BaseModel):
    """Single person clip returned by the API."""

    id: int
    camera_id: int
    camera_name: str = ""
    employee_id: Optional[int] = None
    employee_name: Optional[str] = None
    track_id: Optional[str] = None
    clip_start: datetime
    clip_end: datetime
    duration_seconds: float
    filesize_bytes: int
    frame_count: int
    person_count: int = 0
    matched_employees: list[int] = []
    matched_employee_names: list[str] = []
    matched_status: str = "pending"
    created_at: datetime


class PersonClipListResponse(BaseModel):
    items: list[PersonClipOut]
    total: int
    page: int
    page_size: int


class PersonClipStats(BaseModel):
    total_clips: int
    total_size_bytes: int
    per_camera: list[dict]


class BulkDeleteClipRequest(BaseModel):
    clip_ids: list[int] = Field(..., min_length=1, max_length=200)


class BulkDeleteClipResponse(BaseModel):
    deleted_count: int
    deleted_ids: list[int]


class ReprocessFaceMatchRequest(BaseModel):
    mode: str = "all"


class ReprocessFaceMatchResponse(BaseModel):
    started: bool
    message: str = ""


class ReprocessFaceMatchStatus(BaseModel):
    status: str = "idle"
    mode: str = "all"
    total_clips: int = 0
    processed_clips: int = 0
    matched_total: int = 0
    failed_count: int = 0
    errors: list[str] = []
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
