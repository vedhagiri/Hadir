"""``cameras.detection_enabled`` BOOL — third operational lever next to
``worker_enabled`` and ``display_enabled``.

Operator ask: when the worker is on but the operator wants the camera
to keep streaming (RTSP, live preview) without burning CPU on
detection or writing detection_events rows, flip this off. Default is
TRUE so existing rows + the current "worker on = full pipeline"
behaviour stay unchanged.

Semantics:

* ``worker_enabled=false``                                → no worker (RTSP off too).
* ``worker_enabled=true,  detection_enabled=true``  (default) → full pipeline.
* ``worker_enabled=true,  detection_enabled=false``           → reader runs
  (frames flow to display), analyzer thread runs but skips the
  expensive ``detect`` call. No detection_events rows produced.

Schema-agnostic: ``cameras`` lives per tenant, so this migration runs
under each tenant schema via the orchestrator.

Revision ID: 0033_cameras_detection_enabled
Revises: 0032_detection_events_metadata
Create Date: 2026-04-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0033_cameras_detection_enabled"
down_revision: Union[str, Sequence[str], None] = "0032_detection_events_metadata"
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
    if _has_column(bind, "cameras", "detection_enabled"):
        return
    op.add_column(
        "cameras",
        sa.Column(
            "detection_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "cameras", "detection_enabled"):
        return
    op.drop_column("cameras", "detection_enabled")
