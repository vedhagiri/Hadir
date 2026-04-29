"""DB access + value coercion for custom fields.

The router stays thin; this module owns the ``str ↔ typed value``
plumbing and the field listing/upsert helpers used by both the
custom-fields API and the employees export/import.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type
from typing import Any, Optional

from sqlalchemy import and_, delete, func, insert, select, update
from sqlalchemy.engine import Connection

from maugood.db import custom_field_values, custom_fields
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class FieldRow:
    id: int
    tenant_id: int
    name: str
    code: str
    type: str
    options: Optional[list[str]]
    required: bool
    display_order: int


@dataclass(frozen=True, slots=True)
class FieldValueRow:
    field_id: int
    employee_id: int
    code: str
    name: str
    type: str
    value: str  # always stored as text; typed via ``coerce_for_read``


# ---------------------------------------------------------------------------
# Field definitions
# ---------------------------------------------------------------------------


def _row_to_field(row) -> FieldRow:  # type: ignore[no-untyped-def]
    return FieldRow(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        name=str(row.name),
        code=str(row.code),
        type=str(row.type),
        options=list(row.options) if row.options is not None else None,
        required=bool(row.required),
        display_order=int(row.display_order),
    )


def list_fields(conn: Connection, scope: TenantScope) -> list[FieldRow]:
    rows = conn.execute(
        select(
            custom_fields.c.id,
            custom_fields.c.tenant_id,
            custom_fields.c.name,
            custom_fields.c.code,
            custom_fields.c.type,
            custom_fields.c.options,
            custom_fields.c.required,
            custom_fields.c.display_order,
        )
        .where(custom_fields.c.tenant_id == scope.tenant_id)
        .order_by(
            custom_fields.c.display_order.asc(),
            custom_fields.c.id.asc(),
        )
    ).all()
    return [_row_to_field(r) for r in rows]


def get_field(
    conn: Connection, scope: TenantScope, field_id: int
) -> Optional[FieldRow]:
    row = conn.execute(
        select(
            custom_fields.c.id,
            custom_fields.c.tenant_id,
            custom_fields.c.name,
            custom_fields.c.code,
            custom_fields.c.type,
            custom_fields.c.options,
            custom_fields.c.required,
            custom_fields.c.display_order,
        ).where(
            custom_fields.c.tenant_id == scope.tenant_id,
            custom_fields.c.id == field_id,
        )
    ).first()
    return _row_to_field(row) if row is not None else None


def get_field_by_code(
    conn: Connection, scope: TenantScope, code: str
) -> Optional[FieldRow]:
    row = conn.execute(
        select(
            custom_fields.c.id,
            custom_fields.c.tenant_id,
            custom_fields.c.name,
            custom_fields.c.code,
            custom_fields.c.type,
            custom_fields.c.options,
            custom_fields.c.required,
            custom_fields.c.display_order,
        ).where(
            custom_fields.c.tenant_id == scope.tenant_id,
            custom_fields.c.code == code,
        )
    ).first()
    return _row_to_field(row) if row is not None else None


def next_display_order(conn: Connection, scope: TenantScope) -> int:
    """Return one past the current max display_order so new fields land last."""

    current_max = conn.execute(
        select(func.coalesce(func.max(custom_fields.c.display_order), -1)).where(
            custom_fields.c.tenant_id == scope.tenant_id
        )
    ).scalar_one()
    return int(current_max) + 1


def create_field(
    conn: Connection,
    scope: TenantScope,
    *,
    name: str,
    code: str,
    type: str,
    options: Optional[list[str]],
    required: bool,
    display_order: int,
) -> int:
    return int(
        conn.execute(
            insert(custom_fields)
            .values(
                tenant_id=scope.tenant_id,
                name=name,
                code=code,
                type=type,
                options=options,
                required=required,
                display_order=display_order,
            )
            .returning(custom_fields.c.id)
        ).scalar_one()
    )


def update_field(
    conn: Connection,
    scope: TenantScope,
    field_id: int,
    *,
    values: dict[str, Any],
) -> None:
    if not values:
        return
    values = dict(values)
    values["updated_at"] = func.now()
    conn.execute(
        update(custom_fields)
        .where(
            custom_fields.c.id == field_id,
            custom_fields.c.tenant_id == scope.tenant_id,
        )
        .values(**values)
    )


def delete_field(conn: Connection, scope: TenantScope, field_id: int) -> None:
    """Drop the field. ON DELETE CASCADE removes its values."""

    conn.execute(
        delete(custom_fields).where(
            custom_fields.c.id == field_id,
            custom_fields.c.tenant_id == scope.tenant_id,
        )
    )


def reorder_fields(
    conn: Connection,
    scope: TenantScope,
    *,
    items: list[tuple[int, int]],
) -> None:
    """Apply ``[(field_id, display_order), …]`` in one go."""

    for field_id, order in items:
        conn.execute(
            update(custom_fields)
            .where(
                custom_fields.c.id == field_id,
                custom_fields.c.tenant_id == scope.tenant_id,
            )
            .values(display_order=order, updated_at=func.now())
        )


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


def list_values_for_employee(
    conn: Connection, scope: TenantScope, employee_id: int
) -> list[FieldValueRow]:
    """One ``FieldValueRow`` per defined field — empty value if unset.

    The shape mirrors the editor: every field is rendered, and unset
    fields show as blank inputs. Values stay stored as text.
    """

    rows = conn.execute(
        select(
            custom_fields.c.id.label("field_id"),
            custom_fields.c.code,
            custom_fields.c.name,
            custom_fields.c.type,
            custom_field_values.c.value,
        )
        .select_from(
            custom_fields.outerjoin(
                custom_field_values,
                and_(
                    custom_field_values.c.field_id == custom_fields.c.id,
                    custom_field_values.c.tenant_id
                    == custom_fields.c.tenant_id,
                    custom_field_values.c.employee_id == employee_id,
                ),
            )
        )
        .where(custom_fields.c.tenant_id == scope.tenant_id)
        .order_by(
            custom_fields.c.display_order.asc(),
            custom_fields.c.id.asc(),
        )
    ).all()
    return [
        FieldValueRow(
            field_id=int(r.field_id),
            employee_id=employee_id,
            code=str(r.code),
            name=str(r.name),
            type=str(r.type),
            value=str(r.value) if r.value is not None else "",
        )
        for r in rows
    ]


def values_for_employees(
    conn: Connection, scope: TenantScope, employee_ids: list[int]
) -> dict[int, dict[str, str]]:
    """Bulk fetch — ``{employee_id: {field_code: value}}``.

    Used by the Excel export so we can enrich rows without N+1
    selects. Empty values are omitted from the inner dict.
    """

    if not employee_ids:
        return {}

    rows = conn.execute(
        select(
            custom_field_values.c.employee_id,
            custom_fields.c.code,
            custom_field_values.c.value,
        )
        .select_from(
            custom_field_values.join(
                custom_fields,
                and_(
                    custom_fields.c.id == custom_field_values.c.field_id,
                    custom_fields.c.tenant_id
                    == custom_field_values.c.tenant_id,
                ),
            )
        )
        .where(
            custom_field_values.c.tenant_id == scope.tenant_id,
            custom_field_values.c.employee_id.in_(employee_ids),
        )
    ).all()

    result: dict[int, dict[str, str]] = {}
    for r in rows:
        v = str(r.value) if r.value is not None else ""
        if not v:
            continue
        result.setdefault(int(r.employee_id), {})[str(r.code)] = v
    return result


def upsert_value(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    field_id: int,
    value: str,
) -> None:
    """Insert-or-update a single (employee, field) value cell."""

    existing = conn.execute(
        select(custom_field_values.c.id).where(
            custom_field_values.c.tenant_id == scope.tenant_id,
            custom_field_values.c.employee_id == employee_id,
            custom_field_values.c.field_id == field_id,
        )
    ).first()
    if existing is None:
        conn.execute(
            insert(custom_field_values).values(
                tenant_id=scope.tenant_id,
                employee_id=employee_id,
                field_id=field_id,
                value=value,
            )
        )
    else:
        conn.execute(
            update(custom_field_values)
            .where(custom_field_values.c.id == int(existing.id))
            .values(value=value, updated_at=func.now())
        )


def clear_value(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    field_id: int,
) -> None:
    conn.execute(
        delete(custom_field_values).where(
            custom_field_values.c.tenant_id == scope.tenant_id,
            custom_field_values.c.employee_id == employee_id,
            custom_field_values.c.field_id == field_id,
        )
    )


# ---------------------------------------------------------------------------
# Coercion helpers — text ⇄ typed value
# ---------------------------------------------------------------------------


class CoerceError(ValueError):
    """Raised when a value can't be stored as the field's declared type."""


def coerce_for_store(field: FieldRow, raw: Any) -> str:
    """Convert ``raw`` to the canonical text form we persist in the DB.

    ``None`` / empty stays empty so callers can use it to clear a value.
    Type-specific rules:
      - ``text``: trim only
      - ``number``: must parse as int or float; stored as ``str(value)``
        (no scientific notation; ``int`` first if exact)
      - ``date``: must be ``YYYY-MM-DD`` or a real ``date`` object
      - ``select``: value must be one of ``field.options``
    """

    if raw is None:
        return ""
    if isinstance(raw, str):
        text = raw.strip()
    else:
        text = str(raw).strip()

    if text == "":
        return ""

    if field.type == "text":
        return text
    if field.type == "number":
        try:
            if "." in text or "e" in text.lower():
                return str(float(text))
            return str(int(text))
        except ValueError as exc:
            raise CoerceError(
                f"value for {field.code!r} must be a number, got {text!r}"
            ) from exc
    if field.type == "date":
        try:
            # Accept either a date instance (already formatted), or a
            # YYYY-MM-DD string.
            if isinstance(raw, date_type):
                return raw.isoformat()
            parsed = date_type.fromisoformat(text)
            return parsed.isoformat()
        except (TypeError, ValueError) as exc:
            raise CoerceError(
                f"value for {field.code!r} must be a YYYY-MM-DD date, got {text!r}"
            ) from exc
    if field.type == "select":
        if not field.options or text not in field.options:
            raise CoerceError(
                f"value for {field.code!r} must be one of {field.options!r}, "
                f"got {text!r}"
            )
        return text
    raise CoerceError(f"unknown field type {field.type!r}")


def coerce_for_read(field: FieldRow, stored: str) -> Any:
    """Convert the stored text back into the typed shape for API responses."""

    if stored == "" or stored is None:
        return None
    if field.type == "text" or field.type == "select":
        return stored
    if field.type == "number":
        try:
            if "." in stored or "e" in stored.lower():
                return float(stored)
            return int(stored)
        except ValueError:
            # Defensive fallback — stored value was hand-edited to garbage.
            return stored
    if field.type == "date":
        try:
            return date_type.fromisoformat(stored).isoformat()
        except ValueError:
            return stored
    return stored
