"""DB layer for ``tenant_branding``.

Lazy-creates the row on first read so a tenant whose ``alembic stamp
head`` skipped the 0010 default-seed (e.g. a tenant provisioned via
the CLI before P4 ran) still gets a clean row.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection

from hadir.branding.constants import DEFAULT_FONT_KEY, DEFAULT_PRIMARY_COLOR_KEY
from hadir.db import tenant_branding


@dataclass(frozen=True, slots=True)
class BrandingRow:
    tenant_id: int
    primary_color_key: str
    font_key: str
    logo_path: Optional[str]
    updated_at: datetime


def get_branding(conn: Connection, *, tenant_id: int) -> BrandingRow:
    """Return the tenant's branding row, lazy-creating one if absent."""

    row = conn.execute(
        select(
            tenant_branding.c.tenant_id,
            tenant_branding.c.primary_color_key,
            tenant_branding.c.font_key,
            tenant_branding.c.logo_path,
            tenant_branding.c.updated_at,
        ).where(tenant_branding.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        # Lazy-create with defaults. ``server_default`` does the right
        # thing on the column-level so we just insert the tenant_id.
        conn.execute(insert(tenant_branding).values(tenant_id=tenant_id))
        row = conn.execute(
            select(
                tenant_branding.c.tenant_id,
                tenant_branding.c.primary_color_key,
                tenant_branding.c.font_key,
                tenant_branding.c.logo_path,
                tenant_branding.c.updated_at,
            ).where(tenant_branding.c.tenant_id == tenant_id)
        ).first()
    assert row is not None  # we either found it or just inserted it
    return BrandingRow(
        tenant_id=int(row.tenant_id),
        primary_color_key=str(row.primary_color_key),
        font_key=str(row.font_key),
        logo_path=row.logo_path,
        updated_at=row.updated_at,
    )


def update_branding(
    conn: Connection,
    *,
    tenant_id: int,
    primary_color_key: Optional[str] = None,
    font_key: Optional[str] = None,
    logo_path: Optional[str] = None,
    clear_logo: bool = False,
) -> BrandingRow:
    """Patch the row, then return the persisted state.

    ``logo_path`` is set when uploading a new logo; ``clear_logo``
    nulls it on delete. Both are mutually exclusive.
    """

    # Make sure the row exists first.
    get_branding(conn, tenant_id=tenant_id)

    values: dict[str, object] = {"updated_at": datetime.now(tz=timezone.utc)}
    if primary_color_key is not None:
        values["primary_color_key"] = primary_color_key
    if font_key is not None:
        values["font_key"] = font_key
    if clear_logo:
        values["logo_path"] = None
    elif logo_path is not None:
        values["logo_path"] = logo_path

    conn.execute(
        update(tenant_branding)
        .where(tenant_branding.c.tenant_id == tenant_id)
        .values(**values)
    )
    return get_branding(conn, tenant_id=tenant_id)
