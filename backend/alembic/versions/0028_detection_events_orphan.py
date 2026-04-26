"""``detection_events.face_crop_path`` becomes nullable + ``orphaned_at``.

Background: P28.5b validation surfaced 251 ``detection_events`` rows in
``tenant_mts_demo`` whose ``face_crop_path`` column pointed at files that
weren't on disk. The file-write invariants in
``hadir/capture/events.py`` were tightened in the same commit so the
forward path can no longer produce orphans, but the existing rows can't
just be DELETEd — Camera Logs / attendance / audit history all
reference them. Instead this migration:

* Drops ``NOT NULL`` from ``face_crop_path`` so the cleanup script can
  clear the broken pointers without losing the row.
* Adds ``orphaned_at TIMESTAMPTZ NULL`` so the UI can render an
  "unavailable" placeholder and an auditor can see when the row was
  reclassified.

Going forward, a row with ``face_crop_path IS NULL`` reads as
"detection happened (track + bbox + employee_id are real) but the
crop file was lost". The detection_events crop endpoint returns
**404 ``crop_unavailable``** for these rows; rows where
``face_crop_path`` is set but the file is missing on disk continue
to return **410 ``crop file missing``** — that's the live-failure
path and shouldn't be silenced.

Schema-agnostic: ``detection_events`` lives per tenant, so the
migration runs cleanly under each tenant schema via the orchestrator.
Idempotency: per-tenant alembic passes that re-run this revision
short-circuit when ``orphaned_at`` already exists.

Revision ID: 0028_detection_events_orphan
Revises: 0027_cameras_capture_split
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0028_detection_events_orphan"
down_revision: Union[str, Sequence[str], None] = "0027_cameras_capture_split"
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

    # Idempotency — once ``orphaned_at`` lands, every subsequent
    # per-tenant pass is a no-op.
    if _has_column(bind, "detection_events", "orphaned_at"):
        return

    op.alter_column(
        "detection_events",
        "face_crop_path",
        existing_type=sa.Text(),
        nullable=True,
    )
    op.add_column(
        "detection_events",
        sa.Column(
            "orphaned_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "detection_events", "orphaned_at"):
        return

    # We can't safely flip back to NOT NULL if the cleanup script ran —
    # there'd be NULL rows that violate the constraint. Operator must
    # inspect + delete them first.
    op.drop_column("detection_events", "orphaned_at")
    op.alter_column(
        "detection_events",
        "face_crop_path",
        existing_type=sa.Text(),
        nullable=False,
    )
