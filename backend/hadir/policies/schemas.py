"""Pydantic schemas for the policies + assignments API."""

from __future__ import annotations

import re
from datetime import date as date_type
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

PolicyType = Literal["Fixed", "Flex", "Ramadan", "Custom"]
ScopeType = Literal["tenant", "department", "employee"]

_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def _is_hhmm(value: object) -> bool:
    return isinstance(value, str) and bool(_TIME_RE.match(value))


class PolicyConfig(BaseModel):
    """Policy ``config`` JSONB. Validates per-type field presence."""

    # Fixed
    start: Optional[str] = None
    end: Optional[str] = None
    grace_minutes: Optional[int] = Field(default=None, ge=0, le=180)

    # Flex
    in_window_start: Optional[str] = None
    in_window_end: Optional[str] = None
    out_window_start: Optional[str] = None
    out_window_end: Optional[str] = None

    # Common
    required_hours: int = Field(default=8, ge=1, le=24)

    @model_validator(mode="after")
    def _check_times(self) -> "PolicyConfig":
        for field, value in (
            ("start", self.start),
            ("end", self.end),
            ("in_window_start", self.in_window_start),
            ("in_window_end", self.in_window_end),
            ("out_window_start", self.out_window_start),
            ("out_window_end", self.out_window_end),
        ):
            if value is not None and not _is_hhmm(value):
                raise ValueError(
                    f"{field}: expected 'HH:MM', got {value!r}"
                )
        return self


class PolicyResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    type: PolicyType
    config: dict[str, Any]
    active_from: date_type
    active_until: Optional[date_type] = None


class PolicyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: PolicyType
    config: PolicyConfig
    active_from: date_type
    active_until: Optional[date_type] = None

    @model_validator(mode="after")
    def _check_type_fields(self) -> "PolicyCreateRequest":
        if self.type == "Fixed":
            if not self.config.start or not self.config.end:
                raise ValueError(
                    "Fixed policy requires start + end times in config"
                )
        elif self.type == "Flex":
            for field in (
                "in_window_start",
                "in_window_end",
                "out_window_start",
                "out_window_end",
            ):
                if getattr(self.config, field) is None:
                    raise ValueError(
                        f"Flex policy requires {field} in config"
                    )
        return self


class PolicyPatchRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    config: Optional[PolicyConfig] = None
    active_from: Optional[date_type] = None
    active_until: Optional[date_type] = None


class AssignmentResponse(BaseModel):
    id: int
    tenant_id: int
    policy_id: int
    scope_type: ScopeType
    scope_id: Optional[int] = None
    active_from: date_type
    active_until: Optional[date_type] = None


class AssignmentCreateRequest(BaseModel):
    policy_id: int = Field(ge=1)
    scope_type: ScopeType
    scope_id: Optional[int] = Field(default=None, ge=1)
    active_from: date_type
    active_until: Optional[date_type] = None

    @model_validator(mode="after")
    def _check_scope(self) -> "AssignmentCreateRequest":
        if self.scope_type == "tenant" and self.scope_id is not None:
            raise ValueError("tenant-scoped assignment must omit scope_id")
        if self.scope_type != "tenant" and self.scope_id is None:
            raise ValueError(f"{self.scope_type}-scoped assignment requires scope_id")
        return self
