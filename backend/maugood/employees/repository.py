"""Database access for employees — all queries tenant-scoped.

Every function in this module takes a ``TenantScope`` (from
``maugood.tenants.scope``) and uses ``scope.tenant_id`` in its WHERE clause.
That's the single chokepoint: if you add a new query and forget the
filter, v1.0's multi-tenant cut-over will leak data across customers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from sqlalchemy import and_, func, insert, or_, select, update
from sqlalchemy.engine import Connection

from maugood.db import departments, employee_photos, employees, users
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class EmployeeRow:
    """Joined shape used by list + detail endpoints."""

    id: int
    employee_code: str
    full_name: str
    email: Optional[str]
    department_id: int
    department_code: str
    department_name: str
    status: str
    photo_count: int
    created_at: datetime
    # P28.7 fields. All optional — pre-P28.7 rows are NULL.
    designation: Optional[str] = None
    phone: Optional[str] = None
    reports_to_user_id: Optional[int] = None
    reports_to_full_name: Optional[str] = None
    joining_date: Optional[date] = None
    relieving_date: Optional[date] = None
    deactivated_at: Optional[datetime] = None
    deactivation_reason: Optional[str] = None
    # The employees-list page's ROLE column. Populated by joining the
    # linked ``users`` row by email (case-insensitive) and pulling
    # role codes from ``user_roles``. Empty list = no platform login
    # OR login exists but has no roles assigned.
    role_codes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DepartmentRow:
    id: int
    code: str
    name: str


def _photo_count_subquery():
    """Scalar-correlated photo count used by list/get queries."""

    return (
        select(func.count(employee_photos.c.id))
        .where(
            employee_photos.c.tenant_id == employees.c.tenant_id,
            employee_photos.c.employee_id == employees.c.id,
        )
        .correlate(employees)
        .scalar_subquery()
    )


def _employee_select(scope: TenantScope):
    photo_count = _photo_count_subquery().label("photo_count")
    # P28.7: outerjoin to ``users`` so the response carries the
    # reports_to manager's display name without a second query in
    # the router.
    reports_to = users.alias("reports_to_user")
    return (
        select(
            employees.c.id,
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.email,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
            employees.c.status,
            photo_count,
            employees.c.created_at,
            employees.c.designation,
            employees.c.phone,
            employees.c.reports_to_user_id,
            reports_to.c.full_name.label("reports_to_full_name"),
            employees.c.joining_date,
            employees.c.relieving_date,
            employees.c.deactivated_at,
            employees.c.deactivation_reason,
        )
        .select_from(
            employees.join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            ).outerjoin(
                reports_to,
                and_(
                    reports_to.c.id == employees.c.reports_to_user_id,
                    reports_to.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(employees.c.tenant_id == scope.tenant_id)
    )


def _row_to_employee(row) -> EmployeeRow:
    return EmployeeRow(
        id=int(row.id),
        employee_code=str(row.employee_code),
        full_name=str(row.full_name),
        email=row.email,
        department_id=int(row.department_id),
        department_code=str(row.department_code),
        department_name=str(row.department_name),
        status=str(row.status),
        photo_count=int(row.photo_count),
        created_at=row.created_at,
        designation=row.designation,
        phone=row.phone,
        reports_to_user_id=
            int(row.reports_to_user_id)
            if row.reports_to_user_id is not None
            else None,
        reports_to_full_name=row.reports_to_full_name,
        joining_date=row.joining_date,
        relieving_date=row.relieving_date,
        deactivated_at=row.deactivated_at,
        deactivation_reason=row.deactivation_reason,
    )


# --- Departments ------------------------------------------------------------


def get_department_by_code(
    conn: Connection, scope: TenantScope, code: str
) -> Optional[DepartmentRow]:
    row = conn.execute(
        select(departments.c.id, departments.c.code, departments.c.name).where(
            departments.c.tenant_id == scope.tenant_id, departments.c.code == code
        )
    ).first()
    if row is None:
        return None
    return DepartmentRow(id=int(row.id), code=str(row.code), name=str(row.name))


def get_department_by_id(
    conn: Connection, scope: TenantScope, department_id: int
) -> Optional[DepartmentRow]:
    row = conn.execute(
        select(departments.c.id, departments.c.code, departments.c.name).where(
            departments.c.tenant_id == scope.tenant_id,
            departments.c.id == department_id,
        )
    ).first()
    if row is None:
        return None
    return DepartmentRow(id=int(row.id), code=str(row.code), name=str(row.name))


# --- Employees --------------------------------------------------------------


def list_employees(
    conn: Connection,
    scope: TenantScope,
    *,
    q: Optional[str] = None,
    department_id: Optional[int] = None,
    include_inactive: bool = False,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[EmployeeRow], int]:
    """Return a page of employees and the total count matching the filters."""

    page = max(1, page)
    page_size = max(1, min(page_size, 200))

    base = _employee_select(scope)
    if not include_inactive:
        base = base.where(employees.c.status == "active")
    if department_id is not None:
        base = base.where(employees.c.department_id == department_id)
    if q:
        needle = f"%{q.strip().lower()}%"
        base = base.where(
            or_(
                func.lower(employees.c.employee_code).like(needle),
                func.lower(employees.c.full_name).like(needle),
                func.lower(employees.c.email).like(needle),
                func.lower(departments.c.code).like(needle),
                func.lower(departments.c.name).like(needle),
            )
        )

    # Count before applying limit/offset.
    count_stmt = select(func.count()).select_from(base.subquery())
    total = int(conn.execute(count_stmt).scalar_one())

    rows = conn.execute(
        base.order_by(employees.c.employee_code.asc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    page_rows = [_row_to_employee(r) for r in rows]
    role_map = _role_codes_by_email(
        conn, scope, [e.email for e in page_rows if e.email]
    )
    page_rows = [
        _replace_role_codes(e, role_map.get((e.email or "").lower(), ()))
        for e in page_rows
    ]
    return page_rows, total


def _role_codes_by_email(
    conn: Connection, scope: TenantScope, emails: list[str]
) -> dict[str, tuple[str, ...]]:
    """Batch-resolve role codes for a list of emails, keyed by lower-
    cased email. Single SQL hit regardless of page size — joins
    users → user_roles → roles in one go and groups in Python."""

    from maugood.db import roles as roles_t  # noqa: PLC0415
    from maugood.db import user_roles as user_roles_t  # noqa: PLC0415
    from maugood.db import users as users_t  # noqa: PLC0415

    norm_emails = [e.lower() for e in emails if e]
    if not norm_emails:
        return {}
    rows = conn.execute(
        select(users_t.c.email, roles_t.c.code)
        .select_from(
            users_t.join(
                user_roles_t,
                and_(
                    user_roles_t.c.user_id == users_t.c.id,
                    user_roles_t.c.tenant_id == users_t.c.tenant_id,
                ),
            ).join(
                roles_t,
                and_(
                    roles_t.c.id == user_roles_t.c.role_id,
                    roles_t.c.tenant_id == user_roles_t.c.tenant_id,
                ),
            )
        )
        .where(
            users_t.c.tenant_id == scope.tenant_id,
            func.lower(users_t.c.email).in_(norm_emails),
        )
    ).all()
    out: dict[str, list[str]] = {}
    for r in rows:
        key = str(r.email).lower()
        out.setdefault(key, []).append(str(r.code))
    return {k: tuple(sorted(v)) for k, v in out.items()}


def _replace_role_codes(
    e: EmployeeRow, role_codes: tuple[str, ...]
) -> EmployeeRow:
    """Frozen-dataclass replacement helper — return a new EmployeeRow
    with ``role_codes`` populated. The list query has no role data;
    the batch lookup above adds it after the page is fetched."""

    from dataclasses import replace as dc_replace  # noqa: PLC0415

    return dc_replace(e, role_codes=role_codes)


def get_employee(
    conn: Connection, scope: TenantScope, employee_id: int
) -> Optional[EmployeeRow]:
    row = conn.execute(
        _employee_select(scope).where(employees.c.id == employee_id)
    ).first()
    if row is None:
        return None
    base = _row_to_employee(row)
    if base.email:
        roles_map = _role_codes_by_email(conn, scope, [base.email])
        return _replace_role_codes(
            base, roles_map.get(base.email.lower(), ())
        )
    return base


def get_employee_by_code(
    conn: Connection, scope: TenantScope, code: str
) -> Optional[EmployeeRow]:
    row = conn.execute(
        _employee_select(scope).where(employees.c.employee_code == code)
    ).first()
    return _row_to_employee(row) if row is not None else None


def get_employee_by_email(
    conn: Connection, scope: TenantScope, email: str
) -> Optional[EmployeeRow]:
    """Return the employee row whose email matches case-insensitively.

    Used by ``GET /api/employees/me`` to map the authenticated user
    to their own employee record without requiring a full list scan
    on the client side. ``employees.email`` is CITEXT so the
    comparison is implicitly case-insensitive at the DB layer; we
    still ``lower()`` the input as defence in depth.
    """

    row = conn.execute(
        _employee_select(scope).where(
            employees.c.email == email.strip().lower()
        )
    ).first()
    if row is None:
        return None
    base = _row_to_employee(row)
    if base.email:
        roles_map = _role_codes_by_email(conn, scope, [base.email])
        return _replace_role_codes(
            base, roles_map.get(base.email.lower(), ())
        )
    return base


def create_employee(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_code: str,
    full_name: str,
    email: Optional[str],
    department_id: int,
    status: str = "active",
    designation: Optional[str] = None,
    phone: Optional[str] = None,
    reports_to_user_id: Optional[int] = None,
    joining_date: Optional[date] = None,
    relieving_date: Optional[date] = None,
    deactivated_at: Optional[datetime] = None,
    deactivation_reason: Optional[str] = None,
    section_id: Optional[int] = None,
) -> int:
    new_id = conn.execute(
        insert(employees)
        .values(
            tenant_id=scope.tenant_id,
            employee_code=employee_code,
            full_name=full_name,
            email=email,
            department_id=department_id,
            section_id=section_id,
            status=status,
            designation=designation,
            phone=phone,
            reports_to_user_id=reports_to_user_id,
            joining_date=joining_date,
            relieving_date=relieving_date,
            deactivated_at=deactivated_at,
            deactivation_reason=deactivation_reason,
        )
        .returning(employees.c.id)
    ).scalar_one()
    return int(new_id)


def is_user_in_tenant(
    conn: Connection, scope: TenantScope, user_id: int
) -> bool:
    """Check that a ``users.id`` belongs to this tenant — guards
    ``reports_to_user_id`` so a cross-tenant id can't sneak in via
    PATCH/POST."""

    row = conn.execute(
        select(users.c.id).where(
            users.c.tenant_id == scope.tenant_id,
            users.c.id == user_id,
        )
    ).first()
    return row is not None


def update_employee(
    conn: Connection,
    scope: TenantScope,
    employee_id: int,
    *,
    values: dict[str, object],
) -> None:
    """Partial update. ``values`` is pre-filtered to valid columns by caller."""

    if not values:
        return
    conn.execute(
        update(employees)
        .where(
            employees.c.id == employee_id,
            employees.c.tenant_id == scope.tenant_id,
        )
        .values(**values)
    )


def soft_delete_employee(
    conn: Connection, scope: TenantScope, employee_id: int
) -> None:
    """Set ``status='inactive'``. Hard delete is the PDPL-only path."""

    conn.execute(
        update(employees)
        .where(
            employees.c.id == employee_id,
            employees.c.tenant_id == scope.tenant_id,
        )
        .values(status="inactive")
    )


def list_all_for_export(conn: Connection, scope: TenantScope) -> list[EmployeeRow]:
    """Full tenant dump, including inactive rows, for the Excel export."""

    rows = conn.execute(
        _employee_select(scope).order_by(employees.c.employee_code.asc())
    ).all()
    return [_row_to_employee(r) for r in rows]
