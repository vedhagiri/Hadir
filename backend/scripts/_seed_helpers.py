"""Shared seed helpers (Argon2 hash, role/dept/manager assignment, audit).

Factored out of ``seed_test_accounts.py`` + the new
``pre_omran_reset_seed.py`` so both scripts agree on:

* the Argon2 hashing path (always via ``hadir.auth.passwords.hash_password``);
* role + department + manager-assignment INSERT shapes;
* the ``system_seed`` audit-row convention (post-P28 ``actor_label``
  column on ``audit_log``).

Importable as ``scripts._seed_helpers`` from anywhere inside the
backend container.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from sqlalchemy import insert, select
from sqlalchemy.engine import Connection

from hadir.auth.passwords import hash_password
from hadir.db import (
    audit_log,
    departments,
    employees,
    manager_assignments,
    roles,
    user_departments,
    user_roles,
    users,
)

logger = logging.getLogger(__name__)


# Tag every audit row written by a seed script. Auditors filter on
# ``actor_label='system_seed'`` to triage rows the scripts produced.
SYSTEM_SEED_LABEL = "system_seed"


# ---- argon2 -----------------------------------------------------------


def hash_pw(password: str) -> str:
    """Hash via the app's Argon2id configuration. Never log the plain."""

    return hash_password(password)


# ---- role / department lookup -----------------------------------------


def role_ids_by_code(conn: Connection, *, tenant_id: int) -> dict[str, int]:
    rows = conn.execute(
        select(roles.c.id, roles.c.code).where(roles.c.tenant_id == tenant_id)
    ).all()
    return {str(r.code): int(r.id) for r in rows}


def department_ids_by_code(
    conn: Connection, *, tenant_id: int
) -> dict[str, int]:
    rows = conn.execute(
        select(departments.c.id, departments.c.code).where(
            departments.c.tenant_id == tenant_id
        )
    ).all()
    return {str(r.code): int(r.id) for r in rows}


def ensure_department(
    conn: Connection, *, tenant_id: int, code: str, name: str
) -> int:
    """Get-or-create a department row. Idempotent."""

    existing = conn.execute(
        select(departments.c.id).where(
            departments.c.tenant_id == tenant_id,
            departments.c.code == code,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return int(existing)
    new_id = conn.execute(
        insert(departments)
        .values(tenant_id=tenant_id, code=code, name=name)
        .returning(departments.c.id)
    ).scalar_one()
    return int(new_id)


# ---- user creation ----------------------------------------------------


def create_user(
    conn: Connection,
    *,
    tenant_id: int,
    email: str,
    full_name: str,
    password: str,
    role_codes: Iterable[str],
    department_codes: Iterable[str] = (),
    role_id_lookup: Optional[dict[str, int]] = None,
    department_id_lookup: Optional[dict[str, int]] = None,
) -> int:
    """Insert a user + role/department links. Returns the new user id.

    NOT idempotent — caller should pre-check for collisions when
    needed. The pre-Omran reset script always wipes first, so a
    create-only path is what we want.
    """

    if role_id_lookup is None:
        role_id_lookup = role_ids_by_code(conn, tenant_id=tenant_id)
    if department_id_lookup is None:
        department_id_lookup = department_ids_by_code(
            conn, tenant_id=tenant_id
        )

    user_id = int(
        conn.execute(
            insert(users)
            .values(
                tenant_id=tenant_id,
                email=email.strip().lower(),
                password_hash=hash_pw(password),
                full_name=full_name,
                is_active=True,
            )
            .returning(users.c.id)
        ).scalar_one()
    )

    for code in role_codes:
        rid = role_id_lookup.get(code)
        if rid is None:
            raise ValueError(
                f"role {code!r} not found in tenant {tenant_id}; "
                "did the provisioning step run?"
            )
        conn.execute(
            insert(user_roles).values(
                tenant_id=tenant_id, user_id=user_id, role_id=rid
            )
        )

    for code in department_codes:
        did = department_id_lookup.get(code)
        if did is None:
            raise ValueError(
                f"department {code!r} not found in tenant {tenant_id}"
            )
        conn.execute(
            insert(user_departments).values(
                tenant_id=tenant_id, user_id=user_id, department_id=did
            )
        )

    return user_id


# ---- employee creation ------------------------------------------------


def create_employee(
    conn: Connection,
    *,
    tenant_id: int,
    employee_code: str,
    full_name: str,
    email: Optional[str],
    department_code: str,
    department_id_lookup: Optional[dict[str, int]] = None,
) -> int:
    """Insert an employee row. Returns the new id."""

    if department_id_lookup is None:
        department_id_lookup = department_ids_by_code(
            conn, tenant_id=tenant_id
        )
    did = department_id_lookup.get(department_code)
    if did is None:
        raise ValueError(
            f"department {department_code!r} not found in tenant {tenant_id}"
        )
    return int(
        conn.execute(
            insert(employees)
            .values(
                tenant_id=tenant_id,
                employee_code=employee_code,
                full_name=full_name,
                email=(email or "").strip().lower() or None,
                department_id=did,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
    )


# ---- manager assignments (P8) -----------------------------------------


def assign_manager(
    conn: Connection,
    *,
    tenant_id: int,
    manager_user_id: int,
    employee_id: int,
    is_primary: bool = False,
) -> int:
    """Pin a Manager user to an Employee. Set ``is_primary`` on at
    most one assignment per employee — Postgres enforces a partial
    unique index, but the caller is the one with the policy."""

    return int(
        conn.execute(
            insert(manager_assignments)
            .values(
                tenant_id=tenant_id,
                manager_user_id=manager_user_id,
                employee_id=employee_id,
                is_primary=is_primary,
            )
            .returning(manager_assignments.c.id)
        ).scalar_one()
    )


# ---- audit -----------------------------------------------------------


def write_seed_audit(
    conn: Connection,
    *,
    tenant_id: int,
    action: str,
    entity_type: str,
    entity_id: Optional[str] = None,
    after: Optional[dict] = None,
    before: Optional[dict] = None,
) -> None:
    """Write an audit row tagged ``actor_label='system_seed'``.

    Use this from any seed/reset script — never the ``hadir.auth.audit``
    helper, which expects an authenticated request scope. The
    ``actor_user_id=NULL`` + ``actor_label='system_seed'`` combo is
    how a future auditor distinguishes seed activity from real
    operator activity.
    """

    conn.execute(
        insert(audit_log).values(
            tenant_id=tenant_id,
            actor_user_id=None,
            actor_label=SYSTEM_SEED_LABEL,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=after,
        )
    )


__all__ = [
    "SYSTEM_SEED_LABEL",
    "hash_pw",
    "role_ids_by_code",
    "department_ids_by_code",
    "ensure_department",
    "create_user",
    "create_employee",
    "assign_manager",
    "write_seed_audit",
]
