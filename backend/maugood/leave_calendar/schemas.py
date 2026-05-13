"""Pydantic schemas for the leave-calendar API."""

from __future__ import annotations

from datetime import date as date_type
from typing import Optional

from pydantic import BaseModel, Field, model_validator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


VALID_WEEKDAYS = {
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
}


class LeaveTypeResponse(BaseModel):
    id: int
    tenant_id: int
    code: str
    name: str
    is_paid: bool
    active: bool


class LeaveTypeCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    is_paid: bool = True


class LeaveTypePatchRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    is_paid: Optional[bool] = None
    active: Optional[bool] = None


class HolidayResponse(BaseModel):
    id: int
    tenant_id: int
    date: date_type
    name: str
    # BUG-021 — free-text description (optional).
    description: Optional[str] = None
    active: bool


class HolidayCreateRequest(BaseModel):
    date: date_type
    name: str = Field(min_length=1, max_length=200)
    # BUG-021 — accept an optional description on create.
    description: Optional[str] = Field(default=None, max_length=500)


class HolidayBulkCreateRequest(BaseModel):
    holidays: list[HolidayCreateRequest] = Field(default_factory=list, max_length=500)


class HolidayImportSkipped(BaseModel):
    """One row that was skipped because a holiday already existed on
    the same date. Surfaced in the import response so the operator
    sees exactly what changed and what didn't."""

    date: date_type
    submitted_name: str
    existing_name: str


class HolidayImportResponse(BaseModel):
    """Result of POST /api/holidays/import.

    Replaces the old "list[HolidayResponse]" return shape so a same-
    date import is no longer silently a no-op (BUG-025): the frontend
    can now show 'imported: N, skipped: M' with a per-row list of the
    skips.
    """

    imported: list[HolidayResponse] = Field(default_factory=list)
    skipped: list[HolidayImportSkipped] = Field(default_factory=list)
    imported_count: int = 0
    skipped_count: int = 0


class ApprovedLeaveResponse(BaseModel):
    id: int
    tenant_id: int
    employee_id: int
    leave_type_id: int
    leave_type_code: str
    leave_type_name: str
    start_date: date_type
    end_date: date_type
    notes: Optional[str] = None
    approved_by_user_id: Optional[int] = None
    approved_at: str


class ApprovedLeaveCreateRequest(BaseModel):
    employee_id: int = Field(ge=1)
    leave_type_id: int = Field(ge=1)
    start_date: date_type
    end_date: date_type
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_range(self) -> "ApprovedLeaveCreateRequest":
        if self.start_date > self.end_date:
            raise ValueError("start_date must be on or before end_date")
        return self


class TenantSettingsResponse(BaseModel):
    tenant_id: int
    weekend_days: list[str]
    timezone: str
    updated_at: str


class TenantSettingsPatchRequest(BaseModel):
    weekend_days: Optional[list[str]] = None
    timezone: Optional[str] = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _check(self) -> "TenantSettingsPatchRequest":
        if self.weekend_days is not None:
            for d in self.weekend_days:
                if d not in VALID_WEEKDAYS:
                    raise ValueError(
                        f"weekend_days must be a subset of {sorted(VALID_WEEKDAYS)}, got {d!r}"
                    )
        if self.timezone is not None:
            try:
                ZoneInfo(self.timezone)
            except ZoneInfoNotFoundError as exc:
                raise ValueError(f"unknown timezone: {self.timezone!r}") from exc
        return self
