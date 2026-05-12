"""Add person_start/end, face_matching_duration_ms, face_matching_progress.

Revision ID: 0047_person_clips_face_matching_fields
Revises: 0046_face_matching_timestamps
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0047_person_clips_face_match"
down_revision: Union[str, None] = "0046_face_matching_timestamps"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column("person_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("person_end", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("face_matching_duration_ms", sa.Integer(), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column(
            "face_matching_progress",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("person_clips", "face_matching_progress")
    op.drop_column("person_clips", "face_matching_duration_ms")
    op.drop_column("person_clips", "person_end")
    op.drop_column("person_clips", "person_start")
