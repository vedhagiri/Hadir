"""0076 — Default cameras.recording_mode to 'logs_only' + backfill.

Makes ``logs_only`` the system-wide default recording mode for cameras:

* Flips the ``cameras.recording_mode`` server DEFAULT from ``'save_clips'``
  (set by migration 0075) to ``'logs_only'`` so every newly-inserted
  camera row logs presence without writing video unless an operator
  explicitly picks ``'save_clips'``.

* **Backfills every existing camera** to ``'logs_only'``. The operator
  asked for Logs Only on all cameras, including ones already configured,
  so this is an unconditional UPDATE (not just rows still on the old
  default). Operators who want a specific camera back on ``save_clips``
  flip it per-camera afterwards.

``person_clips.recording_mode`` is intentionally left untouched — its
rows are an immutable historical record of how each clip/log was
produced, not a configuration knob.

Schema-agnostic + idempotent: the ALTER and UPDATE are naturally
re-runnable, and unqualified table names let the change land in
whichever schema the Alembic search_path points at. No grant changes —
altering a default / updating rows touches no GRANT.

Revision ID: 0076_cameras_default_logs_only
Revises:     0075_cameras_recording_mode
Create Date: 2026-06-09
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0076_cameras_default_logs_only"
down_revision: Union[str, Sequence[str], None] = "0075_cameras_recording_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    # Flip the column default for all future inserts.
    bind.execute(
        text("ALTER TABLE cameras ALTER COLUMN recording_mode SET DEFAULT 'logs_only'")
    )

    # Backfill every existing camera to logs_only (unconditional per the
    # operator request — all cameras, including already-configured ones).
    bind.execute(
        text(
            "UPDATE cameras SET recording_mode = 'logs_only' "
            "WHERE recording_mode <> 'logs_only'"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()

    # Restore the migration 0075 default. Row values are NOT reverted —
    # the backfill is not reversible without prior-state knowledge.
    bind.execute(
        text("ALTER TABLE cameras ALTER COLUMN recording_mode SET DEFAULT 'save_clips'")
    )
