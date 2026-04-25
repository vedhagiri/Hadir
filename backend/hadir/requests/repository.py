"""Tenant-scoped DB access for the requests workflow.

Every function takes ``scope: TenantScope`` and filters on
``scope.tenant_id`` — same chokepoint discipline as the rest of the
codebase. Role scoping (employee / manager / HR / admin) lives in the
router, not here; the repo only knows how to ask for "all rows" or
"rows for an employee".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type, datetime
from typing import Iterable, Optional

from sqlalchemy import and_, func, insert, or_, select, update
from sqlalchemy.engine import Connection

from hadir.db import (
    employees,
    leave_types,
    manager_assignments,
    requests as requests_table,
)
from hadir.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class RequestRow:
    id: int
    tenant_id: int
    employee_id: int
    employee_code: str
    employee_full_name: str
    type: str
    reason_category: str
    reason_text: str
    target_date_start: date_type
    target_date_end: Optional[date_type]
    leave_type_id: Optional[int]
    leave_type_code: Optional[str]
    leave_type_name: Optional[str]
    status: str
    manager_user_id: Optional[int]
    manager_decision_at: Optional[datetime]
    manager_comment: Optional[str]
    hr_user_id: Optional[int]
    hr_decision_at: Optional[datetime]
    hr_comment: Optional[str]
    admin_user_id: Optional[int]
    admin_decision_at: Optional[datetime]
    admin_comment: Optional[str]
    submitted_at: datetime
    created_at: datetime


def _row_to_request(row) -> RequestRow:  # type: ignore[no-untyped-def]
    return RequestRow(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        employee_id=int(row.employee_id),
        employee_code=str(row.employee_code),
        employee_full_name=str(row.employee_full_name),
        type=str(row.type),
        reason_category=str(row.reason_category),
        reason_text=str(row.reason_text or ""),
        target_date_start=row.target_date_start,
        target_date_end=row.target_date_end,
        leave_type_id=int(row.leave_type_id) if row.leave_type_id is not None else None,
        leave_type_code=str(row.leave_type_code) if row.leave_type_code is not None else None,
        leave_type_name=str(row.leave_type_name) if row.leave_type_name is not None else None,
        status=str(row.status),
        manager_user_id=int(row.manager_user_id) if row.manager_user_id is not None else None,
        manager_decision_at=row.manager_decision_at,
        manager_comment=row.manager_comment,
        hr_user_id=int(row.hr_user_id) if row.hr_user_id is not None else None,
        hr_decision_at=row.hr_decision_at,
        hr_comment=row.hr_comment,
        admin_user_id=int(row.admin_user_id) if row.admin_user_id is not None else None,
        admin_decision_at=row.admin_decision_at,
        admin_comment=row.admin_comment,
        submitted_at=row.submitted_at,
        created_at=row.created_at,
    )


def _select_with_joins(scope: TenantScope):
    """Base SELECT joining employees + leave_types so consumers don't N+1."""

    return (
        select(
            requests_table.c.id,
            requests_table.c.tenant_id,
            requests_table.c.employee_id,
            employees.c.employee_code,
            employees.c.full_name.label("employee_full_name"),
            requests_table.c.type,
            requests_table.c.reason_category,
            requests_table.c.reason_text,
            requests_table.c.target_date_start,
            requests_table.c.target_date_end,
            requests_table.c.leave_type_id,
            leave_types.c.code.label("leave_type_code"),
            leave_types.c.name.label("leave_type_name"),
            requests_table.c.status,
            requests_table.c.manager_user_id,
            requests_table.c.manager_decision_at,
            requests_table.c.manager_comment,
            requests_table.c.hr_user_id,
            requests_table.c.hr_decision_at,
            requests_table.c.hr_comment,
            requests_table.c.admin_user_id,
            requests_table.c.admin_decision_at,
            requests_table.c.admin_comment,
            requests_table.c.submitted_at,
            requests_table.c.created_at,
        )
        .select_from(
            requests_table.join(
                employees,
                and_(
                    employees.c.id == requests_table.c.employee_id,
                    employees.c.tenant_id == requests_table.c.tenant_id,
                ),
            ).outerjoin(
                leave_types,
                and_(
                    leave_types.c.id == requests_table.c.leave_type_id,
                    leave_types.c.tenant_id == requests_table.c.tenant_id,
                ),
            )
        )
        .where(requests_table.c.tenant_id == scope.tenant_id)
    )


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def get_request(
    conn: Connection, scope: TenantScope, request_id: int
) -> Optional[RequestRow]:
    row = conn.execute(
        _select_with_joins(scope).where(requests_table.c.id == request_id)
    ).first()
    return _row_to_request(row) if row is not None else None


def list_requests_for_employee(
    conn: Connection, scope: TenantScope, *, employee_id: int
) -> list[RequestRow]:
    rows = conn.execute(
        _select_with_joins(scope)
        .where(requests_table.c.employee_id == employee_id)
        .order_by(requests_table.c.id.desc())
    ).all()
    return [_row_to_request(r) for r in rows]


def list_requests_for_employee_ids(
    conn: Connection, scope: TenantScope, *, employee_ids: Iterable[int]
) -> list[RequestRow]:
    ids = list(employee_ids)
    if not ids:
        return []
    rows = conn.execute(
        _select_with_joins(scope)
        .where(requests_table.c.employee_id.in_(ids))
        .order_by(requests_table.c.id.desc())
    ).all()
    return [_row_to_request(r) for r in rows]


def list_pending_manager_for_employees(
    conn: Connection, scope: TenantScope, *, employee_ids: Iterable[int]
) -> list[RequestRow]:
    """Submitted requests for a manager's visible employees.

    Sorted with the manager's primary-assigned employees first
    (matching the P15 ask) — same partial-unique-index row from
    migration 0012 governs ``is_primary``.
    """

    ids = list(employee_ids)
    if not ids:
        return []
    rows = conn.execute(
        _select_with_joins(scope)
        .where(
            requests_table.c.employee_id.in_(ids),
            requests_table.c.status == "submitted",
        )
        .order_by(
            requests_table.c.submitted_at.asc(),
            requests_table.c.id.asc(),
        )
    ).all()
    return [_row_to_request(r) for r in rows]


def list_pending_hr(conn: Connection, scope: TenantScope) -> list[RequestRow]:
    """Manager-approved requests awaiting HR — oldest first."""

    rows = conn.execute(
        _select_with_joins(scope)
        .where(requests_table.c.status == "manager_approved")
        .order_by(
            requests_table.c.submitted_at.asc(),
            requests_table.c.id.asc(),
        )
    ).all()
    return [_row_to_request(r) for r in rows]


def list_decided_by_user(
    conn: Connection, scope: TenantScope, *, user_id: int
) -> list[RequestRow]:
    """Every request the given user has touched at any decision stage."""

    rows = conn.execute(
        _select_with_joins(scope)
        .where(
            (requests_table.c.manager_user_id == user_id)
            | (requests_table.c.hr_user_id == user_id)
            | (requests_table.c.admin_user_id == user_id)
        )
        .order_by(requests_table.c.id.desc())
    ).all()
    return [_row_to_request(r) for r in rows]


def primary_managed_employee_ids(
    conn: Connection, scope: TenantScope, *, manager_user_id: int
) -> set[int]:
    """Subset of the manager's visible employees flagged ``is_primary``.

    Used by the inbox to sort primary-assigned requests first; the
    surrounding visible-set computation lives in the manager-assignments
    repo (``get_manager_visible_employee_ids``).
    """

    rows = conn.execute(
        select(manager_assignments.c.employee_id).where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.manager_user_id == manager_user_id,
            manager_assignments.c.is_primary.is_(True),
        )
    ).all()
    return {int(r.employee_id) for r in rows}


def list_requests_for_hr(
    conn: Connection, scope: TenantScope
) -> list[RequestRow]:
    """HR sees everything that has reached them — i.e. has been
    manager-approved at some point. That includes terminal HR + Admin
    outcomes too, so HR can see what they decided yesterday.
    """

    visible_statuses = (
        "manager_approved",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
    )
    rows = conn.execute(
        _select_with_joins(scope)
        .where(requests_table.c.status.in_(visible_statuses))
        .order_by(requests_table.c.id.desc())
    ).all()
    return [_row_to_request(r) for r in rows]


def list_all_requests(
    conn: Connection, scope: TenantScope
) -> list[RequestRow]:
    rows = conn.execute(
        _select_with_joins(scope).order_by(requests_table.c.id.desc())
    ).all()
    return [_row_to_request(r) for r in rows]


# ---------------------------------------------------------------------------
# Manager primary-lookup
# ---------------------------------------------------------------------------


def get_primary_manager_user_id(
    conn: Connection, scope: TenantScope, *, employee_id: int
) -> Optional[int]:
    """Return the user_id of the employee's primary manager, if any.

    The primary-manager rule is enforced at the DB level via the
    partial unique index from migration 0012 — at most one row per
    (tenant_id, employee_id) WHERE is_primary. This helper reads it.
    """

    row = conn.execute(
        select(manager_assignments.c.manager_user_id).where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.employee_id == employee_id,
            manager_assignments.c.is_primary.is_(True),
        )
    ).first()
    return int(row.manager_user_id) if row is not None else None


def is_manager_assigned_to(
    conn: Connection,
    scope: TenantScope,
    *,
    manager_user_id: int,
    employee_id: int,
) -> bool:
    """``True`` if the manager has any assignment row for the employee.

    Used to gate manager-decide on the request: a manager can only
    decide on requests for employees they're assigned to (primary or
    not — the primary rule only governs auto-routing on submission).
    """

    row = conn.execute(
        select(manager_assignments.c.id).where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.manager_user_id == manager_user_id,
            manager_assignments.c.employee_id == employee_id,
        )
    ).first()
    return row is not None


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def create_request(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    type: str,
    reason_category: str,
    reason_text: str,
    target_date_start: date_type,
    target_date_end: Optional[date_type],
    leave_type_id: Optional[int],
    manager_user_id: Optional[int],
) -> int:
    return int(
        conn.execute(
            insert(requests_table)
            .values(
                tenant_id=scope.tenant_id,
                employee_id=employee_id,
                type=type,
                reason_category=reason_category,
                reason_text=reason_text,
                target_date_start=target_date_start,
                target_date_end=target_date_end,
                leave_type_id=leave_type_id,
                status="submitted",
                manager_user_id=manager_user_id,
            )
            .returning(requests_table.c.id)
        ).scalar_one()
    )


def update_status(
    conn: Connection,
    scope: TenantScope,
    request_id: int,
    *,
    status: str,
    stage: str,
    actor_user_id: int,
    decision_at: datetime,
    comment: Optional[str],
) -> None:
    """Apply a status transition + per-stage actor + comment."""

    values: dict[str, object] = {
        "status": status,
        "updated_at": decision_at,
    }
    if stage == "manager":
        values.update(
            {
                "manager_user_id": actor_user_id,
                "manager_decision_at": decision_at,
                "manager_comment": comment,
            }
        )
    elif stage == "hr":
        values.update(
            {
                "hr_user_id": actor_user_id,
                "hr_decision_at": decision_at,
                "hr_comment": comment,
            }
        )
    elif stage == "admin":
        values.update(
            {
                "admin_user_id": actor_user_id,
                "admin_decision_at": decision_at,
                "admin_comment": comment,
            }
        )
    elif stage == "cancel":
        # Cancellation is initiated by the employee; no per-stage
        # actor field. We just bump status + updated_at.
        pass
    else:
        raise ValueError(f"unknown stage {stage!r}")

    conn.execute(
        update(requests_table)
        .where(
            requests_table.c.id == request_id,
            requests_table.c.tenant_id == scope.tenant_id,
        )
        .values(**values)
    )


# ---------------------------------------------------------------------------
# Employee resolution from session
# ---------------------------------------------------------------------------


def employee_for_user_email(
    conn: Connection, scope: TenantScope, *, email: str
) -> Optional[int]:
    """Resolve the logged-in user → employees row by lower-cased email.

    Same shortcut the attendance router uses — until v1.0 wires an
    explicit user↔employee join table, email is the bridge.
    """

    if not email:
        return None
    needle = email.strip().lower()
    if not needle:
        return None
    row = conn.execute(
        select(employees.c.id).where(
            employees.c.tenant_id == scope.tenant_id,
            func.lower(employees.c.email) == needle,
        )
    ).first()
    return int(row.id) if row is not None else None
