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

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from maugood.auth.passwords import hash_password
from maugood.db import entra_group_role_map, roles, user_roles, users

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SyncResult:
    added: int = 0
    updated: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)


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
    conn: Connection, *, tenant_id: int, graph_users: list[Any]
) -> SyncResult:
    """Provision/update Maugood users from pre-fetched directory users.

    ``graph_users`` is a list of ``GraphUser`` with ``group_ids``
    already populated (the caller does the network fetch outside the
    DB transaction so it isn't held open during Graph paging).
    """

    result = SyncResult()
    mapping = load_group_role_map(conn, tenant_id=tenant_id)
    role_id_by_code = _role_code_to_id(conn, tenant_id=tenant_id)
    now = datetime.now(tz=timezone.utc)

    for gu in graph_users:
        try:
            email = gu.email.strip().lower()
            if not email:
                result.failed += 1
                result.errors.append(f"{gu.display_name or gu.object_id}: no email")
                continue

            mapped_roles = roles_for_groups(tuple(gu.group_ids), mapping)
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
                # Seed role from groups only if the user has none yet —
                # never clobber a manually-set role.
                if mapped_roles and not _user_has_roles(
                    conn, tenant_id=tenant_id, user_id=uid
                ):
                    _assign_roles(
                        conn,
                        tenant_id=tenant_id,
                        user_id=uid,
                        role_codes=mapped_roles,
                        role_id_by_code=role_id_by_code,
                    )
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
                if mapped_roles:
                    _assign_roles(
                        conn,
                        tenant_id=tenant_id,
                        user_id=uid,
                        role_codes=mapped_roles,
                        role_id_by_code=role_id_by_code,
                    )
                result.added += 1
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
