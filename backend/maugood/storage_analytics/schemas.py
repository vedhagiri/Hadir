"""Pydantic response models for the Storage Analytics API."""

from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field, model_validator


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


# ── Clip cleanup (migration 0069) ──────────────────────────────────────────


class ClipCleanupFilterBody(BaseModel):
    """Request body shared by preview + run endpoints.

    Exactly one of ``older_than_hours``, ``older_than_days``, or the
    ``start_date`` + ``end_date`` pair must be set. Validated server-side
    (the API-layer model validator runs before the deeper repository
    guard, so the operator gets a clean 400 with a precise reason).
    """

    older_than_hours: Optional[int] = Field(default=None, ge=1, le=24 * 365)
    older_than_days: Optional[int] = Field(default=None, ge=1, le=365 * 10)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    camera_id: Optional[int] = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _exactly_one_mode(self) -> "ClipCleanupFilterBody":
        modes = [
            self.older_than_hours is not None,
            self.older_than_days is not None,
            self.start_date is not None or self.end_date is not None,
        ]
        if sum(modes) == 0:
            raise ValueError(
                "exactly one filter mode required: older_than_hours, "
                "older_than_days, or start_date+end_date"
            )
        if sum(modes) > 1:
            raise ValueError("only one filter mode may be set per request")
        if self.start_date is not None and self.end_date is None:
            raise ValueError("range mode requires end_date")
        if self.end_date is not None and self.start_date is None:
            raise ValueError("range mode requires start_date")
        if (
            self.start_date is not None
            and self.end_date is not None
            and self.start_date > self.end_date
        ):
            raise ValueError("start_date must be on or before end_date")
        return self


class CleanupCameraImpact(BaseModel):
    camera_id: int
    camera_name: str
    clip_count: int
    total_bytes: int


class ClipCleanupPreviewResponse(BaseModel):
    clip_count: int
    total_bytes: int
    oldest_clip_at: Optional[str] = None  # ISO 8601 in UTC
    newest_clip_at: Optional[str] = None
    by_camera: list[CleanupCameraImpact]
    capped: bool
    cap: int  # per-call execution cap (clients use this to size progress bars)


class ClipCleanupRunResponse(BaseModel):
    deleted_count: int
    bytes_freed: int
    files_unlinked: int
    files_missing: int
    files_failed: int
    has_more: bool


class ClipRetentionSettingResponse(BaseModel):
    clip_retention_days: Optional[int] = None


class ClipRetentionSettingPatchRequest(BaseModel):
    # NULL = disable automatic sweep. Positive integer enables it.
    clip_retention_days: Optional[int] = Field(default=None, ge=1, le=3650)
