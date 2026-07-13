"""Entra sync logic — provision/update ``users`` from the directory.

Pure-ish: takes an open ``Connection`` (already tenant-scoped) + a
directory client, and does the upsert. Callers own the transaction and
the audit row.

Role assignment (the "roles from groups" choice): a user's mapped roles
come from ``entra_group_role_map`` matched against their group ids.
**Manual override always wins** — sync only assigns mapped roles to a
user that currently has *no* role (new or unassigned); a user an admin
has already given a role keeps it across syncs.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.engine import Connection

from maugood.auth.passwords import hash_password
from maugood.db import (
    departments,
    employees,
    entra_group_role_map,
    roles,
    user_roles,
    users,
)

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SyncResult:
    added: int = 0
    updated: int = 0
    failed: int = 0
    # How many users were given the ``default_role`` because they had no
    # group-mapped role and no manually-assigned role. Surfaced in the
    # sync-confirmation result so the operator sees the effect.
    default_role_assigned: int = 0
    # How many linked employee records were created (``create_employees``).
    employees_created: int = 0
    errors: list[str] = field(default_factory=list)


# Fallback department for synced employees whose AD ``department`` doesn't
# match any existing Maugood department (department_id is NOT NULL).
_FALLBACK_DEPT_CODE = "AD_SYNC"


def _match_department_id(
    conn: Connection, *, tenant_id: int, ad_department: str | None
) -> int | None:
    """Match an AD department string to a Maugood department by code or
    name (case-insensitive). None when there's nothing to match."""

    name = (ad_department or "").strip()
    if not name:
        return None
    row = conn.execute(
        select(departments.c.id).where(
            departments.c.tenant_id == tenant_id,
            or_(
                func.lower(departments.c.code) == name.lower(),
                func.lower(departments.c.name) == name.lower(),
            ),
        )
    ).first()
    return int(row.id) if row is not None else None


def _ensure_fallback_department(conn: Connection, *, tenant_id: int) -> int:
    """Return the ``AD_SYNC`` department id, creating it once if absent."""

    row = conn.execute(
        select(departments.c.id).where(
            departments.c.tenant_id == tenant_id,
            departments.c.code == _FALLBACK_DEPT_CODE,
        )
    ).first()
    if row is not None:
        return int(row.id)
    return int(
        conn.execute(
            insert(departments)
            .values(
                tenant_id=tenant_id,
                code=_FALLBACK_DEPT_CODE,
                name="AD Sync (Unassigned)",
            )
            .returning(departments.c.id)
        ).scalar_one()
    )


def load_group_role_map(conn: Connection, *, tenant_id: int) -> dict[str, str]:
    """group_id → role_code for this tenant."""

    rows = conn.execute(
        select(
            entra_group_role_map.c.group_id, entra_group_role_map.c.role_code
        ).where(entra_group_role_map.c.tenant_id == tenant_id)
    ).all()
    return {str(r.group_id): str(r.role_code) for r in rows}


def roles_for_groups(
    group_ids: tuple[str, ...], mapping: dict[str, str]
) -> list[str]:
    """Distinct Maugood role codes for a user's group ids."""

    out: list[str] = []
    for gid in group_ids:
        code = mapping.get(gid)
        if code and code not in out:
            out.append(code)
    return out


def _role_code_to_id(conn: Connection, *, tenant_id: int) -> dict[str, int]:
    rows = conn.execute(
        select(roles.c.id, roles.c.code).where(roles.c.tenant_id == tenant_id)
    ).all()
    return {str(r.code): int(r.id) for r in rows}


def _user_has_roles(conn: Connection, *, tenant_id: int, user_id: int) -> bool:
    return (
        conn.execute(
            select(user_roles.c.role_id).where(
                user_roles.c.tenant_id == tenant_id,
                user_roles.c.user_id == user_id,
            )
        ).first()
        is not None
    )


def _assign_roles(
    conn: Connection,
    *,
    tenant_id: int,
    user_id: int,
    role_codes: list[str],
    role_id_by_code: dict[str, int],
) -> None:
    conn.execute(
        delete(user_roles).where(
            user_roles.c.tenant_id == tenant_id,
            user_roles.c.user_id == user_id,
        )
    )
    for code in role_codes:
        rid = role_id_by_code.get(code)
        if rid is None:
            continue
        conn.execute(
            insert(user_roles).values(
                tenant_id=tenant_id, user_id=user_id, role_id=rid
            )
        )


def sync_users(
    conn: Connection,
    *,
    tenant_id: int,
    graph_users: list[Any],
    default_role: str | None = None,
    create_employees: bool = False,
) -> SyncResult:
    """Provision/update Maugood users from pre-fetched directory users.

    ``graph_users`` is a list of ``GraphUser`` with ``group_ids``
    already populated (the caller does the network fetch outside the
    DB transaction so it isn't held open during Graph paging).

    ``default_role`` (e.g. ``"Employee"``): when a user has no
    group-mapped role, fall back to this role. It is applied only to
    users that currently have **no** role — a manually-set role always
    wins (same guard as the mapped-role path, the load-bearing AD-sync
    red line). ``None`` keeps the legacy behaviour (no fallback).

    ``create_employees``: when True, also ensure an ``employees`` row
    exists for each synced user, linked by lower-cased email. Existing
    employees are left untouched (never clobber manual HR edits); a new
    one is created active, with department resolved from the AD
    department (falling back to an ``AD_SYNC`` department) and a
    generated ``AD####`` employee code.
    """

    result = SyncResult()
    mapping = load_group_role_map(conn, tenant_id=tenant_id)
    role_id_by_code = _role_code_to_id(conn, tenant_id=tenant_id)
    # Ignore an unknown default role rather than silently assigning
    # nothing later — the router validates against the four codes, but
    # defence in depth keeps this pure function honest.
    if default_role is not None and default_role not in role_id_by_code:
        default_role = None
    now = datetime.now(tz=timezone.utc)

    # Employee-creation scratch state (only touched when create_employees).
    # ``code_pool`` seeds from existing codes so a generated AD#### never
    # collides; ``_fallback`` is resolved lazily so we don't create the
    # AD_SYNC department unless a user actually needs it.
    code_pool: set[str] = (
        {
            str(r.employee_code)
            for r in conn.execute(
                select(employees.c.employee_code).where(
                    employees.c.tenant_id == tenant_id
                )
            ).all()
        }
        if create_employees
        else set()
    )
    code_counter = {"n": 0}
    fallback_dept: dict[str, int] = {}

    def _next_employee_code() -> str:
        while True:
            code_counter["n"] += 1
            cand = f"AD{code_counter['n']:04d}"
            if cand not in code_pool:
                code_pool.add(cand)
                return cand

    def _fallback_department_id() -> int:
        if "id" not in fallback_dept:
            fallback_dept["id"] = _ensure_fallback_department(
                conn, tenant_id=tenant_id
            )
        return fallback_dept["id"]

    def _ensure_employee(
        email: str, full_name: str, job_title: str, ad_department: str
    ) -> bool:
        existing_emp = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == tenant_id,
                func.lower(employees.c.email) == email,
            )
        ).first()
        if existing_emp is not None:
            return False  # link exists; don't clobber HR-edited data
        dept_id = _match_department_id(
            conn, tenant_id=tenant_id, ad_department=ad_department
        )
        if dept_id is None:
            dept_id = _fallback_department_id()
        conn.execute(
            insert(employees).values(
                tenant_id=tenant_id,
                employee_code=_next_employee_code(),
                full_name=full_name or email,
                email=email,
                department_id=dept_id,
                status="active",
                designation=(job_title or None),
            )
        )
        return True

    for gu in graph_users:
        try:
            email = gu.email.strip().lower()
            if not email:
                result.failed += 1
                result.errors.append(f"{gu.display_name or gu.object_id}: no email")
                continue

            mapped_roles = roles_for_groups(tuple(gu.group_ids), mapping)
            # A group mapping always wins; the default is a fallback only
            # for users no group maps to a role.
            using_default = not mapped_roles and default_role is not None
            effective_roles = (
                mapped_roles if mapped_roles else ([default_role] if using_default else [])
            )
            ad_status = "active" if gu.account_enabled else "disabled"

            # Match: existing entra link first, then a pre-existing user
            # by email (so a local account gets linked, not duplicated).
            existing = conn.execute(
                select(users.c.id).where(
                    users.c.tenant_id == tenant_id,
                    users.c.ms_object_id == gu.object_id,
                )
            ).first()
            if existing is None:
                existing = conn.execute(
                    select(users.c.id).where(
                        users.c.tenant_id == tenant_id, users.c.email == email
                    )
                ).first()

            ad_values = {
                "full_name": gu.display_name or email,
                "upn": gu.upn or None,
                "job_title": gu.job_title or None,
                "ad_department": gu.department or None,
                "ad_status": ad_status,
                "ms_object_id": gu.object_id,
                "source": "entra",
                "last_synced_at": now,
            }

            if existing is not None:
                uid = int(existing.id)
                conn.execute(
                    update(users)
                    .where(users.c.tenant_id == tenant_id, users.c.id == uid)
                    .values(**ad_values)
                )
                # Seed role (mapped, else default) only if the user has
                # none yet — never clobber a manually-set role.
                if effective_roles and not _user_has_roles(
                    conn, tenant_id=tenant_id, user_id=uid
                ):
                    _assign_roles(
                        conn,
                        tenant_id=tenant_id,
                        user_id=uid,
                        role_codes=effective_roles,
                        role_id_by_code=role_id_by_code,
                    )
                    if using_default:
                        result.default_role_assigned += 1
                result.updated += 1
            else:
                uid = int(
                    conn.execute(
                        insert(users)
                        .values(
                            tenant_id=tenant_id,
                            email=email,
                            # SSO-only: an unusable random hash so the
                            # NOT NULL column is satisfied and password
                            # login can never succeed for this account.
                            password_hash=hash_password(secrets.token_urlsafe(32)),
                            # New synced users land with access OFF — an
                            # admin grants sign-in explicitly.
                            is_active=False,
                            **ad_values,
                        )
                        .returning(users.c.id)
                    ).scalar_one()
                )
                if effective_roles:
                    _assign_roles(
                        conn,
                        tenant_id=tenant_id,
                        user_id=uid,
                        role_codes=effective_roles,
                        role_id_by_code=role_id_by_code,
                    )
                    if using_default:
                        result.default_role_assigned += 1
                result.added += 1

            # Optionally mirror the user into an employee record. A
            # failure here must not fail the user sync itself.
            if create_employees:
                try:
                    if _ensure_employee(
                        email,
                        gu.display_name or email,
                        gu.job_title or "",
                        gu.department or "",
                    ):
                        result.employees_created += 1
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "entra sync: employee link failed for %s", gu.object_id
                    )
        except Exception as exc:  # noqa: BLE001
            result.failed += 1
            result.errors.append(
                f"{gu.display_name or gu.object_id}: {type(exc).__name__}"
            )
            logger.warning(
                "entra sync: failed on user %s: %s",
                gu.object_id,
                type(exc).__name__,
            )

    return result
