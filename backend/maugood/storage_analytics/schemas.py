"""Pydantic response models for the Storage Analytics API."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class CameraStorageRow(BaseModel):
    camera_id: int
    camera_name: str
    clip_count: int
    total_bytes: int
    matched_crops: int
    unmatched_crops: int
    avg_clip_duration_sec: Optional[float] = None


class DailyStorageRow(BaseModel):
    date: str  # YYYY-MM-DD
    clip_count: int
    total_bytes: int
    new_crops: int
    matched_crops: int


class StorageOverview(BaseModel):
    total_clips: int
    total_bytes: int
    total_face_crops: int
    matched_face_crops: int
    unmatched_face_crops: int
    pending_clips: int
    processing_clips: int
    completed_clips: int
    failed_clips: int
    recording_clips: int
    avg_clip_duration_sec: Optional[float] = None


class StorageAnalyticsResponse(BaseModel):
    overview: StorageOverview
    by_camera: list[CameraStorageRow]
    daily: list[DailyStorageRow]
    days_window: int
    camera_id_filter: Optional[int] = None
