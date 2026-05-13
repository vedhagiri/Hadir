"""Add pipeline metadata columns to person_clips + clip_processing_results table.

New columns on person_clips:
  encoding_start_at, encoding_end_at   — when ffmpeg encoding ran
  fps_recorded                          — actual FPS measured from timestamps
  resolution_w, resolution_h            — frame dimensions from RTSP stream

New table clip_processing_results:
  Per-use-case face-matching results (UC1=yolo+face, UC2=insightface+crops,
  UC3=insightface direct). One row per (clip, use_case). Unique constraint
  prevents duplicate runs — UPSERT on conflict.

Revision ID: 0048_person_clips_pipeline_metadata
Revises: 0047_person_clips_face_match
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048_clips_pipeline_meta"
down_revision: Union[str, None] = "0047_person_clips_face_match"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- New columns on person_clips ------------------------------------------
    op.add_column(
        "person_clips",
        sa.Column("encoding_start_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("encoding_end_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("fps_recorded", sa.Float(), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("resolution_w", sa.Integer(), nullable=True),
    )
    op.add_column(
        "person_clips",
        sa.Column("resolution_h", sa.Integer(), nullable=True),
    )

    # --- clip_processing_results table ----------------------------------------
    op.create_table(
        "clip_processing_results",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("public.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "person_clip_id",
            sa.Integer(),
            sa.ForeignKey("person_clips.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # 'uc1' = yolo+face pipeline, 'uc2' = insightface + crop storage,
        # 'uc3' = insightface direct (no crop storage)
        sa.Column("use_case", sa.Text(), nullable=False),
        # pending | processing | completed | failed
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("face_extract_duration_ms", sa.Integer(), nullable=True),
        sa.Column("match_duration_ms", sa.Integer(), nullable=True),
        sa.Column(
            "face_crop_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "matched_employees",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "unknown_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        # [{employee_id, name, confidence, best_crop_path}]
        sa.Column("match_details", postgresql.JSONB(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_cpr_tenant_clip",
        "clip_processing_results",
        ["tenant_id", "person_clip_id"],
    )
    op.create_unique_constraint(
        "uq_cpr_clip_usecase",
        "clip_processing_results",
        ["person_clip_id", "use_case"],
    )
    op.execute(
        "ALTER TABLE clip_processing_results OWNER TO maugood_admin"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON clip_processing_results TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE clip_processing_results_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_table("clip_processing_results")
    op.drop_column("person_clips", "resolution_h")
    op.drop_column("person_clips", "resolution_w")
    op.drop_column("person_clips", "fps_recorded")
    op.drop_column("person_clips", "encoding_end_at")
    op.drop_column("person_clips", "encoding_start_at")
