"""``tenant_settings.detection_config`` + ``tracker_config`` JSONB.

P28.5c: system-wide detection + tracker configuration. Two new JSONB
columns on the per-tenant ``tenant_settings`` table:

* ``detection_config`` — detector mode (``insightface`` /
  ``yolo+face``), input size, confidence thresholds, body-box overlay
  toggle. Defaults match the prototype's tested values.
* ``tracker_config`` — IoU threshold, idle timeout, max event
  duration. Defaults match prototype.

Per-camera ``capture_config`` (added in 0027) carries
``max_event_duration_sec`` too. **Per-camera value overrides the
tenant default** — a single camera can keep tracks longer (or
shorter) than the rest. Documented in
``backend/CLAUDE.md`` § "Capture configuration precedence".

Schema-agnostic, idempotent (per-tenant alembic re-run sees the
column already present and short-circuits).

Revision ID: 0029_tenant_settings_detection
Revises: 0028_detection_events_orphan
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0029_tenant_settings_detection"
down_revision: Union[str, Sequence[str], None] = "0028_detection_events_orphan"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEFAULT_DETECTION_SQL = (
    """'{"mode": "insightface", """
    """"det_size": 320, """
    """"min_det_score": 0.5, """
    """"min_face_pixels": 3600, """
    """"yolo_conf": 0.35, """
    """"show_body_boxes": false}'::jsonb"""
)


_DEFAULT_TRACKER_SQL = (
    """'{"iou_threshold": 0.3, """
    """"timeout_sec": 2.0, """
    """"max_duration_sec": 60.0}'::jsonb"""
)


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

    if _has_column(bind, "tenant_settings", "detection_config"):
        return

    op.add_column(
        "tenant_settings",
        sa.Column(
            "detection_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(_DEFAULT_DETECTION_SQL),
        ),
    )
    op.add_column(
        "tenant_settings",
        sa.Column(
            "tracker_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(_DEFAULT_TRACKER_SQL),
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "tenant_settings", "detection_config"):
        return
    op.drop_column("tenant_settings", "tracker_config")
    op.drop_column("tenant_settings", "detection_config")
