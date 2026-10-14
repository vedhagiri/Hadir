"""GET /api/audit-log — Admin-only read of the append-only audit table.

Read-only by design. ``audit_log`` is append-only at the DB grant level
(``maugood_app`` holds INSERT + SELECT only); this module never issues
UPDATE / DELETE. The only write it performs is the INSERT of a single
``audit_log.exported`` row when an Admin downloads the CSV — the same
"every export is audited" convention as ``camera.exported``.

Endpoints:

* ``GET /api/audit-log`` — paginated list with filters (actor, action,
  entity, date range, free text, category, summary-tile kind, hide
  routine). Each item carries its classified ``category`` /
  ``severity`` / ``is_routine`` and a readable ``entity_label`` when
  the target row still exists.
* ``GET /api/audit-log/summary`` — counts for the selected range
  (total / security / sign-in failures / data changes / system /
  routine-hidden + per-category) for the page's summary tiles.
* ``GET /api/audit-log/actors`` — every user that appears in this
  tenant's log (for the Actor dropdown; no ids typed by hand).
* ``GET /api/audit-log/export.csv`` — CSV of the current filtered view,
  capped at ``EXPORT_MAX_ROWS``.

Every query filters ``WHERE audit_log.tenant_id = :scope`` on top of
the request's ``search_path`` (set by ``TenantScopeMiddleware``).
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import String, Text, and_, case, cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.engine import Connection

from maugood.audit_log import catalog
from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.db import (
    attendance_devices,
    audit_log,
    cameras,
    departments,
    divisions,
    employees,
    get_engine,
    holidays,
    leave_types,
    sections,
    shift_policies,
    users,
)
from maugood.tenants.scope import TenantScope

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])

ADMIN = Depends(require_role("Admin"))

EXPORT_MAX_ROWS = 50_000
Q_MAX_LEN = 120

# Payload keys whose values are secrets (session ids ARE the opaque
# session token). Redacted on every read path — list, CSV — and excluded
# from free-text search so the search box can't be used as an oracle.
# Stored rows are never modified (append-only).
REDACTED = "[redacted]"
_SENSITIVE_KEY_RE = re.compile(
    r"^(session|session_id|token|.*_token|password.*|secret.*|.*_secret|"
    r"api_key|rtsp_url|authorization|cookie)$",
    re.IGNORECASE,
)
_SEARCH_STRIP_KEYS = [
    "session", "session_id", "token", "push_token", "refresh_token",
    "access_token", "id_token", "password", "password_hash", "secret",
    "client_secret", "api_key", "rtsp_url", "authorization", "cookie",
]


def redact(value: Any) -> Any:
    """Return a copy of a JSON payload with sensitive values replaced."""

    if isinstance(value, dict):
        return {
            k: (REDACTED if isinstance(k, str) and _SENSITIVE_KEY_RE.match(k) and v is not None else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


class AuditEntryOut(BaseModel):
    id: int
    created_at: datetime
    actor_user_id: Optional[int] = None
    actor_email: Optional[str] = None
    actor_name: Optional[str] = None
    actor_label: Optional[str] = None
    action: str
    entity_type: str
    entity_id: Optional[str] = None
    entity_label: Optional[str] = None
    category: str = "other"
    severity: str = "info"
    is_routine: bool = False
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None


class AuditListOut(BaseModel):
    items: list[AuditEntryOut]
    total: int
    page: int
    page_size: int
    distinct_actions: list[str]
    distinct_entity_types: list[str]


class AuditSummaryOut(BaseModel):
    total: int
    security: int
    failures: int
    changes: int
    system: int
    routine_hidden: int
    by_category: dict[str, int]


class AuditActorOut(BaseModel):
    id: int
    email: str
    full_name: str
    events: int


class AuditActorsOut(BaseModel):
    items: list[AuditActorOut]
    system_events: int


# ---------------------------------------------------------------------------
# Filter plumbing
# ---------------------------------------------------------------------------


@dataclass
class _Filters:
    actor_user_id: Optional[int] = None
    actor: Optional[str] = None  # "system" → actor_user_id IS NULL
    action: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    q: Optional[str] = None
    q_action: tuple[str, ...] = ()
    category: tuple[str, ...] = ()
    kind: Optional[str] = None
    hide_routine: bool = False


def _filters_dep(
    actor_user_id: Annotated[Optional[int], Query()] = None,
    actor: Annotated[Optional[str], Query(pattern="^system$")] = None,
    action: Annotated[Optional[str], Query(max_length=200)] = None,
    entity_type: Annotated[Optional[str], Query(max_length=100)] = None,
    entity_id: Annotated[Optional[str], Query(max_length=100)] = None,
    start: Annotated[Optional[datetime], Query()] = None,
    end: Annotated[Optional[datetime], Query()] = None,
    q: Annotated[Optional[str], Query(max_length=Q_MAX_LEN)] = None,
    q_action: Annotated[Optional[list[str]], Query(max_length=300)] = None,
    category: Annotated[Optional[list[str]], Query()] = None,
    kind: Annotated[Optional[str], Query()] = None,
    hide_routine: Annotated[bool, Query()] = False,
) -> _Filters:
    cats = tuple(c for c in (category or []) if c)
    bad = [c for c in cats if c not in catalog.CATEGORIES]
    if bad:
        raise HTTPException(status_code=400, detail={"field": "category", "invalid": bad})
    if kind is not None and kind not in catalog.KINDS:
        raise HTTPException(status_code=400, detail={"field": "kind", "invalid": kind})
    return _Filters(
        actor_user_id=actor_user_id,
        actor=actor,
        action=action or None,
        entity_type=entity_type or None,
        entity_id=entity_id or None,
        start=start,
        end=end,
        q=(q or "").strip() or None,
        q_action=tuple(a for a in (q_action or []) if a)[:300],
        category=cats,
        kind=kind,
        hide_routine=hide_routine,
    )


FiltersDep = Annotated[_Filters, Depends(_filters_dep)]


def _distinct_actions(conn: Connection, tenant_id: int) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            select(audit_log.c.action)
            .where(audit_log.c.tenant_id == tenant_id)
            .distinct()
            .order_by(audit_log.c.action.asc())
        ).all()
    ]


def _strip(col: Any, keys: Any) -> Any:
    """``col - keys`` for JSON objects only (``-`` errors on scalars)."""

    return case((func.jsonb_typeof(col) == "object", col.op("-")(keys)), else_=col)


def _like_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _conditions(
    f: _Filters,
    tenant_id: int,
    actions: list[str],
    *,
    include_kind: bool = True,
    include_routine: bool = True,
) -> list[Any]:
    """WHERE clauses for a filter set. Category / kind / routine
    filters are resolved against the tenant's distinct action list
    (pure ``catalog`` classification) into explicit ``action IN``
    lists so the SQL stays index-friendly and exact."""

    conds: list[Any] = [audit_log.c.tenant_id == tenant_id]
    if f.actor == "system":
        conds.append(audit_log.c.actor_user_id.is_(None))
    elif f.actor_user_id is not None:
        conds.append(audit_log.c.actor_user_id == f.actor_user_id)
    if f.action:
        conds.append(audit_log.c.action == f.action)
    if f.entity_type:
        conds.append(audit_log.c.entity_type == f.entity_type)
    if f.entity_id:
        conds.append(audit_log.c.entity_id == f.entity_id)
    if f.start is not None:
        conds.append(audit_log.c.created_at >= f.start)
    if f.end is not None:
        conds.append(audit_log.c.created_at <= f.end)
    if f.category:
        conds.append(
            audit_log.c.action.in_(catalog.actions_in_categories(actions, f.category))
        )
    if include_routine and f.hide_routine:
        routine = catalog.routine_actions(actions)
        if routine:
            conds.append(audit_log.c.action.not_in(routine))
    if include_kind and f.kind:
        if f.kind == "system":
            conds.append(audit_log.c.actor_user_id.is_(None))
        else:
            pick = {
                "security": lambda a: catalog.category_of(a) == "security",
                "failures": catalog.is_failure,
                "changes": catalog.is_change,
            }[f.kind]
            conds.append(audit_log.c.action.in_([a for a in actions if pick(a)]))
    if f.q:
        needle = f"%{_like_escape(f.q)}%"
        strip_keys = cast(literal(_SEARCH_STRIP_KEYS, ARRAY(Text)), ARRAY(Text))
        matching_actors = (
            select(users.c.id)
            .where(users.c.tenant_id == tenant_id)
            .where(
                or_(
                    users.c.email.ilike(needle, escape="\\"),
                    users.c.full_name.ilike(needle, escape="\\"),
                )
            )
        )
        ors: list[Any] = [
            audit_log.c.action.ilike(needle, escape="\\"),
            audit_log.c.entity_type.ilike(needle, escape="\\"),
            audit_log.c.entity_id.ilike(needle, escape="\\"),
            audit_log.c.actor_user_id.in_(matching_actors),
            cast(_strip(audit_log.c.before, strip_keys), String).ilike(needle, escape="\\"),
            cast(_strip(audit_log.c.after, strip_keys), String).ilike(needle, escape="\\"),
        ]
        if f.q_action:
            ors.append(audit_log.c.action.in_(list(f.q_action)))
        conds.append(or_(*ors))
    return conds


def _list_select(tenant_id: int):  # type: ignore[no-untyped-def]
    return select(
        audit_log.c.id,
        audit_log.c.created_at,
        audit_log.c.actor_user_id,
        audit_log.c.actor_label,
        users.c.email.label("actor_email"),
        users.c.full_name.label("actor_name"),
        audit_log.c.action,
        audit_log.c.entity_type,
        audit_log.c.entity_id,
        audit_log.c.before,
        audit_log.c.after,
    ).select_from(
        audit_log.outerjoin(
            users,
            and_(
                users.c.id == audit_log.c.actor_user_id,
                users.c.tenant_id == tenant_id,
            ),
        )
    )


# entity_type → (table, label column). Only tables carrying tenant_id.
_ENTITY_TABLES = {
    "employee": (employees, employees.c.full_name),
    "user": (users, users.c.full_name),
    "camera": (cameras, cameras.c.name),
    "department": (departments, departments.c.name),
    "division": (divisions, divisions.c.name),
    "section": (sections, sections.c.name),
    "shift_policy": (shift_policies, shift_policies.c.name),
    "device": (attendance_devices, attendance_devices.c.name),
    "holiday": (holidays, holidays.c.name),
    "leave_type": (leave_types, leave_types.c.name),
}


def _entity_labels(conn: Connection, tenant_id: int, rows: list[Any]) -> dict[tuple[str, str], str]:
    """Batch-resolve readable names for the page's entities (≤ page_size
    ids per type, one query per type)."""

    wanted: dict[str, set[int]] = {}
    for r in rows:
        if r.entity_type in _ENTITY_TABLES and r.entity_id and str(r.entity_id).isdigit():
            wanted.setdefault(r.entity_type, set()).add(int(r.entity_id))
    out: dict[tuple[str, str], str] = {}
    for etype, ids in wanted.items():
        table, col = _ENTITY_TABLES[etype]
        for rid, name in conn.execute(
            select(table.c.id, col).where(
                table.c.tenant_id == tenant_id, table.c.id.in_(list(ids))
            )
        ).all():
            if name:
                out[(etype, str(rid))] = str(name)
    return out


def _payload_label(before: Any, after: Any) -> Optional[str]:
    for blob in (after, before):
        if isinstance(blob, dict):
            for key in ("full_name", "name", "display_name"):
                v = blob.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    return None


def _to_item(r: Any, labels: dict[tuple[str, str], str]) -> AuditEntryOut:
    action = str(r.action)
    eid = str(r.entity_id) if r.entity_id is not None else None
    label = labels.get((str(r.entity_type), eid or "")) or _payload_label(r.before, r.after)
    return AuditEntryOut(
        id=int(r.id),
        created_at=r.created_at,
        actor_user_id=int(r.actor_user_id) if r.actor_user_id is not None else None,
        actor_email=str(r.actor_email) if r.actor_email is not None else None,
        actor_name=str(r.actor_name) if r.actor_name is not None else None,
        actor_label=str(r.actor_label) if r.actor_label is not None else None,
        action=action,
        entity_type=str(r.entity_type),
        entity_id=eid,
        entity_label=label,
        category=catalog.category_of(action),
        severity=catalog.severity_of(action),
        is_routine=catalog.is_routine(action),
        before=redact(r.before),
        after=redact(r.after),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=AuditListOut)
def list_audit(
    user: Annotated[CurrentUser, ADMIN],
    f: FiltersDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 100,
) -> AuditListOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    with get_engine().begin() as conn:
        actions = _distinct_actions(conn, scope.tenant_id)
        conds = _conditions(f, scope.tenant_id, actions)
        total = int(
            conn.execute(
                select(func.count()).select_from(audit_log).where(*conds)
            ).scalar_one()
        )
        rows = conn.execute(
            _list_select(scope.tenant_id)
            .where(*conds)
            .order_by(audit_log.c.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
        labels = _entity_labels(conn, scope.tenant_id, rows)
        distinct_entity_types = [
            r[0]
            for r in conn.execute(
                select(audit_log.c.entity_type)
                .where(audit_log.c.tenant_id == scope.tenant_id)
                .distinct()
                .order_by(audit_log.c.entity_type.asc())
            ).all()
        ]

    return AuditListOut(
        items=[_to_item(r, labels) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
        distinct_actions=actions,
        distinct_entity_types=distinct_entity_types,
    )


@router.get("/summary", response_model=AuditSummaryOut)
def audit_summary(user: Annotated[CurrentUser, ADMIN], f: FiltersDep) -> AuditSummaryOut:
    """Counts for the summary tiles. Honours every filter except the
    tile ``kind`` itself (so clicking a tile doesn't zero the others)
    and reports how many routine rows the hide-routine toggle hides."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        actions = _distinct_actions(conn, scope.tenant_id)
        conds = _conditions(
            f, scope.tenant_id, actions, include_kind=False, include_routine=False
        )
        is_system = audit_log.c.actor_user_id.is_(None)
        grouped = conn.execute(
            select(audit_log.c.action, is_system.label("sys"), func.count().label("n"))
            .where(*conds)
            .group_by(audit_log.c.action, is_system)
        ).all()

    out = AuditSummaryOut(
        total=0, security=0, failures=0, changes=0, system=0, routine_hidden=0,
        by_category={c: 0 for c in catalog.CATEGORIES},
    )
    for action, sys_flag, n in grouped:
        n = int(n)
        if f.hide_routine and catalog.is_routine(action):
            out.routine_hidden += n
            continue
        out.total += n
        cat = catalog.category_of(action)
        out.by_category[cat] = out.by_category.get(cat, 0) + n
        if cat == "security":
            out.security += n
        if catalog.is_failure(action):
            out.failures += n
        if catalog.is_change(action):
            out.changes += n
        if sys_flag:
            out.system += n
    return out


@router.get("/actors", response_model=AuditActorsOut)
def audit_actors(user: Annotated[CurrentUser, ADMIN]) -> AuditActorsOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        counts = conn.execute(
            select(audit_log.c.actor_user_id, func.count().label("n"))
            .where(audit_log.c.tenant_id == scope.tenant_id)
            .group_by(audit_log.c.actor_user_id)
        ).all()
        by_id = {int(a): int(n) for a, n in counts if a is not None}
        system_events = sum(int(n) for a, n in counts if a is None)
        rows = (
            conn.execute(
                select(users.c.id, users.c.email, users.c.full_name)
                .where(users.c.tenant_id == scope.tenant_id, users.c.id.in_(list(by_id)))
                .order_by(users.c.full_name.asc())
            ).all()
            if by_id
            else []
        )
    return AuditActorsOut(
        items=[
            AuditActorOut(
                id=int(r.id), email=str(r.email), full_name=str(r.full_name), events=by_id.get(int(r.id), 0)
            )
            for r in rows
        ],
        system_events=system_events,
    )


_CSV_COLUMNS = (
    "id",
    "time_utc",
    "actor_email",
    "actor_name",
    "action",
    "description",
    "category",
    "severity",
    "entity_type",
    "entity_id",
    "entity_label",
    "before",
    "after",
)


def _csv_cell(value: Any) -> str:
    """Neutralise spreadsheet formula injection (CSV injection)."""

    s = "" if value is None else str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


@router.get("/export.csv")
def export_audit_csv(user: Annotated[CurrentUser, ADMIN], f: FiltersDep) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        actions = _distinct_actions(conn, scope.tenant_id)
        conds = _conditions(f, scope.tenant_id, actions)
        rows = conn.execute(
            _list_select(scope.tenant_id)
            .where(*conds)
            .order_by(audit_log.c.id.desc())
            .limit(EXPORT_MAX_ROWS + 1)
        ).all()
        truncated = len(rows) > EXPORT_MAX_ROWS
        rows = rows[:EXPORT_MAX_ROWS]
        labels = _entity_labels(conn, scope.tenant_id, rows[:2000])
        # Append-only INSERT (the established "exports are audited" rule).
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="audit_log.exported",
            entity_type="audit_log",
            entity_id=None,
            after={
                "rows": len(rows),
                "truncated": truncated,
                "filters": {
                    "actor_user_id": f.actor_user_id,
                    "actor": f.actor,
                    "action": f.action,
                    "entity_type": f.entity_type,
                    "start": f.start.isoformat() if f.start else None,
                    "end": f.end.isoformat() if f.end else None,
                    "q": f.q,
                    "category": list(f.category),
                    "kind": f.kind,
                    "hide_routine": f.hide_routine,
                },
            },
        )

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_CSV_COLUMNS)
    for r in rows:
        item = _to_item(r, labels)
        w.writerow(
            [
                _csv_cell(v)
                for v in (
                    item.id,
                    item.created_at.astimezone(timezone.utc).isoformat(),
                    item.actor_email or (item.actor_label or "system"),
                    item.actor_name,
                    item.action,
                    catalog.humanize(item.action),
                    item.category,
                    item.severity,
                    item.entity_type,
                    item.entity_id,
                    item.entity_label,
                    json.dumps(item.before, default=str) if item.before is not None else "",
                    json.dumps(item.after, default=str) if item.after is not None else "",
                )
            ]
        )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return Response(
        content="﻿" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="maugood-audit-log-{stamp}.csv"',
            "X-Export-Truncated": "true" if truncated else "false",
            "X-Export-Rows": str(len(rows)),
            "Access-Control-Expose-Headers": "X-Export-Truncated, X-Export-Rows",
        },
    )
