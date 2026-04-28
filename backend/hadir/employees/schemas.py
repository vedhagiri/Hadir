"""Pydantic schemas for the employees API.

Kept in a dedicated module so the router stays focused on HTTP plumbing.
Every request/response here is tenant-scoped; the ``tenant_id`` never
appears in wire formats — it's derived from the session.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field, model_validator


# Inbound (create/patch) — operators can only flip between
# ``active`` and ``inactive``. The third value, ``deleted``,
# is reachable only via the PDPL endpoint (P25) so the audit
# trail there is the load-bearing record.
Status = Literal["active", "inactive"]
# Outbound (read) — must include ``deleted`` so post-PDPL
# rows can serialise. Keep ``Status`` in sync with the DB
# CHECK at migration 0024.
StatusOut = Literal["active", "inactive", "deleted"]


class DepartmentOut(BaseModel):
    id: int
    code: str
    name: str


class EmployeeOut(BaseModel):
    id: int
    employee_code: str
    full_name: str
    email: Optional[str] = None
    department: DepartmentOut
    status: StatusOut
    photo_count: int
    created_at: datetime
    # P28.7 lifecycle + HR org-chart fields. All optional / nullable —
    # existing rows have NULL until HR backfills them.
    designation: Optional[str] = None
    phone: Optional[str] = None
    reports_to_user_id: Optional[int] = None
    reports_to_full_name: Optional[str] = None
    joining_date: Optional[date] = None
    relieving_date: Optional[date] = None
    deactivated_at: Optional[datetime] = None
    deactivation_reason: Optional[str] = None
    # Role codes from the linked platform user (joined by email).
    # Empty list = no platform login OR login with no roles assigned.
    # Surfaced for the employees-list ROLE column.
    role_codes: list[str] = []


class EmployeeListOut(BaseModel):
    items: list[EmployeeOut]
    total: int
    page: int
    page_size: int


class EmployeeCreateIn(BaseModel):
    employee_code: str = Field(min_length=1, max_length=64)
    full_name: str = Field(min_length=1, max_length=200)
    # Optional — not every employee has a company email in the pilot.
    email: Optional[EmailStr] = None
    # Prefer ``department_code`` (stable across tenants) over
    # ``department_id`` (surrogate key) for human callers.
    department_code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    department_id: Optional[int] = None
    status: Status = "active"
    # P28.7 — extended fields.
    designation: Optional[str] = Field(default=None, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=30)
    reports_to_user_id: Optional[int] = None
    joining_date: Optional[date] = None
    relieving_date: Optional[date] = None
    # When status='inactive' on create, server requires a reason
    # (handled at the router; min_length=5 enforced there).
    deactivation_reason: Optional[str] = Field(default=None, max_length=400)

    @model_validator(mode="after")
    def _date_order(self) -> "EmployeeCreateIn":
        if (
            self.joining_date is not None
            and self.relieving_date is not None
            and self.relieving_date < self.joining_date
        ):
            raise ValueError("relieving_date cannot be before joining_date")
        return self


class EmployeePatchIn(BaseModel):
    # Every field optional — PATCH is partial. Callers pass only what they
    # want to change.
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    email: Optional[EmailStr] = None
    department_code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    department_id: Optional[int] = None
    status: Optional[Status] = None
    # P28.7
    designation: Optional[str] = Field(default=None, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=30)
    reports_to_user_id: Optional[int] = None
    joining_date: Optional[date] = None
    relieving_date: Optional[date] = None
    deactivation_reason: Optional[str] = Field(default=None, max_length=400)

    @model_validator(mode="after")
    def _date_order(self) -> "EmployeePatchIn":
        # Cross-field check: only fires when BOTH dates are set in this
        # patch. The router does the rest of the cross-field check
        # against the existing row's values.
        if (
            self.joining_date is not None
            and self.relieving_date is not None
            and self.relieving_date < self.joining_date
        ):
            raise ValueError("relieving_date cannot be before joining_date")
        return self


class ImportError(BaseModel):
    """One failed row in an Excel import."""

    row: int
    message: str


class ImportWarning(BaseModel):
    """One non-fatal note about an Excel import row.

    P12: unknown custom-field column codes and per-row coercion failures
    surface here instead of aborting the row. The row's standard
    columns still import; the bad cell is just skipped.
    """

    row: int
    message: str


class ImportResult(BaseModel):
    created: int
    updated: int
    errors: list[ImportError]
    warnings: list[ImportWarning] = []


# --- Photos (P6) -----------------------------------------------------------


class PhotoOut(BaseModel):
    id: int
    employee_id: int
    angle: Literal["front", "left", "right", "other"]


class PhotoListOut(BaseModel):
    items: list[PhotoOut]


class PhotoIngestAccepted(BaseModel):
    filename: str
    employee_code: str
    angle: Literal["front", "left", "right", "other"]
    photo_id: int


class PhotoIngestRejected(BaseModel):
    filename: str
    reason: str


class PhotoIngestResult(BaseModel):
    accepted: list[PhotoIngestAccepted]
    rejected: list[PhotoIngestRejected]
