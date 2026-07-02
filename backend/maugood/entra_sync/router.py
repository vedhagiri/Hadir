"""AD Users API — Entra sync, group→role mapping, AD user list/detail.

All Admin-only. Role change + access toggle for a synced user reuse the
existing ``PATCH /api/users/{id}`` (role_codes + is_active).
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.auth.oidc import _load_secret as _load_oidc_secret
from maugood.auth.oidc import get_config as _get_oidc_config
from maugood.db import (
    entra_group_role_map,
    get_engine,
    roles,
    user_roles,
    users,
)
from maugood.entra_sync.graph import (
    GraphConfig,
    GraphError,
    build_directory_client,
)

_GRAPH_PERMS_HINT = (
    "Microsoft Graph denied the request (403). Add the APPLICATION "
    "permissions User.Read.All + GroupMember.Read.All to the Entra app "
    "under API permissions, click 'Grant admin consent', then retry."
)


def _graph_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, GraphError) and exc.status in (401, 403):
        return HTTPException(status_code=403, detail=_GRAPH_PERMS_HINT)
    return HTTPException(
        status_code=502,
        detail=(
            "Couldn't reach Microsoft Graph. Check the Entra app config "
            "and that it has User.Read.All + GroupMember.Read.All with "
            "admin consent."
        ),
    )
from maugood.entra_sync.service import sync_users

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/entra-sync", tags=["entra-sync"])

ADMIN = Depends(require_role("Admin"))

_VALID_ROLE_CODES = {"Admin", "HR", "Manager", "Employee"}


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


# ---------------------------------------------------------------------------
# Run sync
# ---------------------------------------------------------------------------


class SyncResultOut(BaseModel):
    added: int
    updated: int
    failed: int
    errors: list[str]


def _graph_config_for_tenant(tenant_id: int) -> GraphConfig:
    """Build the Graph config from the tenant's Entra OIDC config."""

    engine = get_engine()
    with engine.begin() as conn:
        cfg = _get_oidc_config(conn, tenant_id=tenant_id)
        secret = _load_oidc_secret(conn, tenant_id=tenant_id)
    if not cfg.entra_tenant_id or not cfg.client_id or not secret:
        raise HTTPException(
            status_code=400,
            detail=(
                "Microsoft (Entra) is not fully configured. Set the tenant "
                "ID, client ID and secret under Settings → Authentication first."
            ),
        )
    return GraphConfig(
        tenant_id=cfg.entra_tenant_id,
        client_id=cfg.client_id,
        client_secret=secret,
    )


@router.post("/run", response_model=SyncResultOut)
def run_sync(user: Annotated[CurrentUser, ADMIN]) -> SyncResultOut:
    """Pull directory users from Graph and provision/update Maugood users."""

    config = _graph_config_for_tenant(user.tenant_id)
    client = build_directory_client(config)

    # Network first (paged), outside the DB transaction.
    try:
        raw = client.list_users()
        graph_users = [
            replace(u, group_ids=tuple(client.list_user_group_ids(u.object_id)))
            for u in raw
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("entra sync: graph fetch failed: %s", exc)
        raise _graph_http_error(exc)

    engine = get_engine()
    with engine.begin() as conn:
        result = sync_users(
            conn, tenant_id=user.tenant_id, graph_users=graph_users
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="entra.sync.completed",
            entity_type="entra_sync",
            entity_id=None,
            after={
                "added": result.added,
                "updated": result.updated,
                "failed": result.failed,
            },
        )
    logger.info(
        "entra sync by admin=%s: +%d ~%d !%d",
        user.id,
        result.added,
        result.updated,
        result.failed,
    )
    return SyncResultOut(
        added=result.added,
        updated=result.updated,
        failed=result.failed,
        errors=result.errors[:20],
    )


# ---------------------------------------------------------------------------
# Entra groups (for the mapping picker)
# ---------------------------------------------------------------------------


class GroupOut(BaseModel):
    id: str
    name: str


@router.get("/groups", response_model=list[GroupOut])
def list_entra_groups(user: Annotated[CurrentUser, ADMIN]) -> list[GroupOut]:
    config = _graph_config_for_tenant(user.tenant_id)
    client = build_directory_client(config)
    try:
        groups = client.list_groups()
    except Exception as exc:  # noqa: BLE001
        logger.warning("entra groups fetch failed: %s", exc)
        raise _graph_http_error(exc)
    return [GroupOut(id=g.object_id, name=g.display_name) for g in groups]


# ---------------------------------------------------------------------------
# Group → role mapping CRUD
# ---------------------------------------------------------------------------


class GroupRoleEntry(BaseModel):
    group_id: str = Field(min_length=1, max_length=200)
    group_name: str = Field(default="", max_length=256)
    role_code: str

    def _check_role(self) -> None:
        if self.role_code not in _VALID_ROLE_CODES:
            raise HTTPException(
                status_code=422,
                detail=f"invalid role_code: {self.role_code}",
            )


class GroupRoleMapIn(BaseModel):
    entries: list[GroupRoleEntry] = Field(default_factory=list, max_length=100)


class GroupRoleMapOut(BaseModel):
    entries: list[GroupRoleEntry]


def _load_map(conn, tenant_id: int) -> list[GroupRoleEntry]:
    rows = conn.execute(
        select(
            entra_group_role_map.c.group_id,
            entra_group_role_map.c.group_name,
            entra_group_role_map.c.role_code,
        )
        .where(entra_group_role_map.c.tenant_id == tenant_id)
        .order_by(entra_group_role_map.c.group_name.asc())
    ).all()
    return [
        GroupRoleEntry(
            group_id=str(r.group_id),
            group_name=str(r.group_name or ""),
            role_code=str(r.role_code),
        )
        for r in rows
    ]


@router.get("/group-roles", response_model=GroupRoleMapOut)
def get_group_roles(user: Annotated[CurrentUser, ADMIN]) -> GroupRoleMapOut:
    with get_engine().begin() as conn:
        return GroupRoleMapOut(entries=_load_map(conn, user.tenant_id))


@router.put("/group-roles", response_model=GroupRoleMapOut)
def put_group_roles(
    payload: GroupRoleMapIn, user: Annotated[CurrentUser, ADMIN]
) -> GroupRoleMapOut:
    """Replace the whole group→role mapping for this tenant."""

    # Validate + dedupe by group_id (last wins).
    dedup: dict[str, GroupRoleEntry] = {}
    for e in payload.entries:
        e._check_role()
        dedup[e.group_id.strip()] = e

    engine = get_engine()
    with engine.begin() as conn:
        before = _load_map(conn, user.tenant_id)
        conn.execute(
            delete(entra_group_role_map).where(
                entra_group_role_map.c.tenant_id == user.tenant_id
            )
        )
        for e in dedup.values():
            conn.execute(
                insert(entra_group_role_map).values(
                    tenant_id=user.tenant_id,
                    group_id=e.group_id.strip(),
                    group_name=e.group_name.strip(),
                    role_code=e.role_code,
                )
            )
        after = _load_map(conn, user.tenant_id)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="entra.group_role.updated",
            entity_type="entra_group_role_map",
            entity_id=str(user.tenant_id),
            before={"entries": [e.model_dump() for e in before]},
            after={"entries": [e.model_dump() for e in after]},
        )
    return GroupRoleMapOut(entries=after)


# ---------------------------------------------------------------------------
# AD users list + detail
# ---------------------------------------------------------------------------


class AdUserOut(BaseModel):
    id: int
    full_name: str
    email: str
    upn: Optional[str]
    job_title: Optional[str]
    department: Optional[str]
    ms_object_id: Optional[str]
    ad_status: Optional[str]
    source: str
    is_active: bool
    role_codes: list[str]
    last_login_at: Optional[str]
    login_count: int
    auth_provider: Optional[str]
    last_synced_at: Optional[str]
    created_at: str


class AdUserListOut(BaseModel):
    items: list[AdUserOut]
    total: int
    enabled: int
    disabled: int


def _roles_by_user(conn, tenant_id: int, user_ids: list[int]) -> dict[int, list[str]]:
    if not user_ids:
        return {}
    rows = conn.execute(
        select(user_roles.c.user_id, roles.c.code)
        .select_from(user_roles.join(roles, roles.c.id == user_roles.c.role_id))
        .where(
            user_roles.c.tenant_id == tenant_id,
            user_roles.c.user_id.in_(user_ids),
        )
    ).all()
    out: dict[int, list[str]] = {}
    for r in rows:
        out.setdefault(int(r.user_id), []).append(str(r.code))
    for uid in out:
        out[uid].sort()
    return out


def _to_ad_user(row, role_codes: list[str]) -> AdUserOut:
    return AdUserOut(
        id=int(row.id),
        full_name=str(row.full_name),
        email=str(row.email),
        upn=(str(row.upn) if row.upn else None),
        job_title=(str(row.job_title) if row.job_title else None),
        department=(str(row.ad_department) if row.ad_department else None),
        ms_object_id=(str(row.ms_object_id) if row.ms_object_id else None),
        ad_status=(str(row.ad_status) if row.ad_status else None),
        source=str(row.source),
        is_active=bool(row.is_active),
        role_codes=role_codes,
        last_login_at=_iso(row.last_login_at),
        login_count=int(row.login_count or 0),
        auth_provider=(str(row.auth_provider) if row.auth_provider else None),
        last_synced_at=_iso(row.last_synced_at),
        created_at=row.created_at.isoformat(),
    )


_AD_COLS = (
    users.c.id,
    users.c.full_name,
    users.c.email,
    users.c.upn,
    users.c.job_title,
    users.c.ad_department,
    users.c.ms_object_id,
    users.c.ad_status,
    users.c.source,
    users.c.is_active,
    users.c.last_login_at,
    users.c.login_count,
    users.c.auth_provider,
    users.c.last_synced_at,
    users.c.created_at,
)


@router.get("/users", response_model=AdUserListOut)
def list_ad_users(user: Annotated[CurrentUser, ADMIN]) -> AdUserListOut:
    """Every Entra-sourced user, with roles + access + last login."""

    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(*_AD_COLS)
            .where(
                users.c.tenant_id == user.tenant_id,
                users.c.source == "entra",
            )
            .order_by(users.c.full_name.asc())
        ).all()
        roles_map = _roles_by_user(
            conn, user.tenant_id, [int(r.id) for r in rows]
        )
    items = [_to_ad_user(r, roles_map.get(int(r.id), [])) for r in rows]
    enabled = sum(1 for i in items if i.is_active)
    return AdUserListOut(
        items=items,
        total=len(items),
        enabled=enabled,
        disabled=len(items) - enabled,
    )


@router.get("/users/{user_id}", response_model=AdUserOut)
def get_ad_user(
    user_id: int, user: Annotated[CurrentUser, ADMIN]
) -> AdUserOut:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(*_AD_COLS).where(
                users.c.tenant_id == user.tenant_id, users.c.id == user_id
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        roles_map = _roles_by_user(conn, user.tenant_id, [int(row.id)])
    return _to_ad_user(row, roles_map.get(int(row.id), []))


class LoginActivityOut(BaseModel):
    user_id: int
    total_logins: int
    login_count: int
    last_login_at: Optional[str]
    auth_provider: Optional[str]
    is_active: bool
    created_by: str
    ms_object_id: Optional[str]


@router.get("/users/{user_id}/login-activity", response_model=LoginActivityOut)
def get_login_activity(
    user_id: int, user: Annotated[CurrentUser, ADMIN]
) -> LoginActivityOut:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(
                users.c.id,
                users.c.email,
                users.c.is_active,
                users.c.login_count,
                users.c.last_login_at,
                users.c.auth_provider,
                users.c.source,
                users.c.ms_object_id,
            ).where(
                users.c.tenant_id == user.tenant_id, users.c.id == user_id
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        # Cross-check against the audit log's success rows for this email.
        from maugood.db import audit_log  # noqa: PLC0415

        audit_count = conn.execute(
            select(func.count())
            .select_from(audit_log)
            .where(
                audit_log.c.tenant_id == user.tenant_id,
                audit_log.c.action.in_(
                    (
                        "auth.login.success",
                        "auth.oidc.login.success",
                        "auth.google.login.success",
                    )
                ),
                audit_log.c.entity_id == str(user_id),
            )
        ).scalar_one()
    return LoginActivityOut(
        user_id=int(row.id),
        total_logins=max(int(row.login_count or 0), int(audit_count or 0)),
        login_count=int(row.login_count or 0),
        last_login_at=_iso(row.last_login_at),
        auth_provider=(str(row.auth_provider) if row.auth_provider else None),
        is_active=bool(row.is_active),
        created_by=("AD Sync" if str(row.source) == "entra" else "Local"),
        ms_object_id=(str(row.ms_object_id) if row.ms_object_id else None),
    )
