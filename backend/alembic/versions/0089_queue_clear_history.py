"""0089 — Queue-clear history (who/when/why) on clip_processing_results.

Clearing a pipeline queue already marks the pending
``clip_processing_results`` rows ``status='cancelled'`` rather than
deleting them — so the clips are never lost, only flagged. This adds the
provenance needed to turn those cancelled rows into a usable "Queue
History" that can be reprocessed later (off-peak / overnight):

* ``cleared_at``          — when the clear happened (TIMESTAMPTZ)
* ``cleared_by_user_id``  — the admin who cleared (FK users, SET NULL)
* ``clear_reason``        — free-text reason supplied at clear time

All nullable: rows cancelled before this ship carry NULL. No grant
change. Schema-agnostic + idempotent.

Revision ID: 0089_queue_clear_history
Revises:     0088_clip_detect_lock_split
Create Date: 2026-06-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0089_queue_clear_history"
down_revision: Union[str, Sequence[str], None] = "0088_clip_detect_lock_split"
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
    if not _has_column(bind, "clip_processing_results", "cleared_at"):
        op.add_column(
            "clip_processing_results",
            sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
        )
    if not _has_column(bind, "clip_processing_results", "cleared_by_user_id"):
        op.add_column(
            "clip_processing_results",
            sa.Column("cleared_by_user_id", sa.Integer(), nullable=True),
        )
        # FK to users with ON DELETE SET NULL so history survives a user
        # being removed. Unqualified — lands in the active schema.
        op.create_foreign_key(
            "fk_cpr_cleared_by_user",
            "clip_processing_results",
            "users",
            ["cleared_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )
    if not _has_column(bind, "clip_processing_results", "clear_reason"):
        op.add_column(
            "clip_processing_results",
            sa.Column("clear_reason", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "clip_processing_results", "clear_reason"):
        op.drop_column("clip_processing_results", "clear_reason")
    if _has_column(bind, "clip_processing_results", "cleared_by_user_id"):
        op.drop_constraint(
            "fk_cpr_cleared_by_user", "clip_processing_results", type_="foreignkey"
        )
        op.drop_column("clip_processing_results", "cleared_by_user_id")
    if _has_column(bind, "clip_processing_results", "cleared_at"):
        op.drop_column("clip_processing_results", "cleared_at")
