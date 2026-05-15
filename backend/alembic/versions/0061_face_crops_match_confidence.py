"""0061 — Add face_crops.match_confidence.

Per-crop match score (0.0–1.0). Set by the matching worker when a
crop is tagged with an employee_id; NULL for unmatched (employee_id
is NULL) and for legacy rows that pre-date this migration.

Powers:
* The face crop preview lightbox — shows the actual per-frame
  confidence instead of relying on match_details lookup.
* The new detection_events fan-out — when we emit one
  detection_events row per (clip, employee) at the best-confidence
  crop's event_timestamp, we use ``match_confidence`` to pick the
  best crop per employee.

Revision ID: 0061_fc_match_conf
Revises: 0060_lm_default_off
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0061_fc_match_conf"
down_revision: str = "0060_lm_default_off"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "face_crops",
        sa.Column(
            "match_confidence",
            sa.Float(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("face_crops", "match_confidence")
