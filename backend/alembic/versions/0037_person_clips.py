"""Person clips table — short video clips saved on person detection.

Schema-agnostic: every per-tenant schema gets ``person_clips`` under
whatever ``search_path`` Alembic is invoked with.

Revision ID: 0037_person_clips
Revises: 0036_photo_provenance_approval
Create Date: 2026-05-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0037_person_clips"
down_revision: Union[str, None] = "0036_photo_provenance_approval"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "person_clips",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("public.tenants.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("camera_id", sa.Integer(), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("track_id", sa.Text(), nullable=True),
        sa.Column("detection_event_id", sa.Integer(), sa.ForeignKey("detection_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("clip_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("clip_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("filesize_bytes", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("frame_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_person_clips_tenant_camera_created",
        "person_clips",
        ["tenant_id", "camera_id", "created_at"],
    )
    op.create_index(
        "ix_person_clips_tenant_employee_created",
        "person_clips",
        ["tenant_id", "employee_id", "created_at"],
    )
    op.execute("ALTER TABLE person_clips OWNER TO maugood_admin")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON person_clips TO maugood_app")


def downgrade() -> None:
    op.execute("DELETE FROM person_clips")
    op.drop_table("person_clips")
