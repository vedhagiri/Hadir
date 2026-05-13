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
    # Migration 0052 — which detector triggered the clip.
    # 'face' (default, pre-0052), 'body', or 'both'.
    detection_source: str = "face"
    # Number of intermediate chunks merged into the final file
    # (Phase B). Phase A always emits 1.
    chunk_count: int = 1
    # Migration 0054 — recording lifecycle status. 'recording' means
    # the clip is in progress; the frontend renders a 🔴 LIVE badge
    # and offers MJPEG live preview. Completed clips play the MP4.
    recording_status: str = "completed"
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


class TopProcessInfo(BaseModel):
    pid: int
    name: str
    cpu_percent: float
    memory_mb: float


class SystemResourceStats(BaseModel):
    # ── CPU ────────────────────────────────────────────────────────────
    cpu_percent_per_core: list[float]
    cpu_percent_total: float
    cpu_count_logical: int = 0
    cpu_count_physical: int = 0
    cpu_freq_current_mhz: Optional[float] = None
    cpu_freq_max_mhz: Optional[float] = None
    load_avg_1m: Optional[float] = None
    load_avg_5m: Optional[float] = None
    load_avg_15m: Optional[float] = None

    # ── Memory ─────────────────────────────────────────────────────────
    memory_total_mb: float
    memory_used_mb: float
    memory_available_mb: float = 0.0
    memory_percent: float
    swap_total_mb: float = 0.0
    swap_used_mb: float = 0.0
    swap_percent: float = 0.0

    # ── GPU (unchanged) ────────────────────────────────────────────────
    gpu_available: bool
    gpu_percent: Optional[float] = None
    gpu_memory_used_mb: Optional[float] = None
    gpu_memory_total_mb: Optional[float] = None

    # ── Disk I/O (rates over the sample window) ────────────────────────
    disk_read_mb_per_s: float = 0.0
    disk_write_mb_per_s: float = 0.0
    disk_read_total_mb: float = 0.0
    disk_write_total_mb: float = 0.0

    # ── Network I/O ────────────────────────────────────────────────────
    net_sent_mb_per_s: float = 0.0
    net_recv_mb_per_s: float = 0.0
    net_sent_total_mb: float = 0.0
    net_recv_total_mb: float = 0.0

    # ── Host info ──────────────────────────────────────────────────────
    hostname: str = ""
    platform: str = ""
    boot_time_iso: str = ""
    uptime_seconds: float = 0.0
    process_count: int = 0

    # ── Backend process (this Maugood backend) ─────────────────────────
    backend_pid: int = 0
    backend_cpu_percent: float = 0.0
    backend_memory_mb: float = 0.0
    backend_thread_count: int = 0
    backend_open_files: int = 0

    # ── Top processes (descending CPU then memory) ─────────────────────
    top_cpu_processes: list[TopProcessInfo] = []
    top_memory_processes: list[TopProcessInfo] = []

    # ── Detector lock contention ───────────────────────────────────────
    # 0-100% of the last 60 s the InsightFace/YOLO module lock has been
    # held. >80% means a single detector worker is the bottleneck.
    detector_lock_contention_pct: float = 0.0


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

    # Face-matching pipeline (person_clips.matched_status)
    clips_pending: int
    clips_processing: int
    clips_completed: int
    clips_failed: int

    # Recording lifecycle (person_clips.recording_status). These let
    # the Processing Lifecycle UI render a true two-stage funnel:
    # camera → encoded MP4 (the recording stage) then matched_status
    # advances independently.
    recording_active: int = 0       # status='recording'
    recording_encoding: int = 0     # status='finalizing'
    recording_completed: int = 0    # status='completed'
    recording_failed: int = 0       # status='failed'
    recording_abandoned: int = 0    # status='abandoned' (sweeper)

    # Per-use-case aggregates
    uc1_completed: int = 0
    uc2_completed: int = 0
    uc3_completed: int = 0
    avg_uc1_duration_ms: Optional[float] = None
    avg_uc2_duration_ms: Optional[float] = None
    avg_uc3_duration_ms: Optional[float] = None

    # Throughput / activity — UTC-day windowed where applicable
    clips_today: int = 0            # person_clips.created_at >= today-UTC
    matched_today: int = 0          # matched_status='processed' AND today
    avg_clip_duration_seconds: Optional[float] = None
    total_storage_bytes: int = 0    # sum of person_clips.filesize_bytes


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


# ── UC Comparison ────────────────────────────────────────────────────────────


class UseCaseStats(BaseModel):
    """Per-UC aggregate stats consumed by the Comparison tab."""

    use_case: str                       # "uc1" | "uc2" | "uc3"
    label: str                          # "Use Case 1"
    mode: str                           # human-readable detector mode
    has_data: bool                      # any rows at all for this UC?

    # From clip_processing_results
    completed_runs: int
    failed_runs: int
    distinct_clips: int
    avg_total_ms: Optional[float] = None
    avg_extract_ms: Optional[float] = None
    avg_match_ms: Optional[float] = None
    total_faces_detected: int           # sum face_crop_count + unknown_count
    total_crops_saved: int
    total_unknown_count: int

    # From face_crops
    face_crop_row_count: int
    matched_crop_count: int
    avg_quality_score: Optional[float] = None
    avg_detection_score: Optional[float] = None

    # From match_details aggregation
    avg_match_confidence: Optional[float] = None

    # Derived
    match_rate: Optional[float] = None  # matched_crop_count / face_crop_row_count
    storage_bytes: int = 0              # sum of stat'd JPEG file sizes


class UseCaseComparisonResponse(BaseModel):
    """Side-by-side comparison + at-a-glance winners."""

    use_cases: list[UseCaseStats]
    # IDs of the winning UC per category, or None if no data.
    fastest: Optional[str] = None
    best_quality: Optional[str] = None
    most_accurate: Optional[str] = None
    most_used: Optional[str] = None
    # Free-text recommendations (server-side rules — easier than
    # encoding rules into the frontend).
    recommendations: list[str] = []
