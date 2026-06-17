"""Add auto_delete_clip_after_processing to tenant_settings.

When enabled the clip-pipeline matching stage soft-clears the raw
video file as soon as every enabled use-case for a clip completes.
Face crops, detection_events, and attendance_records are untouched.

Revision ID: 0083_clip_auto_delete
Revises:     0082_email_config_bcc
Create Date: 2026-06-16
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0083_clip_auto_delete"
down_revision: Union[str, Sequence[str], None] = "0082_email_config_bcc"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    result = bind.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :t AND column_name = :c"
        ),
        {"t": table, "c": column},
    )
    return result.first() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "tenant_settings", "auto_delete_clip_after_processing"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "auto_delete_clip_after_processing",
                sa.Boolean,
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "tenant_settings", "auto_delete_clip_after_processing"):
        op.drop_column("tenant_settings", "auto_delete_clip_after_processing")
