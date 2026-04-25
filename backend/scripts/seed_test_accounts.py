"""Seed the M2 test account matrix.

Reference: ``docs/testing/v1.0-m2-test-accounts.md``. The markdown is
the human-readable matrix; the constants below are the script's source
of truth. Keep them in sync — when the matrix changes, edit *both*.

Usage::

    docker compose exec backend python -m scripts.seed_test_accounts --all
    docker compose exec backend python -m scripts.seed_test_accounts --tenant tenant_omran

Both forms are idempotent. A user that already exists by email inside
the tenant is skipped. Same for employees (matched by ``employee_code``)
and Super-Admin staff (matched by email in ``public.mts_staff``).

**Production red line.** These passwords are documented dev-only
defaults (``Hadir!2026`` / ``Superadmin!2026``). The deploy pipeline
must NOT package this script for production — see
``docs/testing/v1.0-m2-test-accounts.md §9``.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import insert, select
from sqlalchemy.engine import Connection, Engine

from hadir.auth.passwords import hash_password
from hadir.db import (
    departments,
    employees,
    make_admin_engine,
    mts_staff,
    roles,
    tenant_context,
    tenants,
    user_departments,
    user_roles,
    users,
)

logger = logging.getLogger("hadir.seed_test_accounts")


# --------------------------------------------------------------------------
# Account matrix — see docs/testing/v1.0-m2-test-accounts.md
# --------------------------------------------------------------------------

# Dev-only password convention. Easy to type during demos, throwaway by
# design. Production users get real credentials at P29 cutover; this
# script doesn't ship there.
TENANT_PASSWORD = "Hadir!2026"
SUPER_PASSWORD = "Superadmin!2026"


# Per-tenant user matrix. Each row drives one row in ``users`` plus zero
# or more rows in ``user_roles`` and ``user_departments``.
USERS_BY_TENANT: dict[str, list[dict]] = {
    "tenant_omran": [
        {
            "email": "admin@omran.test",
            "full_name": "Omran Admin",
            "roles": ["Admin"],
            "departments": [],
        },
        {
            "email": "hr@omran.test",
            "full_name": "Omran HR",
            "roles": ["HR"],
            "departments": [],
        },
        {
            "email": "manager.eng@omran.test",
            "full_name": "Engineering Manager",
            "roles": ["Manager"],
            "departments": ["ENG"],
        },
        {
            "email": "manager.ops@omran.test",
            "full_name": "Operations Manager",
            "roles": ["Manager"],
            "departments": ["OPS"],
        },
        {
            "email": "manager.multi@omran.test",
            "full_name": "Multi-Department Manager",
            "roles": ["Manager"],
            "departments": ["ENG", "OPS"],
        },
        {
            "email": "dual.role@omran.test",
            "full_name": "Dual-Role User",
            "roles": ["HR", "Manager"],
            "departments": ["ENG"],
        },
        {
            "email": "employee.eng1@omran.test",
            "full_name": "Engineering Employee 1",
            "roles": ["Employee"],
            "departments": ["ENG"],
        },
        {
            "email": "employee.eng2@omran.test",
            "full_name": "Engineering Employee 2",
            "roles": ["Employee"],
            "departments": ["ENG"],
        },
        {
            "email": "employee.ops1@omran.test",
            "full_name": "Operations Employee 1",
            "roles": ["Employee"],
            "departments": ["OPS"],
        },
        {
            # The "no department" edge case — exercises the engine's
            # behaviour against an unassigned scope.
            "email": "employee.solo@omran.test",
            "full_name": "Solo Employee (no dept)",
            "roles": ["Employee"],
            "departments": [],
        },
    ],
    "tenant_demo": [
        {
            "email": "admin@demo.test",
            "full_name": "Demo Admin",
            "roles": ["Admin"],
            "departments": [],
        },
        {
            "email": "hr@demo.test",
            "full_name": "Demo HR",
            "roles": ["HR"],
            "departments": [],
        },
        {
            "email": "manager.eng@demo.test",
            "full_name": "Engineering Manager",
            "roles": ["Manager"],
            "departments": ["ENG"],
        },
        {
            "email": "manager.ops@demo.test",
            "full_name": "Operations Manager",
            "roles": ["Manager"],
            "departments": ["OPS"],
        },
        {
            "email": "employee.eng1@demo.test",
            "full_name": "Engineering Employee 1",
            "roles": ["Employee"],
            "departments": ["ENG"],
        },
        {
            "email": "employee.eng2@demo.test",
            "full_name": "Engineering Employee 2",
            "roles": ["Employee"],
            "departments": ["ENG"],
        },
        {
            "email": "employee.ops1@demo.test",
            "full_name": "Operations Employee 1",
            "roles": ["Employee"],
            "departments": ["OPS"],
        },
    ],
}


# Per-tenant Employee matrix. ``email`` matches a row in USERS_BY_TENANT
# above where one exists; the honeypot rows (``OM0099`` / ``DC0099``)
# intentionally have no matching user — they're load-bearing for the
# manual cross-tenant search test in §6.5 of the doc.
EMPLOYEES_BY_TENANT: dict[str, list[dict]] = {
    "tenant_omran": [
        {
            "code": "OM0001",
            "full_name": "Engineering Manager",
            "email": "manager.eng@omran.test",
            "department": "ENG",
        },
        {
            "code": "OM0002",
            "full_name": "Operations Manager",
            "email": "manager.ops@omran.test",
            "department": "OPS",
        },
        {
            "code": "OM0003",
            "full_name": "Engineering Employee 1",
            "email": "employee.eng1@omran.test",
            "department": "ENG",
        },
        {
            "code": "OM0004",
            "full_name": "Engineering Employee 2",
            "email": "employee.eng2@omran.test",
            "department": "ENG",
        },
        {
            "code": "OM0005",
            "full_name": "Operations Employee 1",
            "email": "employee.ops1@omran.test",
            "department": "OPS",
        },
        {
            "code": "OM0006",
            "full_name": "Solo Employee",
            "email": "employee.solo@omran.test",
            "department": "ENG",
        },
        # Honeypot — same full_name as DC0099 below; lives only in this
        # tenant. Cross-tenant search must never surface it.
        {
            "code": "OM0099",
            "full_name": "Test Crossover",
            "email": "crossover@omran.test",
            "department": "ENG",
        },
    ],
    "tenant_demo": [
        {
            "code": "DC0001",
            "full_name": "Engineering Manager",
            "email": "manager.eng@demo.test",
            "department": "ENG",
        },
        {
            "code": "DC0002",
            "full_name": "Engineering Employee 1",
            "email": "employee.eng1@demo.test",
            "department": "ENG",
        },
        {
            "code": "DC0003",
            "full_name": "Operations Employee 1",
            "email": "employee.ops1@demo.test",
            "department": "OPS",
        },
        # Honeypot — paired with OM0099 above.
        {
            "code": "DC0099",
            "full_name": "Test Crossover",
            "email": "crossover@demo.test",
            "department": "ENG",
        },
    ],
}


# Globals — live in ``public.mts_staff``, not per-tenant.
SUPER_ADMINS: list[dict] = [
    {"email": "superadmin@mts.test", "full_name": "MTS Super Admin (Primary)"},
    {"email": "superadmin2@mts.test", "full_name": "MTS Super Admin (Secondary)"},
]


# Departments the script ensures exist (provisioning seeds these too;
# the helper below double-checks before any user_departments lookups).
_DEPARTMENT_DEFAULTS = (
    ("ENG", "Engineering"),
    ("OPS", "Operations"),
)


# --------------------------------------------------------------------------
# Counts + helpers
# --------------------------------------------------------------------------


@dataclass
class Counts:
    """Running totals surfaced in the final summary line."""

    created_users: int = 0
    skipped_users: int = 0
    created_employees: int = 0
    skipped_employees: int = 0
    created_super_admins: int = 0
    skipped_super_admins: int = 0
    errors: list[str] = field(default_factory=list)


def _resolve_role_ids(conn: Connection, *, tenant_id: int) -> dict[str, int]:
    rows = conn.execute(
        select(roles.c.id, roles.c.code).where(roles.c.tenant_id == tenant_id)
    ).all()
    return {str(r.code): int(r.id) for r in rows}


def _resolve_department_ids(conn: Connection, *, tenant_id: int) -> dict[str, int]:
    rows = conn.execute(
        select(departments.c.id, departments.c.code).where(
            departments.c.tenant_id == tenant_id
        )
    ).all()
    return {str(r.code): int(r.id) for r in rows}


def _ensure_department(
    conn: Connection, *, tenant_id: int, code: str, name: str
) -> int:
    """Get-or-create. Provisioning seeds ENG/OPS so this is normally a no-op."""

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


def _seed_users(
    conn: Connection,
    *,
    slug: str,
    tenant_id: int,
    role_ids: dict[str, int],
    dept_ids: dict[str, int],
    counts: Counts,
) -> None:
    for spec in USERS_BY_TENANT[slug]:
        email = spec["email"].lower()
        existing = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == tenant_id,
                users.c.email == email,
            )
        ).scalar_one_or_none()
        if existing is not None:
            counts.skipped_users += 1
            logger.info("skip user (exists): %s", email)
            continue

        password_hash = hash_password(TENANT_PASSWORD)
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=tenant_id,
                    email=email,
                    password_hash=password_hash,
                    full_name=spec["full_name"],
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )

        for role_code in spec["roles"]:
            rid = role_ids.get(role_code)
            if rid is None:
                msg = f"role {role_code!r} missing in {slug} for {email}"
                counts.errors.append(msg)
                logger.warning(msg)
                continue
            conn.execute(
                insert(user_roles).values(
                    user_id=user_id,
                    role_id=rid,
                    tenant_id=tenant_id,
                )
            )

        for dept_code in spec["departments"]:
            did = dept_ids.get(dept_code)
            if did is None:
                msg = f"department {dept_code!r} missing in {slug} for {email}"
                counts.errors.append(msg)
                logger.warning(msg)
                continue
            conn.execute(
                insert(user_departments).values(
                    user_id=user_id,
                    department_id=did,
                    tenant_id=tenant_id,
                )
            )

        counts.created_users += 1
        logger.info("created user: %s (id=%d)", email, user_id)


def _seed_employees(
    conn: Connection,
    *,
    slug: str,
    tenant_id: int,
    dept_ids: dict[str, int],
    counts: Counts,
) -> None:
    for spec in EMPLOYEES_BY_TENANT[slug]:
        code = spec["code"]
        existing = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == tenant_id,
                employees.c.employee_code == code,
            )
        ).scalar_one_or_none()
        if existing is not None:
            counts.skipped_employees += 1
            logger.info("skip employee (exists): %s", code)
            continue

        did = dept_ids.get(spec["department"])
        if did is None:
            msg = (
                f"department {spec['department']!r} missing for employee "
                f"{code} in {slug}"
            )
            counts.errors.append(msg)
            logger.warning(msg)
            continue

        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=tenant_id,
                    employee_code=code,
                    full_name=spec["full_name"],
                    email=spec["email"].lower(),
                    department_id=did,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        counts.created_employees += 1
        logger.info("created employee: %s (id=%d)", code, emp_id)


def _seed_one_tenant(engine: Engine, *, slug: str, counts: Counts) -> None:
    """Drive one tenant through users + employees, in one transaction."""

    if slug not in USERS_BY_TENANT:
        msg = f"unknown tenant slug: {slug!r}"
        counts.errors.append(msg)
        logger.error(msg)
        return

    # Resolve the tenant_id from public.tenants under the public schema.
    with tenant_context("public"):
        with engine.begin() as conn:
            tenant_id = conn.execute(
                select(tenants.c.id).where(tenants.c.schema_name == slug)
            ).scalar_one_or_none()

    if tenant_id is None:
        msg = (
            f"tenant {slug!r} not found in public.tenants — provision it first "
            f"(scripts.provision_tenant)"
        )
        counts.errors.append(msg)
        logger.error(msg)
        return

    tenant_id = int(tenant_id)
    logger.info("=== seeding %s (tenant_id=%d) ===", slug, tenant_id)

    # All per-tenant DB ops happen under the tenant's schema.
    with tenant_context(slug):
        with engine.begin() as conn:
            for code, name in _DEPARTMENT_DEFAULTS:
                _ensure_department(
                    conn, tenant_id=tenant_id, code=code, name=name
                )
            role_ids = _resolve_role_ids(conn, tenant_id=tenant_id)
            dept_ids = _resolve_department_ids(conn, tenant_id=tenant_id)
            _seed_users(
                conn,
                slug=slug,
                tenant_id=tenant_id,
                role_ids=role_ids,
                dept_ids=dept_ids,
                counts=counts,
            )
            _seed_employees(
                conn,
                slug=slug,
                tenant_id=tenant_id,
                dept_ids=dept_ids,
                counts=counts,
            )


def _seed_super_admins(engine: Engine, *, counts: Counts) -> None:
    logger.info("=== seeding super-admins (public.mts_staff) ===")
    with tenant_context("public"):
        with engine.begin() as conn:
            for spec in SUPER_ADMINS:
                email = spec["email"].lower()
                existing = conn.execute(
                    select(mts_staff.c.id).where(mts_staff.c.email == email)
                ).scalar_one_or_none()
                if existing is not None:
                    counts.skipped_super_admins += 1
                    logger.info("skip super-admin (exists): %s", email)
                    continue
                password_hash = hash_password(SUPER_PASSWORD)
                staff_id = int(
                    conn.execute(
                        insert(mts_staff)
                        .values(
                            email=email,
                            password_hash=password_hash,
                            full_name=spec["full_name"],
                            is_active=True,
                        )
                        .returning(mts_staff.c.id)
                    ).scalar_one()
                )
                counts.created_super_admins += 1
                logger.info("created super-admin: %s (id=%d)", email, staff_id)


# --------------------------------------------------------------------------
# Entrypoint
# --------------------------------------------------------------------------


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed M2 test accounts.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--tenant",
        help="Single tenant slug to seed (e.g. tenant_omran).",
    )
    target.add_argument(
        "--all",
        action="store_true",
        help="Seed both tenant_omran and tenant_demo.",
    )
    parser.add_argument(
        "--skip-super-admins",
        action="store_true",
        help="Skip the public.mts_staff seed step (default: always seed).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="[seed] %(message)s")
    args = _parse_args(argv)

    if args.all:
        slugs = ["tenant_omran", "tenant_demo"]
    else:
        slugs = [args.tenant]

    counts = Counts()
    engine = make_admin_engine()
    try:
        for slug in slugs:
            _seed_one_tenant(engine, slug=slug, counts=counts)
        if not args.skip_super_admins:
            _seed_super_admins(engine, counts=counts)
    finally:
        engine.dispose()

    logger.info(
        "summary: users=%d created / %d skipped, "
        "employees=%d created / %d skipped, "
        "super_admins=%d created / %d skipped, "
        "errors=%d",
        counts.created_users,
        counts.skipped_users,
        counts.created_employees,
        counts.skipped_employees,
        counts.created_super_admins,
        counts.skipped_super_admins,
        len(counts.errors),
    )
    if counts.errors:
        logger.error("error details:")
        for msg in counts.errors:
            logger.error("  - %s", msg)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
