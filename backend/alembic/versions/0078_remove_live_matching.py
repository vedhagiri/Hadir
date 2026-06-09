"""0078 — Remove the dead live_matching flag (both columns).

``live_matching_enabled`` is fully removed from the product. It gated the
live analyzer's face-detection/recognition pass, but that pass produced
nothing consumable: ``emit_detection_event`` is never called, so the live
loop never wrote ``detection_events`` and never fed attendance. Face
matching + attendance run exclusively on the UC1/UC2 clip-reprocess
pipeline. With the live face path inert, the flag only burned CPU when
enabled — the analyzer now always runs YOLO body detection only.

Drops both columns (code removal lands alongside this migration):

* ``cameras.live_matching_enabled``        (migration 0072, per-camera)
* ``tenant_settings.live_matching_enabled`` (migration 0059, tenant-wide)

Schema-agnostic + idempotent: unqualified table names land in whichever
schema the Alembic search_path points at; the column-existence guard makes
re-runs a no-op. No grant changes (dropping a column touches no GRANT).
Irreversible in practice — ``downgrade`` re-adds the columns (default
false) but cannot recover prior per-row values.

Revision ID: 0078_remove_live_matching
Revises:     0077_remove_uc3
Create Date: 2026-06-09
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0078_remove_live_matching"
down_revision: Union[str, Sequence[str], None] = "0077_remove_uc3"
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

    if _has_column(bind, "cameras", "live_matching_enabled"):
        op.drop_column("cameras", "live_matching_enabled")

    if _has_column(bind, "tenant_settings", "live_matching_enabled"):
        op.drop_column("tenant_settings", "live_matching_enabled")


def downgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "tenant_settings", "live_matching_enabled"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "live_matching_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
    if not _has_column(bind, "cameras", "live_matching_enabled"):
        op.add_column(
            "cameras",
            sa.Column(
                "live_matching_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
