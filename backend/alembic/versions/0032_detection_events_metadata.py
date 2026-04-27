"""``detection_events.detection_metadata`` JSONB nullable.

Captures, per row, *which model* produced the embedding + classification
plus *which version* of the underlying packages was running. Operator
ask: "with captured photo I want to store the metadata like which model
identified this face and version of the model".

Schema-agnostic: ``detection_events`` lives per tenant, so the migration
runs under each tenant schema via the orchestrator.

Forward-compat: storing as JSONB rather than separate columns means
v1.x can extend the field set (e.g. add pose_score once kps land in
Detection) without another migration.

Backfill: existing rows stay ``NULL`` — they pre-date the helper that
captures the metadata. Camera Logs renders "—" for these. We
deliberately don't backfill from current settings because that would
record today's config against historical events.

Revision ID: 0032_detection_events_metadata
Revises: 0031_p28_8_camera_metadata
Create Date: 2026-04-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0032_detection_events_metadata"
down_revision: Union[str, Sequence[str], None] = "0031_p28_8_camera_metadata"
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
    if _has_column(bind, "detection_events", "detection_metadata"):
        return
    op.add_column(
        "detection_events",
        sa.Column(
            "detection_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "detection_events", "detection_metadata"):
        return
    op.drop_column("detection_events", "detection_metadata")
