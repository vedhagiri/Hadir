"""DB helpers for manager assignments + the Manager scope union.

Two surfaces:

* CRUD shaped to the API endpoints in ``router.py``.
* ``get_manager_visible_employee_ids(conn, scope, manager_user_id)`` —
  the union of (a) employees in the manager's departments and (b)
  employees directly assigned via ``manager_assignments``. Used by
  the attendance router (and any future Manager-scoped surfaces).

The primary-manager rule lives in the partial unique index on
``manager_assignments`` — see migration 0012. ``set_assignment``
runs the clear-prior-primary update + the new INSERT inside one
transaction (both connected via the connection passed in by the
caller) so the DB sees a single atomic transition.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import and_, delete, insert, select, update
from sqlalchemy.engine import Connection

from maugood.db import (
    departments,
    employees,
    manager_assignments,
    roles,
    user_departments,
    user_roles,
    users,
)
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class AssignmentRow:
    id: int
    tenant_id: int
    manager_user_id: int
    employee_id: int
    is_primary: bool


def list_managers_with_employees(
    conn: Connection, scope: TenantScope
) -> list[dict]:
    """Return every Manager + the employees currently assigned to them.

    Result shape mirrors ``ManagerGroup`` in ``schemas.py``. Departments
    appear inline so the UI can show "Manager Eng (ENG)" without an
    extra round-trip.
    """

    # 1. Find all users with the Manager role in this tenant.
    manager_rows = conn.execute(
        select(
            users.c.id.label("user_id"),
            users.c.email,
            users.c.full_name,
        )
        .select_from(
            users.join(
                user_roles,
                and_(
                    user_roles.c.user_id == users.c.id,
                    user_roles.c.tenant_id == users.c.tenant_id,
                ),
            ).join(
                roles,
                and_(
                    roles.c.id == user_roles.c.role_id,
                    roles.c.tenant_id == users.c.tenant_id,
                ),
            )
        )
        .where(
            users.c.tenant_id == scope.tenant_id,
            roles.c.code == "Manager",
            users.c.is_active.is_(True),
        )
        .distinct()
        .order_by(users.c.full_name.asc())
    ).all()

    if not manager_rows:
        return []

    manager_ids = [int(r.user_id) for r in manager_rows]

    # 2. Department codes for each Manager (multi-department supported).
    dept_rows = conn.execute(
        select(
            user_departments.c.user_id,
            departments.c.code,
        )
        .select_from(
            user_departments.join(
                departments,
                and_(
                    departments.c.id == user_departments.c.department_id,
                    departments.c.tenant_id == user_departments.c.tenant_id,
                ),
            )
        )
        .where(
            user_departments.c.tenant_id == scope.tenant_id,
            user_departments.c.user_id.in_(manager_ids),
        )
    ).all()
    dept_by_user: dict[int, list[str]] = {}
    for r in dept_rows:
        dept_by_user.setdefault(int(r.user_id), []).append(str(r.code))

    # 3. Direct assignments for each Manager.
    asg_rows = conn.execute(
        select(
            manager_assignments.c.id.label("assignment_id"),
            manager_assignments.c.manager_user_id,
            manager_assignments.c.is_primary,
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
        )
        .select_from(
            manager_assignments.join(
                employees,
                and_(
                    employees.c.id == manager_assignments.c.employee_id,
                    employees.c.tenant_id == manager_assignments.c.tenant_id,
                ),
            ).join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.manager_user_id.in_(manager_ids),
        )
        .order_by(employees.c.employee_code.asc())
    ).all()

    employees_by_manager: dict[int, list[dict]] = {mid: [] for mid in manager_ids}
    for r in asg_rows:
        employees_by_manager.setdefault(int(r.manager_user_id), []).append(
            {
                "employee_id": int(r.employee_id),
                "employee_code": str(r.employee_code),
                "full_name": str(r.full_name),
                "department_id": int(r.department_id),
                "department_code": str(r.department_code),
                "department_name": str(r.department_name),
                "is_primary": bool(r.is_primary),
                "assignment_id": int(r.assignment_id),
            }
        )

    return [
        {
            "manager_user_id": int(m.user_id),
            "full_name": str(m.full_name),
            "email": str(m.email),
            "department_codes": sorted(dept_by_user.get(int(m.user_id), [])),
            "employees": employees_by_manager.get(int(m.user_id), []),
        }
        for m in manager_rows
    ]


def list_unassigned_employees(
    conn: Connection, scope: TenantScope
) -> list[dict]:
    """Active employees with zero rows in ``manager_assignments``."""

    assigned_subq = (
        select(manager_assignments.c.employee_id)
        .where(manager_assignments.c.tenant_id == scope.tenant_id)
        .distinct()
    )
    rows = conn.execute(
        select(
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
        )
        .select_from(
            employees.join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.status == "active",
            employees.c.id.not_in(assigned_subq),
        )
        .order_by(employees.c.employee_code.asc())
    ).all()
    return [
        {
            "employee_id": int(r.employee_id),
            "employee_code": str(r.employee_code),
            "full_name": str(r.full_name),
            "department_id": int(r.department_id),
            "department_code": str(r.department_code),
            "department_name": str(r.department_name),
            "is_primary": False,
            "assignment_id": None,
        }
        for r in rows
    ]


def get_assignment(
    conn: Connection, scope: TenantScope, *, assignment_id: int
) -> Optional[AssignmentRow]:
    row = conn.execute(
        select(
            manager_assignments.c.id,
            manager_assignments.c.tenant_id,
            manager_assignments.c.manager_user_id,
            manager_assignments.c.employee_id,
            manager_assignments.c.is_primary,
        ).where(
            manager_assignments.c.id == assignment_id,
            manager_assignments.c.tenant_id == scope.tenant_id,
        )
    ).first()
    if row is None:
        return None
    return AssignmentRow(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        manager_user_id=int(row.manager_user_id),
        employee_id=int(row.employee_id),
        is_primary=bool(row.is_primary),
    )


def set_assignment(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    manager_user_id: int,
    is_primary: bool,
) -> AssignmentRow:
    """Create or refresh an assignment.

    If ``is_primary`` is True, clears any prior primary for this
    employee BEFORE inserting/updating so the partial unique index
    isn't violated during the transition. Both writes happen on the
    same connection; the caller's transaction wraps both.

    Returns the resulting row (created or updated).
    """

    if is_primary:
        # Demote any existing primary for this employee — at most one
        # such row by the partial unique index.
        conn.execute(
            update(manager_assignments)
            .where(
                manager_assignments.c.tenant_id == scope.tenant_id,
                manager_assignments.c.employee_id == employee_id,
                manager_assignments.c.is_primary.is_(True),
            )
            .values(is_primary=False, updated_at=datetime.now(tz=timezone.utc))
        )

    existing = conn.execute(
        select(manager_assignments.c.id, manager_assignments.c.is_primary).where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.employee_id == employee_id,
            manager_assignments.c.manager_user_id == manager_user_id,
        )
    ).first()

    if existing is not None:
        conn.execute(
            update(manager_assignments)
            .where(manager_assignments.c.id == int(existing.id))
            .values(
                is_primary=is_primary,
                updated_at=datetime.now(tz=timezone.utc),
            )
        )
        new_id = int(existing.id)
    else:
        new_id = int(
            conn.execute(
                insert(manager_assignments)
                .values(
                    tenant_id=scope.tenant_id,
                    manager_user_id=manager_user_id,
                    employee_id=employee_id,
                    is_primary=is_primary,
                )
                .returning(manager_assignments.c.id)
            ).scalar_one()
        )

    return AssignmentRow(
        id=new_id,
        tenant_id=scope.tenant_id,
        manager_user_id=manager_user_id,
        employee_id=employee_id,
        is_primary=is_primary,
    )


def delete_assignment(
    conn: Connection, scope: TenantScope, *, assignment_id: int
) -> bool:
    """Drop one assignment row. Returns True if a row was removed."""

    result = conn.execute(
        delete(manager_assignments).where(
            manager_assignments.c.id == assignment_id,
            manager_assignments.c.tenant_id == scope.tenant_id,
        )
    )
    return bool(result.rowcount)


# ---------------------------------------------------------------------------
# Scope helper — used by the attendance router (and future Manager
# surfaces) to compute the union of department membership + direct
# manager_assignments visibility.
# ---------------------------------------------------------------------------


def get_manager_visible_employee_ids(
    conn: Connection,
    scope: TenantScope,
    *,
    manager_user_id: int,
) -> set[int]:
    """Union of (a) dept-member employees and (b) directly-assigned ones.

    Returns an empty set when the manager has neither departments
    nor direct assignments — call sites should treat that as "Manager
    sees nothing" without widening to the full tenant view.
    """

    # (a) Employees in departments the manager is a member of.
    dept_employee_rows = conn.execute(
        select(employees.c.id)
        .select_from(
            employees.join(
                user_departments,
                and_(
                    user_departments.c.department_id == employees.c.department_id,
                    user_departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(
            employees.c.tenant_id == scope.tenant_id,
            user_departments.c.user_id == manager_user_id,
            employees.c.status == "active",
        )
    ).all()
    visible: set[int] = {int(r.id) for r in dept_employee_rows}

    # (b) Direct assignments via manager_assignments.
    direct_rows = conn.execute(
        select(manager_assignments.c.employee_id).where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.manager_user_id == manager_user_id,
        )
    ).all()
    visible.update(int(r.employee_id) for r in direct_rows)

    return visible
