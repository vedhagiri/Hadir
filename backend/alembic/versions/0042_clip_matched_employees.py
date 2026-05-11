"""Add matched_employees JSONB column to person_clips for real-time face matching.

Stores employee IDs matched during clip recording so the UI can display
who was identified without re-querying detection_events.

Revision ID: 0042_person_clips_matched_employees
Revises: 0041_face_crops_status
Create Date: 2026-05-11
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0042_clip_matched_employees"
down_revision: Union[str, None] = "0041_face_crops_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column(
            "matched_employees",
            JSONB,
            nullable=False,
            server_default="[]",
        ),
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON person_clips TO maugood_app")


def downgrade() -> None:
    op.drop_column("person_clips", "matched_employees")
