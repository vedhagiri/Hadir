"""Pydantic schemas for the email-config + scheduled-report endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from croniter import croniter
from pydantic import BaseModel, EmailStr, Field, model_validator


# ---------------------------------------------------------------------------
# Email config
# ---------------------------------------------------------------------------


class EmailConfigResponse(BaseModel):
    """Wire shape for ``GET /api/email-config``.

    Secrets are NEVER returned — we surface a boolean flag per
    secret so the UI can show "*** stored" without leaking the
    ciphertext. Operator types a fresh secret to rotate.
    """

    tenant_id: int
    provider: Literal["smtp", "microsoft_graph"]
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_use_tls: bool
    has_smtp_password: bool
    graph_tenant_id: str
    graph_client_id: str
    has_graph_client_secret: bool
    from_address: str
    from_name: str
    enabled: bool
    updated_at: str


class EmailConfigUpdateRequest(BaseModel):
    provider: Optional[Literal["smtp", "microsoft_graph"]] = None
    smtp_host: Optional[str] = Field(default=None, max_length=200)
    smtp_port: Optional[int] = Field(default=None, ge=1, le=65535)
    smtp_username: Optional[str] = Field(default=None, max_length=200)
    # Empty string = leave existing password alone (write-only field).
    # Caller passes a fresh value to rotate; passes None / omits the
    # key to leave it as-is.
    smtp_password: Optional[str] = Field(default=None, max_length=2000)
    smtp_use_tls: Optional[bool] = None
    graph_tenant_id: Optional[str] = Field(default=None, max_length=200)
    graph_client_id: Optional[str] = Field(default=None, max_length=200)
    graph_client_secret: Optional[str] = Field(default=None, max_length=2000)
    from_address: Optional[EmailStr] = None
    from_name: Optional[str] = Field(default=None, max_length=200)
    enabled: Optional[bool] = None


class TestEmailRequest(BaseModel):
    to: EmailStr


# ---------------------------------------------------------------------------
# Schedules
# ---------------------------------------------------------------------------


def _validate_cron(expr: str) -> None:
    """Raise ValueError if the cron expression doesn't parse."""

    try:
        croniter(expr)
    except (ValueError, KeyError) as exc:
        raise ValueError(f"invalid cron expression: {exc}") from exc


class ReportFilterConfig(BaseModel):
    """Subset of attendance-report filters the schedule persists.

    ``window_days`` is computed at run time as ``end = today``,
    ``start = today - days``. If a future schedule needs absolute
    dates we'd extend this; the pilot's "send the last 7 days every
    Monday morning" UX wants relative.
    """

    window_days: int = Field(default=7, ge=1, le=180)
    department_id: Optional[int] = Field(default=None, ge=1)
    employee_id: Optional[int] = Field(default=None, ge=1)


class ReportScheduleResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    report_type: Literal["attendance"]
    format: Literal["xlsx", "pdf"]
    filter_config: ReportFilterConfig
    recipients: list[EmailStr]
    schedule_cron: str
    active: bool
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    next_run_at: Optional[datetime] = None
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class ReportScheduleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    report_type: Literal["attendance"] = "attendance"
    format: Literal["xlsx", "pdf"]
    filter_config: ReportFilterConfig = Field(default_factory=ReportFilterConfig)
    recipients: list[EmailStr] = Field(min_length=1, max_length=50)
    schedule_cron: str = Field(min_length=1, max_length=200)
    active: bool = True

    @model_validator(mode="after")
    def _check_cron(self) -> "ReportScheduleCreateRequest":
        _validate_cron(self.schedule_cron)
        return self


class ReportSchedulePatchRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    format: Optional[Literal["xlsx", "pdf"]] = None
    filter_config: Optional[ReportFilterConfig] = None
    recipients: Optional[list[EmailStr]] = Field(
        default=None, min_length=1, max_length=50
    )
    schedule_cron: Optional[str] = Field(default=None, min_length=1, max_length=200)
    active: Optional[bool] = None

    @model_validator(mode="after")
    def _check(self) -> "ReportSchedulePatchRequest":
        if self.schedule_cron is not None:
            _validate_cron(self.schedule_cron)
        return self


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


class ReportRunResponse(BaseModel):
    id: int
    tenant_id: int
    schedule_id: Optional[int] = None
    started_at: datetime
    finished_at: Optional[datetime] = None
    status: Literal["running", "succeeded", "failed"]
    file_size_bytes: Optional[int] = None
    recipients_delivered_to: list[str]
    error_message: Optional[str] = None
    delivery_mode: Optional[Literal["attached", "link"]] = None
