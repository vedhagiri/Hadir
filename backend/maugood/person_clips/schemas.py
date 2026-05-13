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
    person_start: Optional[datetime] = None
    person_end: Optional[datetime] = None
    face_matching_duration_ms: Optional[int] = None
    face_matching_progress: int = 0
    # Pipeline metadata (migration 0048+)
    encoding_start_at: Optional[datetime] = None
    encoding_end_at: Optional[datetime] = None
    fps_recorded: Optional[float] = None
    resolution_w: Optional[int] = None
    resolution_h: Optional[int] = None
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
    # Pipeline summary counts
    pending_match: int = 0
    processing_match: int = 0
    completed_match: int = 0
    failed_match: int = 0


class BulkDeleteClipRequest(BaseModel):
    clip_ids: list[int] = Field(..., min_length=1, max_length=200)


class BulkDeleteClipResponse(BaseModel):
    deleted_count: int
    deleted_ids: list[int]


class ReprocessFaceMatchRequest(BaseModel):
    mode: str = "all"
    use_cases: list[str] = Field(default_factory=lambda: ["uc3"])


class ReprocessFaceMatchResponse(BaseModel):
    started: bool
    message: str = ""


class ReprocessFaceMatchStatus(BaseModel):
    status: str = "idle"
    mode: str = "all"
    use_cases: list[str] = Field(default_factory=lambda: ["uc3"])
    total_clips: int = 0
    processed_clips: int = 0
    matched_total: int = 0
    failed_count: int = 0
    errors: list[str] = []
    started_at: Optional[str] = None
    ended_at: Optional[str] = None


# --- Per-UC processing results ---


class ClipProcessingResult(BaseModel):
    """One row from clip_processing_results for a single use case."""

    id: int
    person_clip_id: int
    use_case: str
    status: str
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    duration_ms: Optional[int] = None
    face_extract_duration_ms: Optional[int] = None
    match_duration_ms: Optional[int] = None
    face_crop_count: int = 0
    matched_employees: list[int] = []
    matched_employee_names: list[str] = []
    unknown_count: int = 0
    match_details: Optional[list[dict]] = None
    error: Optional[str] = None
    created_at: datetime


class ClipProcessingResultsResponse(BaseModel):
    clip_id: int
    results: list[ClipProcessingResult]


# --- System stats ---


class WorkerStatus(BaseModel):
    camera_id: int
    camera_name: str
    tenant_id: int
    is_alive: bool
    queue_size: int


class ClipQueueStats(BaseModel):
    total_workers: int
    alive_workers: int
    total_queue_depth: int
    workers: list[WorkerStatus]


class SystemResourceStats(BaseModel):
    cpu_percent_per_core: list[float]
    cpu_percent_total: float
    memory_total_mb: float
    memory_used_mb: float
    memory_percent: float
    gpu_available: bool
    gpu_percent: Optional[float] = None
    gpu_memory_used_mb: Optional[float] = None
    gpu_memory_total_mb: Optional[float] = None


class StorageStats(BaseModel):
    clips_root: str
    total_gb: float
    used_gb: float
    free_gb: float
    clip_files_count: int
    clip_files_total_mb: float


class PipelineStats(BaseModel):
    """Aggregate processing statistics across all clips for the tenant."""
    total_clips: int
    clips_pending: int
    clips_processing: int
    clips_completed: int
    clips_failed: int
    # Per-use-case aggregates
    uc1_completed: int = 0
    uc2_completed: int = 0
    uc3_completed: int = 0
    avg_uc1_duration_ms: Optional[float] = None
    avg_uc2_duration_ms: Optional[float] = None
    avg_uc3_duration_ms: Optional[float] = None


class SystemStatsResponse(BaseModel):
    resources: SystemResourceStats
    storage: StorageStats
    clip_queue: ClipQueueStats
    pipeline: PipelineStats
    reprocess_status: ReprocessFaceMatchStatus


# --- Single-clip reprocess ---


class SingleClipReprocessRequest(BaseModel):
    use_cases: list[str] = Field(default_factory=lambda: ["uc3"])


class SingleClipReprocessResponse(BaseModel):
    started: bool
    running: bool = False
    message: str = ""


# --- Face crops ---


class FaceCropOut(BaseModel):
    """One row from face_crops for a single detected face."""

    id: int
    person_clip_id: int
    camera_id: int
    use_case: Optional[str] = None
    # Migration 0051 — None means the face was not matched to any employee.
    employee_id: Optional[int] = None
    employee_name: Optional[str] = None
    event_timestamp: str
    face_index: int
    quality_score: float
    detection_score: float
    width: int
    height: int
    created_at: datetime


class FaceCropListResponse(BaseModel):
    clip_id: int
    use_case_filter: Optional[str] = None
    items: list[FaceCropOut]
    total: int
