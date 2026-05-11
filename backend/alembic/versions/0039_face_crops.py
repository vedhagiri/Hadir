"""Add face_crops table for crops extracted from person clips.

Revision ID: 0039_face_crops
Revises: 0038_person_clips_person_count
Create Date: 2026-05-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0039_face_crops"
down_revision: Union[str, None] = "0038_person_clips_person_count"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "face_crops",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer, nullable=False, index=True),
        sa.Column("camera_id", sa.Integer, nullable=False, index=True),
        sa.Column("person_clip_id", sa.Integer, nullable=False, index=True),
        sa.Column("event_timestamp", sa.Text, nullable=False),
        sa.Column("face_index", sa.Integer, nullable=False, server_default=sa.text("1")),
        sa.Column("file_path", sa.Text, nullable=True),
        sa.Column("quality_score", sa.Float, nullable=False, server_default=sa.text("0")),
        sa.Column("sharpness", sa.Float, nullable=False, server_default=sa.text("0")),
        sa.Column("detection_score", sa.Float, nullable=False, server_default=sa.text("0")),
        sa.Column("width", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("height", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_face_crops_tenant_camera_created",
        "face_crops",
        ["tenant_id", "camera_id", "created_at"],
    )
    op.create_index(
        "ix_face_crops_tenant_clip",
        "face_crops",
        ["tenant_id", "person_clip_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_face_crops_tenant_clip")
    op.drop_index("ix_face_crops_tenant_camera_created")
    op.drop_table("face_crops")
