"""0073 — Per-tenant clip-pipeline use-case enable set.

Makes the clip-pipeline use-case enable list (``uc1`` / ``uc2`` /
``uc3``) controllable per-tenant from the DB so it can be driven by a
UI, replacing the env-only knob ``MAUGOOD_CLIP_PIPELINE_USE_CASES``.

This migration adds:

* ``tenant_settings.clip_pipeline_use_cases`` — JSONB, **NULLABLE, no
  server default**. NULL means "inherit the process-wide env/default":
  the runtime resolver falls back to ``MAUGOOD_CLIP_PIPELINE_USE_CASES``
  if set, else the default all-three ``("uc1", "uc2", "uc3")``. A
  non-NULL value is a JSON array of strings, each in
  ``{"uc1", "uc2", "uc3"}``; an empty array means "no use case runs for
  this tenant".

No backfill — NULL is the intended "inherit" state for every existing
tenant, so an upgrade is behaviourally a no-op (the env-derived default
keeps driving the pipeline until an operator sets a per-tenant value).
No new grant needed — ``maugood_app`` already holds
SELECT/INSERT/UPDATE/DELETE on ``tenant_settings``; this only adds a
column to an existing table.

Schema-agnostic + idempotent: the existence check uses
``information_schema`` against ``current_schema()`` so re-running on a
partially-upgraded tenant is safe; the unqualified table name lets the
column land in whichever schema the alembic search_path points at.

Revision ID: 0073_tenant_settings_clip_pipeline_use_cases
Revises:     0072_cameras_live_matching
Create Date: 2026-06-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0073_clip_pipeline_use_cases"
down_revision: Union[str, Sequence[str], None] = "0072_cameras_live_matching"
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


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "tenant_settings", "clip_pipeline_use_cases"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "clip_pipeline_use_cases",
                postgresql.JSONB(),
                nullable=True,
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "tenant_settings", "clip_pipeline_use_cases"):
        op.drop_column("tenant_settings", "clip_pipeline_use_cases")
