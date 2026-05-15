"""0060 — Flip live_matching_enabled default to FALSE and backfill.

The live capture pipeline is now lean-by-default: read RTSP, draw
person bounding boxes, optionally record a clip. No face detection,
no embedding, no matcher cache, no detection_events emission, no
live attendance updates. Identification happens later via the manual
UC1/UC2/UC3 reprocessors on saved clips.

Existing rows (created with the 0059 default of TRUE) are flipped to
FALSE so every tenant inherits the new behaviour on the next reconcile
tick. The toggle still exists for operators who want to opt back in
from System Settings.

Revision ID: 0060_lm_default_off
Revises: 0059_ts_live_matching
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0060_lm_default_off"
down_revision: str = "0059_ts_live_matching"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.alter_column(
        "tenant_settings",
        "live_matching_enabled",
        server_default=sa.text("false"),
        existing_type=sa.Boolean(),
        existing_nullable=False,
    )
    # One-time backfill — flip every existing tenant to the new
    # default. Operators can opt back in via System Settings → Live
    # identification if they actually want live face matching back.
    op.execute(
        "UPDATE tenant_settings SET live_matching_enabled = FALSE"
    )


def downgrade() -> None:
    op.alter_column(
        "tenant_settings",
        "live_matching_enabled",
        server_default=sa.text("true"),
        existing_type=sa.Boolean(),
        existing_nullable=False,
    )
