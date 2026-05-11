"""Add person_count to person_clips.

Tracks how many distinct persons were detected during the clip
recording period. Backfills existing rows with 0.

Revision ID: 0038_person_clips_person_count
Revises: 0037_person_clips
Create Date: 2026-05-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0038_person_clips_person_count"
down_revision: Union[str, None] = "0037_person_clips"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column("person_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("person_clips", "person_count")
