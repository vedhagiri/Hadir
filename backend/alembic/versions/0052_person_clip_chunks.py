"""0052 — Person clip chunks + detection source + encoding config.

Adds the schema additions for Phase A of the Option 2 (body-presence)
recording flow:

* New per-tenant table ``person_clip_chunks`` — one row per
  intermediate chunk written during a long clip recording. After
  successful merge into the final MP4 the chunks are marked merged=true
  and (depending on tenant config) their intermediate files are deleted.
  Surviving rows give us a verifiable record + crash-resume signal.

* ``person_clips.detection_source`` — text, CHECK in ('face','body','both').
  Records which detector triggered the clip. Defaults to 'face' so existing
  clip rows pre-migration retain their semantics.

* ``person_clips.chunk_count`` — int, default 1. The number of intermediate
  chunks that were merged into the final file. UI uses this to decide
  whether to render the chunk-timeline detail.

* ``cameras.clip_detection_source`` — text, CHECK in ('face','body','both').
  Per-camera override of which detector drives clip recording. Defaults to
  'face' on all existing rows to preserve current behaviour.

* ``tenant_settings.clip_encoding_config`` — JSONB carrying the
  tenant-level encoding knobs the operator can tune in the System
  Settings UI (chunk_duration_sec, video_crf, video_preset,
  resolution_max_height, keep_chunks_after_merge).

References to ``tenants.id`` are unqualified so the migration is
schema-agnostic — env.py sets ``search_path`` to ``<tenant_schema>``
plus the global registry schema, which resolves the bare ``tenants``
name to the global table cross-schema.

Revision ID: 0052_clip_chunks_phase_a
Revises: 0051_face_crops_employee_id
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0052_clip_chunks_phase_a"
down_revision: Union[str, None] = "0051_face_crops_employee_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ENCODING_DEFAULT = (
    '{"chunk_duration_sec": 180, '
    '"video_crf": 23, '
    '"video_preset": "fast", '
    '"resolution_max_height": null, '
    '"keep_chunks_after_merge": false}'
)


def upgrade() -> None:
    # --- person_clips: detection_source + chunk_count ----------------------
    op.add_column(
        "person_clips",
        sa.Column(
            "detection_source",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'face'"),
        ),
    )
    op.create_check_constraint(
        "ck_person_clips_detection_source",
        "person_clips",
        "detection_source IN ('face', 'body', 'both')",
    )
    op.add_column(
        "person_clips",
        sa.Column(
            "chunk_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )

    # --- cameras: clip_detection_source ------------------------------------
    op.add_column(
        "cameras",
        sa.Column(
            "clip_detection_source",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'face'"),
        ),
    )
    op.create_check_constraint(
        "ck_cameras_clip_detection_source",
        "cameras",
        "clip_detection_source IN ('face', 'body', 'both')",
    )

    # --- tenant_settings: clip_encoding_config -----------------------------
    op.add_column(
        "tenant_settings",
        sa.Column(
            "clip_encoding_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(f"'{_ENCODING_DEFAULT}'::jsonb"),
        ),
    )

    # --- person_clip_chunks ------------------------------------------------
    op.create_table(
        "person_clip_chunks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
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
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("chunk_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("chunk_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column(
            "filesize_bytes",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "frame_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "merged",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_unique_constraint(
        "uq_person_clip_chunks_clip_idx",
        "person_clip_chunks",
        ["person_clip_id", "chunk_index"],
    )
    op.create_index(
        "ix_person_clip_chunks_tenant_clip",
        "person_clip_chunks",
        ["tenant_id", "person_clip_id"],
    )
    op.execute("ALTER TABLE person_clip_chunks OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON person_clip_chunks TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE person_clip_chunks_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_person_clip_chunks_tenant_clip", table_name="person_clip_chunks"
    )
    op.drop_constraint(
        "uq_person_clip_chunks_clip_idx",
        "person_clip_chunks",
        type_="unique",
    )
    op.drop_table("person_clip_chunks")

    op.drop_column("tenant_settings", "clip_encoding_config")

    op.drop_constraint(
        "ck_cameras_clip_detection_source", "cameras", type_="check"
    )
    op.drop_column("cameras", "clip_detection_source")

    op.drop_column("person_clips", "chunk_count")
    op.drop_constraint(
        "ck_person_clips_detection_source", "person_clips", type_="check"
    )
    op.drop_column("person_clips", "detection_source")
