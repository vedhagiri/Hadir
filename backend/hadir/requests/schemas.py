"""Pydantic schemas for /api/requests."""

from __future__ import annotations

from datetime import date as date_type, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

RequestType = Literal["exception", "leave"]
Decision = Literal["approve", "reject"]
Status = Literal[
    "submitted",
    "manager_approved",
    "manager_rejected",
    "hr_approved",
    "hr_rejected",
    "admin_approved",
    "admin_rejected",
    "cancelled",
]


class RequestCreate(BaseModel):
    """Body for ``POST /api/requests``.

    The router resolves the submitting employee from the session
    (lower-cased email match against ``employees``); operators can't
    POST on someone else's behalf — the Admin override path covers
    that need with a clearer audit trail.
    """

    type: RequestType
    reason_category: str = Field(min_length=1, max_length=64)
    reason_text: str = Field(default="", max_length=2000)
    target_date_start: date_type
    target_date_end: Optional[date_type] = None
    leave_type_id: Optional[int] = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _check(self) -> "RequestCreate":
        if (
            self.target_date_end is not None
            and self.target_date_end < self.target_date_start
        ):
            raise ValueError("target_date_end must be >= target_date_start")
        if self.type == "leave" and self.leave_type_id is None:
            raise ValueError("leave requests require leave_type_id")
        if self.type == "exception" and self.leave_type_id is not None:
            raise ValueError("exception requests must not carry leave_type_id")
        return self


class DecisionBody(BaseModel):
    decision: Decision
    comment: str = Field(default="", max_length=2000)


class AdminOverrideBody(BaseModel):
    decision: Decision
    # Mandatory per BRD FR-REQ-006. Empty / whitespace-only is rejected.
    comment: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def _check(self) -> "AdminOverrideBody":
        if not self.comment.strip():
            raise ValueError("comment is required for an admin override")
        return self


class RequestEmployee(BaseModel):
    id: int
    employee_code: str
    full_name: str


class ReasonCategoryResponse(BaseModel):
    id: int
    tenant_id: int
    request_type: RequestType
    code: str
    name: str
    display_order: int
    active: bool


class ReasonCategoryCreate(BaseModel):
    request_type: RequestType
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)


class ReasonCategoryPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    display_order: Optional[int] = Field(default=None, ge=0)
    active: Optional[bool] = None


class AttachmentResponse(BaseModel):
    id: int
    request_id: int
    original_filename: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime


class AttachmentConfigResponse(BaseModel):
    """What the browser needs to client-side validate before upload."""

    max_mb: int
    accepted_mime_types: list[str]


class RequestResponse(BaseModel):
    id: int
    tenant_id: int
    type: RequestType
    employee: RequestEmployee
    reason_category: str
    reason_text: str
    target_date_start: date_type
    target_date_end: Optional[date_type] = None
    leave_type_id: Optional[int] = None
    leave_type_code: Optional[str] = None
    leave_type_name: Optional[str] = None
    status: Status
    manager_user_id: Optional[int] = None
    manager_decision_at: Optional[datetime] = None
    manager_comment: Optional[str] = None
    hr_user_id: Optional[int] = None
    hr_decision_at: Optional[datetime] = None
    hr_comment: Optional[str] = None
    admin_user_id: Optional[int] = None
    admin_decision_at: Optional[datetime] = None
    admin_comment: Optional[str] = None
    submitted_at: datetime
    created_at: datetime
    # P15: per-row attachment count + SLA flags surfaced to the table.
    attachment_count: int = 0
    business_hours_open: float = 0.0
    sla_breached: bool = False
    # P15: marks the manager's primary-assigned employees so the
    # frontend can sort + show a "primary" badge.
    is_primary_for_viewer: bool = False


class InboxSummaryResponse(BaseModel):
    """Sidebar badge feed.

    ``pending_count`` is the number of requests in "Pending my decision"
    for the caller's role; ``breached_count`` is the subset breaching
    SLA. The frontend renders one number with a tone that escalates
    when ``breached_count > 0``.
    """

    pending_count: int
    breached_count: int
