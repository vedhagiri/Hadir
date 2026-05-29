"""0068 — tenant_settings.date_format + time_format.

End-to-end timezone + format normalization. ``timezone`` already
exists (P11); these two columns finish the picture by letting an
operator pick how dates and times render across every surface
(UI, PDFs, Excel, ERP exports, notification emails). Centralized
in tenant_settings so a single source of truth drives every
formatter.

Allowed values (CHECK-constrained):
  * ``date_format`` ∈ {``DD/MM/YYYY`` (default), ``MM/DD/YYYY``,
    ``YYYY-MM-DD``}
  * ``time_format`` ∈ {``24h`` (default), ``12h``}

Defaults match GCC/Oman convention (DD/MM/YYYY + 24h). Schema-
agnostic + idempotent.

Revision ID: 0068_ts_datetime_format
Revises:     0067_detection_mapping_source
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0068_ts_datetime_format"
down_revision: Union[str, Sequence[str], None] = "0067_detection_mapping_source"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, column: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND column_name  = :c"
            ),
            {"t": table, "c": column},
        ).scalar()
    )


def _has_constraint(bind, table: str, constraint: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.table_constraints "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND constraint_name = :c"
            ),
            {"t": table, "c": constraint},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "tenant_settings", "date_format"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "date_format",
                sa.String(length=16),
                nullable=False,
                server_default="DD/MM/YYYY",
            ),
        )
    if not _has_column(bind, "tenant_settings", "time_format"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "time_format",
                sa.String(length=8),
                nullable=False,
                server_default="24h",
            ),
        )

    if not _has_constraint(
        bind, "tenant_settings", "ck_tenant_settings_date_format"
    ):
        op.create_check_constraint(
            "ck_tenant_settings_date_format",
            "tenant_settings",
            "date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')",
        )
    if not _has_constraint(
        bind, "tenant_settings", "ck_tenant_settings_time_format"
    ):
        op.create_check_constraint(
            "ck_tenant_settings_time_format",
            "tenant_settings",
            "time_format IN ('12h', '24h')",
        )


def downgrade() -> None:
    bind = op.get_bind()
    for name in (
        "ck_tenant_settings_time_format",
        "ck_tenant_settings_date_format",
    ):
        if _has_constraint(bind, "tenant_settings", name):
            op.drop_constraint(name, "tenant_settings", type_="check")
    for col in ("time_format", "date_format"):
        if _has_column(bind, "tenant_settings", col):
            op.drop_column("tenant_settings", col)
