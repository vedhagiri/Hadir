"""Pydantic schemas for the employees API.

Kept in a dedicated module so the router stays focused on HTTP plumbing.
Every request/response here is tenant-scoped; the ``tenant_id`` never
appears in wire formats — it's derived from the session.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field


Status = Literal["active", "inactive"]


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
    status: Status
    photo_count: int
    created_at: datetime


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


class EmployeePatchIn(BaseModel):
    # Every field optional — PATCH is partial. Callers pass only what they
    # want to change.
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    email: Optional[EmailStr] = None
    department_code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    department_id: Optional[int] = None
    status: Optional[Status] = None


class ImportError(BaseModel):
    """One failed row in an Excel import."""

    row: int
    message: str


class ImportResult(BaseModel):
    created: int
    updated: int
    errors: list[ImportError]
