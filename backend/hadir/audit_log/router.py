"""GET /api/audit-log — Admin-only read of the append-only audit table."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select

from hadir.auth.dependencies import CurrentUser, require_role
from hadir.db import audit_log, get_engine, users
from hadir.tenants.scope import TenantScope

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])

ADMIN = Depends(require_role("Admin"))


class AuditEntryOut(BaseModel):
    id: int
    created_at: datetime
    actor_user_id: Optional[int] = None
    actor_email: Optional[str] = None
    action: str
    entity_type: str
    entity_id: Optional[str] = None
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None


class AuditListOut(BaseModel):
    items: list[AuditEntryOut]
    total: int
    page: int
    page_size: int
    distinct_actions: list[str]
    distinct_entity_types: list[str]


@router.get("", response_model=AuditListOut)
def list_audit(
    user: Annotated[CurrentUser, ADMIN],
    actor_user_id: Annotated[Optional[int], Query()] = None,
    action: Annotated[Optional[str], Query()] = None,
    entity_type: Annotated[Optional[str], Query()] = None,
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 100,
) -> AuditListOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    base = (
        select(
            audit_log.c.id,
            audit_log.c.created_at,
            audit_log.c.actor_user_id,
            users.c.email.label("actor_email"),
            audit_log.c.action,
            audit_log.c.entity_type,
            audit_log.c.entity_id,
            audit_log.c.before,
            audit_log.c.after,
        )
        .select_from(
            audit_log.outerjoin(
                users,
                and_(
                    users.c.id == audit_log.c.actor_user_id,
                    users.c.tenant_id == audit_log.c.tenant_id,
                ),
            )
        )
        .where(audit_log.c.tenant_id == scope.tenant_id)
    )
    if actor_user_id is not None:
        base = base.where(audit_log.c.actor_user_id == actor_user_id)
    if action is not None:
        base = base.where(audit_log.c.action == action)
    if entity_type is not None:
        base = base.where(audit_log.c.entity_type == entity_type)
    if start is not None:
        base = base.where(audit_log.c.created_at >= start)
    if end is not None:
        base = base.where(audit_log.c.created_at <= end)

    with get_engine().begin() as conn:
        total = int(
            conn.execute(
                select(func.count()).select_from(base.subquery())
            ).scalar_one()
        )
        rows = conn.execute(
            base.order_by(audit_log.c.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()

        # Filter selectors — populate the dropdowns the UI shows.
        distinct_actions = [
            r[0]
            for r in conn.execute(
                select(audit_log.c.action)
                .where(audit_log.c.tenant_id == scope.tenant_id)
                .distinct()
                .order_by(audit_log.c.action.asc())
            ).all()
        ]
        distinct_entity_types = [
            r[0]
            for r in conn.execute(
                select(audit_log.c.entity_type)
                .where(audit_log.c.tenant_id == scope.tenant_id)
                .distinct()
                .order_by(audit_log.c.entity_type.asc())
            ).all()
        ]

    items = [
        AuditEntryOut(
            id=int(r.id),
            created_at=r.created_at,
            actor_user_id=(
                int(r.actor_user_id) if r.actor_user_id is not None else None
            ),
            actor_email=str(r.actor_email) if r.actor_email is not None else None,
            action=str(r.action),
            entity_type=str(r.entity_type),
            entity_id=str(r.entity_id) if r.entity_id is not None else None,
            before=r.before,
            after=r.after,
        )
        for r in rows
    ]
    return AuditListOut(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        distinct_actions=distinct_actions,
        distinct_entity_types=distinct_entity_types,
    )
