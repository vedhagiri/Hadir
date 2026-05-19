"""0062 — Add clip_processing_results.recovery_attempts.

Counter incremented every time the boot-time recovery flow re-enqueues
a job that was found stuck in ``status='processing'`` after an
unclean shutdown. Caps at ``MAUGOOD_CLIP_PIPELINE_MAX_RECOVERY_ATTEMPTS``
(default 3) to prevent poison-job loops — beyond the cap the row is
flipped to ``status='failed'`` with ``error='exceeded recovery
attempts after restart'`` and stays there until an operator intervenes.

Default ``0`` means existing rows aren't treated as already-recovered.

Revision ID: 0062_cpr_recovery
Revises: 0061_fc_match_conf
Create Date: 2026-05-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0062_cpr_recovery"
down_revision: str = "0061_fc_match_conf"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "clip_processing_results",
        sa.Column(
            "recovery_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("clip_processing_results", "recovery_attempts")
