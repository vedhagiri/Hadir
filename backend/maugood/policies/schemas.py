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

    # Fixed (also Ramadan, Custom-Fixed)
    start: Optional[str] = None
    end: Optional[str] = None
    grace_minutes: Optional[int] = Field(default=None, ge=0, le=180)

    # Flex (also Custom-Flex)
    in_window_start: Optional[str] = None
    in_window_end: Optional[str] = None
    out_window_start: Optional[str] = None
    out_window_end: Optional[str] = None

    # Common
    required_hours: int = Field(default=8, ge=1, le=24)

    # Ramadan + Custom: ISO date strings (YYYY-MM-DD).
    start_date: Optional[str] = None
    end_date: Optional[str] = None

    # Custom only — picks which inner shape to use.
    inner_type: Optional[Literal["Fixed", "Flex"]] = None

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
        # Date sanity. Pydantic-side parse rather than full
        # ``datetime.fromisoformat`` so the error stays at the API
        # boundary instead of bubbling up from the engine helpers.
        if self.start_date and self.end_date:
            try:
                from datetime import date  # noqa: PLC0415

                rs = date.fromisoformat(self.start_date)
                re_ = date.fromisoformat(self.end_date)
            except ValueError as exc:
                raise ValueError(
                    f"start_date / end_date must be YYYY-MM-DD ({exc})"
                )
            if rs > re_:
                raise ValueError("start_date must be on or before end_date")
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
        cfg = self.config
        if self.type == "Fixed":
            if not cfg.start or not cfg.end:
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
                if getattr(cfg, field) is None:
                    raise ValueError(
                        f"Flex policy requires {field} in config"
                    )
        elif self.type == "Ramadan":
            # Ramadan = Fixed shape + a date range.
            if not cfg.start or not cfg.end:
                raise ValueError(
                    "Ramadan policy requires start + end times in config"
                )
            if not cfg.start_date or not cfg.end_date:
                raise ValueError(
                    "Ramadan policy requires start_date + end_date in config"
                )
        elif self.type == "Custom":
            if not cfg.start_date or not cfg.end_date:
                raise ValueError(
                    "Custom policy requires start_date + end_date in config"
                )
            if cfg.inner_type is None:
                raise ValueError(
                    "Custom policy requires inner_type ('Fixed' | 'Flex')"
                )
            if cfg.inner_type == "Fixed":
                if not cfg.start or not cfg.end:
                    raise ValueError(
                        "Custom (Fixed) requires start + end times in config"
                    )
            elif cfg.inner_type == "Flex":
                for field in (
                    "in_window_start",
                    "in_window_end",
                    "out_window_start",
                    "out_window_end",
                ):
                    if getattr(cfg, field) is None:
                        raise ValueError(
                            f"Custom (Flex) requires {field} in config"
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
