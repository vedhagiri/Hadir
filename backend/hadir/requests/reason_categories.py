"""DB access for the per-tenant request reason categories table.

The router calls these helpers; the table itself is seeded with the
BRD §FR-REQ-008 list by migration 0017 + the provisioning seed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import Connection

from hadir.db import request_reason_categories
from hadir.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class CategoryRow:
    id: int
    tenant_id: int
    request_type: str
    code: str
    name: str
    display_order: int
    active: bool


def _row_to_category(row) -> CategoryRow:  # type: ignore[no-untyped-def]
    return CategoryRow(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        request_type=str(row.request_type),
        code=str(row.code),
        name=str(row.name),
        display_order=int(row.display_order),
        active=bool(row.active),
    )


def list_categories(
    conn: Connection,
    scope: TenantScope,
    *,
    request_type: Optional[str] = None,
    include_inactive: bool = False,
) -> list[CategoryRow]:
    stmt = (
        select(
            request_reason_categories.c.id,
            request_reason_categories.c.tenant_id,
            request_reason_categories.c.request_type,
            request_reason_categories.c.code,
            request_reason_categories.c.name,
            request_reason_categories.c.display_order,
            request_reason_categories.c.active,
        )
        .where(request_reason_categories.c.tenant_id == scope.tenant_id)
        .order_by(
            request_reason_categories.c.request_type.asc(),
            request_reason_categories.c.display_order.asc(),
            request_reason_categories.c.id.asc(),
        )
    )
    if request_type is not None:
        stmt = stmt.where(
            request_reason_categories.c.request_type == request_type
        )
    if not include_inactive:
        stmt = stmt.where(request_reason_categories.c.active.is_(True))
    return [_row_to_category(r) for r in conn.execute(stmt).all()]


def get_category(
    conn: Connection, scope: TenantScope, category_id: int
) -> Optional[CategoryRow]:
    row = conn.execute(
        select(
            request_reason_categories.c.id,
            request_reason_categories.c.tenant_id,
            request_reason_categories.c.request_type,
            request_reason_categories.c.code,
            request_reason_categories.c.name,
            request_reason_categories.c.display_order,
            request_reason_categories.c.active,
        ).where(
            request_reason_categories.c.tenant_id == scope.tenant_id,
            request_reason_categories.c.id == category_id,
        )
    ).first()
    return _row_to_category(row) if row is not None else None


def get_category_by_code(
    conn: Connection,
    scope: TenantScope,
    *,
    request_type: str,
    code: str,
) -> Optional[CategoryRow]:
    row = conn.execute(
        select(
            request_reason_categories.c.id,
            request_reason_categories.c.tenant_id,
            request_reason_categories.c.request_type,
            request_reason_categories.c.code,
            request_reason_categories.c.name,
            request_reason_categories.c.display_order,
            request_reason_categories.c.active,
        ).where(
            request_reason_categories.c.tenant_id == scope.tenant_id,
            request_reason_categories.c.request_type == request_type,
            request_reason_categories.c.code == code,
        )
    ).first()
    return _row_to_category(row) if row is not None else None


def create_category(
    conn: Connection,
    scope: TenantScope,
    *,
    request_type: str,
    code: str,
    name: str,
) -> int:
    next_order = int(
        conn.execute(
            select(
                func.coalesce(
                    func.max(request_reason_categories.c.display_order), -1
                )
            ).where(
                request_reason_categories.c.tenant_id == scope.tenant_id,
                request_reason_categories.c.request_type == request_type,
            )
        ).scalar_one()
    ) + 1
    return int(
        conn.execute(
            insert(request_reason_categories)
            .values(
                tenant_id=scope.tenant_id,
                request_type=request_type,
                code=code,
                name=name,
                display_order=next_order,
            )
            .returning(request_reason_categories.c.id)
        ).scalar_one()
    )


def update_category(
    conn: Connection,
    scope: TenantScope,
    category_id: int,
    *,
    values: dict[str, object],
) -> None:
    if not values:
        return
    payload = dict(values)
    payload["updated_at"] = func.now()
    conn.execute(
        update(request_reason_categories)
        .where(
            request_reason_categories.c.id == category_id,
            request_reason_categories.c.tenant_id == scope.tenant_id,
        )
        .values(**payload)
    )


def delete_category(
    conn: Connection, scope: TenantScope, category_id: int
) -> None:
    """Hard delete. Reason category is referenced by ``requests`` only by
    free-text ``reason_category`` so there's no FK cleanup to worry
    about — historical requests keep their original code on the row.
    """

    conn.execute(
        delete(request_reason_categories).where(
            request_reason_categories.c.id == category_id,
            request_reason_categories.c.tenant_id == scope.tenant_id,
        )
    )
