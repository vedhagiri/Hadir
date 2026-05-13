"""0049 — Add clip_recording_enabled column to cameras table.

Revision ID: 0049_clip_recording_enabled
Revises: 0048_clips_pipeline_meta
Create Date: 2026-05-12

Adds a per-camera boolean flag that controls whether person-clip video
files are saved when a person is detected. When False the capture
pipeline keeps running (detection, tracking, events) but no video is
written to disk and no person_clips rows are inserted. Default True
preserves the pre-migration behaviour for all existing cameras.
"""

import sqlalchemy as sa
from alembic import op

revision = "0049_clip_recording_enabled"
down_revision = "0048_clips_pipeline_meta"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cameras",
        sa.Column(
            "clip_recording_enabled",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )


def downgrade() -> None:
    op.drop_column("cameras", "clip_recording_enabled")
