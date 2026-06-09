"""0074 — Remove the clip-detection-source feature entirely.

Clip recording is now *always* driven by YOLO body/person presence.
The configurable ``face`` / ``both`` triggers are gone, so the two
columns that carried that choice are dropped:

* ``cameras.clip_detection_source`` (+ its CHECK
  ``ck_cameras_clip_detection_source``) — the per-camera knob that
  selected which detector started a clip. Removed: body presence is
  the only trigger.
* ``person_clips.detection_source`` (+ its CHECK
  ``ck_person_clips_detection_source``) — the per-clip historical
  stamp recording which detector triggered each recording. Removed
  along with the feature (every clip going forward is body-triggered,
  so the column carries no information).

Irreversible in spirit — ``downgrade()`` re-creates both columns with
their pre-0074 shape (NOT NULL, server_default + CHECK) but cannot
recover the historical per-clip ``detection_source`` values; every
restored row defaults to ``body``.

Schema-agnostic + idempotent: existence checks use ``information_schema``
against ``current_schema()`` so a re-run on a partially-upgraded tenant
is safe; unqualified table names let the change land in whichever schema
the alembic search_path points at. No grant changes — both columns live
on tables ``maugood_app`` already holds full CRUD on; dropping a column
does not alter any GRANT.

Revision ID: 0074_drop_clip_detection_source
Revises:     0073_clip_pipeline_use_cases
Create Date: 2026-06-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0074_drop_clip_detection_source"
down_revision: Union[str, Sequence[str], None] = "0073_clip_pipeline_use_cases"
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

    if _has_constraint(bind, "cameras", "ck_cameras_clip_detection_source"):
        op.drop_constraint(
            "ck_cameras_clip_detection_source", "cameras", type_="check"
        )
    if _has_column(bind, "cameras", "clip_detection_source"):
        op.drop_column("cameras", "clip_detection_source")

    if _has_constraint(
        bind, "person_clips", "ck_person_clips_detection_source"
    ):
        op.drop_constraint(
            "ck_person_clips_detection_source", "person_clips", type_="check"
        )
    if _has_column(bind, "person_clips", "detection_source"):
        op.drop_column("person_clips", "detection_source")


def downgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "cameras", "clip_detection_source"):
        op.add_column(
            "cameras",
            sa.Column(
                "clip_detection_source",
                sa.Text(),
                nullable=False,
                server_default="body",
            ),
        )
    if not _has_constraint(
        bind, "cameras", "ck_cameras_clip_detection_source"
    ):
        op.create_check_constraint(
            "ck_cameras_clip_detection_source",
            "cameras",
            "clip_detection_source IN ('face', 'body', 'both')",
        )

    if not _has_column(bind, "person_clips", "detection_source"):
        op.add_column(
            "person_clips",
            sa.Column(
                "detection_source",
                sa.Text(),
                nullable=False,
                server_default="body",
            ),
        )
    if not _has_constraint(
        bind, "person_clips", "ck_person_clips_detection_source"
    ):
        op.create_check_constraint(
            "ck_person_clips_detection_source",
            "person_clips",
            "detection_source IN ('face', 'body', 'both')",
        )
