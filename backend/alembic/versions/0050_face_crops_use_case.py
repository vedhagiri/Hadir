"""0050 — Add use_case column to face_crops table.

Revision ID: 0050_face_crops_use_case
Revises: 0049_clip_recording_enabled
Create Date: 2026-05-12

Adds ``use_case TEXT NULL`` to ``face_crops`` so each crop row records
which processing pipeline (uc1 / uc2) created it. Existing rows get
NULL (treated as "unknown" by the API — they pre-date the column).
"""

import sqlalchemy as sa
from alembic import op

revision = "0050_face_crops_use_case"
down_revision = "0049_clip_recording_enabled"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "face_crops",
        sa.Column("use_case", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("face_crops", "use_case")
