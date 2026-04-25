"""Pydantic schemas for the manager-assignments API."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class EmployeeChip(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    department_id: int
    department_code: str
    department_name: str
    # Only filled inside the ``managers[].employees`` slot — for the
    # ``unassigned`` slot it's irrelevant.
    is_primary: bool = False
    # Assignment id — needed by the frontend so DELETE knows which
    # row to drop without rounding back through (manager_id, employee_id).
    assignment_id: Optional[int] = None


class ManagerGroup(BaseModel):
    manager_user_id: int
    full_name: str
    email: str
    department_codes: list[str]
    employees: list[EmployeeChip]


class AssignmentsListResponse(BaseModel):
    managers: list[ManagerGroup]
    unassigned: list[EmployeeChip]


class AssignmentCreateRequest(BaseModel):
    employee_id: int = Field(ge=1)
    manager_user_id: int = Field(ge=1)
    is_primary: bool = False


class AssignmentResponse(BaseModel):
    id: int
    tenant_id: int
    manager_user_id: int
    employee_id: int
    is_primary: bool
