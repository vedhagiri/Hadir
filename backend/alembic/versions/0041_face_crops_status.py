"""Add face_crops_status column to person_clips for manual processing.

Revision ID: 0041_face_crops_status
Revises: 0040_face_crops_grants
Create Date: 2026-05-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0041_face_crops_status"
down_revision: Union[str, None] = "0040_face_crops_grants"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column(
            "face_crops_status",
            sa.Text,
            nullable=False,
            server_default="pending",
        ),
    )
    op.execute(
        "ALTER TABLE person_clips ADD CONSTRAINT "
        "ck_person_clips_face_crops_status "
        "CHECK (face_crops_status IN "
        "('pending','processing','processed','failed'))"
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON person_clips TO maugood_app")


def downgrade() -> None:
    op.drop_constraint(
        "ck_person_clips_face_crops_status", "person_clips", type_="check"
    )
    op.drop_column("person_clips", "face_crops_status")
