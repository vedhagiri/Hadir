"""0067 — detection_events.mapping_source.

Distinguishes auto live-matches from manual operator maps so the
"Mapped Employees" review tabs can focus on corrective work.

Three allowed values (CHECK-constrained):
  * ``auto``              — set by the live capture pipeline when
    the matcher attributes an employee at insert time.
  * ``manual_reference``  — set by the Reference Image Mapping
    workflow (operator picked the employee and the photos).
  * ``manual_attendance`` — set by the Attendance Event Mapping
    workflow (operator corrected a missed live match).

NULL on rows where ``employee_id IS NULL`` (no attribution to
record). Unmap-events / unmap-by-employee clear the column back
to NULL when they clear ``employee_id``.

Backfill: every existing row with ``employee_id IS NOT NULL`` gets
tagged ``auto``. We can't perfectly distinguish historical auto vs
manual from the audit log (manual map rows carry counts, not event
IDs), so the safe default is ``auto``. Operators can re-map anything
they care about to flip the tag.

Schema-agnostic + idempotent.

Revision ID: 0067_detection_mapping_source
Revises:     0066_face_crops_embedding
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0067_detection_mapping_source"
down_revision: Union[str, Sequence[str], None] = "0066_face_crops_embedding"
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
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND constraint_name = :c"
            ),
            {"t": table, "c": constraint},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "detection_events", "mapping_source"):
        op.add_column(
            "detection_events",
            sa.Column(
                "mapping_source",
                sa.String(length=32),
                nullable=True,
            ),
        )

    if not _has_constraint(
        bind, "detection_events", "ck_detection_events_mapping_source"
    ):
        op.create_check_constraint(
            "ck_detection_events_mapping_source",
            "detection_events",
            "mapping_source IS NULL OR mapping_source IN "
            "('auto', 'manual_reference', 'manual_attendance')",
        )

    # Backfill historical attributed rows. Manual maps from now on
    # re-stamp the column to the correct value during their UPDATE.
    op.execute(
        text(
            "UPDATE detection_events "
            "SET mapping_source = 'auto' "
            "WHERE employee_id IS NOT NULL "
            "  AND mapping_source IS NULL"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_constraint(
        bind, "detection_events", "ck_detection_events_mapping_source"
    ):
        op.drop_constraint(
            "ck_detection_events_mapping_source",
            "detection_events",
            type_="check",
        )
    if _has_column(bind, "detection_events", "mapping_source"):
        op.drop_column("detection_events", "mapping_source")
