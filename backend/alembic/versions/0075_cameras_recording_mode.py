"""0075 — Add recording_mode to cameras and person_clips.

Introduces a ``recording_mode`` column on two tables:

* ``cameras.recording_mode`` — TEXT NOT NULL DEFAULT 'save_clips' with a
  CHECK constraint ``recording_mode IN ('save_clips', 'logs_only')``.
  ``save_clips`` (the existing behaviour) writes a video file and inserts
  a ``person_clips`` row. ``logs_only`` produces a presence-log row in
  ``person_clips`` without writing any video to disk.

* ``person_clips.recording_mode`` — TEXT NULL, no default. NULL means a
  legacy / ``save_clips`` clip (all pre-migration rows are effectively
  ``save_clips``). ``'logs_only'`` marks a presence-log row that was
  created without an associated video file.

No data backfill is required for ``cameras``: new rows carry the server
default of ``'save_clips'``, which faithfully represents the state of
every camera before this migration. ``person_clips`` is also left NULL on
existing rows — the application treats NULL the same as ``'save_clips'``
(backward-compat).

Schema-agnostic + idempotent: existence and constraint checks use
``information_schema`` against ``current_schema()`` so a re-run on a
partially-upgraded tenant is safe; unqualified table names let the change
land in whichever schema the Alembic search_path points at. No grant
changes — both columns live on tables ``maugood_app`` already holds full
CRUD on; adding a column does not alter any GRANT.

Revision ID: 0075_cameras_recording_mode
Revises:     0074_drop_clip_detection_source
Create Date: 2026-06-09
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0075_cameras_recording_mode"
down_revision: Union[str, Sequence[str], None] = "0074_drop_clip_detection_source"
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
                "WHERE constraint_schema = current_schema() "
                "  AND table_name      = :t "
                "  AND constraint_name = :c"
            ),
            {"t": table, "c": constraint},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    # --- cameras.recording_mode -----------------------------------------------
    if not _has_column(bind, "cameras", "recording_mode"):
        op.add_column(
            "cameras",
            sa.Column(
                "recording_mode",
                sa.Text(),
                nullable=False,
                server_default="save_clips",
            ),
        )
    if not _has_constraint(bind, "cameras", "ck_cameras_recording_mode"):
        op.create_check_constraint(
            "ck_cameras_recording_mode",
            "cameras",
            "recording_mode IN ('save_clips', 'logs_only')",
        )

    # --- person_clips.recording_mode ------------------------------------------
    if not _has_column(bind, "person_clips", "recording_mode"):
        op.add_column(
            "person_clips",
            sa.Column(
                "recording_mode",
                sa.Text(),
                nullable=True,
            ),
        )
    # No CHECK constraint on person_clips.recording_mode — NULL is the
    # valid legacy/save_clips sentinel and the application layer enforces
    # the allowed values when writing new rows.


def downgrade() -> None:
    bind = op.get_bind()

    if _has_constraint(bind, "cameras", "ck_cameras_recording_mode"):
        op.drop_constraint(
            "ck_cameras_recording_mode", "cameras", type_="check"
        )
    if _has_column(bind, "cameras", "recording_mode"):
        op.drop_column("cameras", "recording_mode")

    if _has_column(bind, "person_clips", "recording_mode"):
        op.drop_column("person_clips", "recording_mode")
