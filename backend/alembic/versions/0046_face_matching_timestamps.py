"""Add face_matching_start/end columns to person_clips.

Revision ID: 0046_face_matching_timestamps
Revises: 0045_person_clips_matched_status
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0046_face_matching_timestamps"
down_revision: Union[str, None] = "0045_person_clips_matched_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column("face_matching_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("face_matching_end", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("person_clips", "face_matching_end")
    op.drop_column("person_clips", "face_matching_start")
