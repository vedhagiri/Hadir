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
