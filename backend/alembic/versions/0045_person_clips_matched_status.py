"""Add matched_status column to person_clips for async face matching tracking.

Revision ID: 0045_person_clips_matched_status
Revises: 0044_drop_uploaded_videos
Create Date: 2026-05-11
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0045_person_clips_matched_status"
down_revision: Union[str, None] = "0044_drop_uploaded_videos"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column(
            "matched_status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
    )


def downgrade() -> None:
    op.drop_column("person_clips", "matched_status")
