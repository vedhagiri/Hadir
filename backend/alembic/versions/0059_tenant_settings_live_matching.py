"""0059 — Add tenant_settings.live_matching_enabled.

Per-tenant Admin toggle that turns the live face-matching pipeline on
or off. Defaults to TRUE (existing behaviour) so the migration is
non-breaking. When FALSE the capture analyzer drops face detection +
embedding + matcher_cache calls entirely; only person bounding boxes
are produced for the live preview, and clip recording continues so
identification can run later via the manual UC1/UC2/UC3 reprocessors.

Revision ID: 0059_ts_live_matching
Revises: 0058_dr_reason_optional
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0059_ts_live_matching"
down_revision: str = "0058_dr_reason_optional"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "tenant_settings",
        sa.Column(
            "live_matching_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("tenant_settings", "live_matching_enabled")
