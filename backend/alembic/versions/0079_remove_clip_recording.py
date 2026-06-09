"""0079 — Remove cameras.clip_recording_enabled (folded into recording_mode).

The per-camera ``clip_recording_enabled`` boolean (migration 0049) was a
master on/off gate over recording; ``recording_mode`` (migration 0075)
then chose Save Clips vs Logs Only underneath it. Two controls for one
decision. ``recording_mode`` is now the single control:

* ``save_clips`` → records an MP4 + person_clips row
* ``logs_only``  → records a lightweight presence row (no video)

A running worker always records per its ``recording_mode``; to make a
camera do nothing, disable its Worker (``worker_enabled``). The gate is
removed from the capture reader alongside this migration, so the column
is now dead — drop it.

Every live camera was ``clip_recording_enabled = true`` at removal time,
so dropping the gate is behaviourally a no-op for existing data.

Schema-agnostic + idempotent: unqualified table name lands in whichever
schema the search_path points at; the column-existence guard makes
re-runs a no-op. No grant changes. ``downgrade`` re-adds the column
(default true) but cannot recover prior per-row values.

Revision ID: 0079_remove_clip_recording
Revises:     0078_remove_live_matching
Create Date: 2026-06-10
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0079_remove_clip_recording"
down_revision: Union[str, Sequence[str], None] = "0078_remove_live_matching"
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
    if _has_column(bind, "cameras", "clip_recording_enabled"):
        op.drop_column("cameras", "clip_recording_enabled")


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "cameras", "clip_recording_enabled"):
        op.add_column(
            "cameras",
            sa.Column(
                "clip_recording_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            ),
        )
