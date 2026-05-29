"""0069 — clip video cleanup support.

Storage Analytics gains a clip-video cleanup surface. To support both
manual and automated reclamation without breaking ``face_crops`` and
``clip_processing_results`` FK references to ``person_clips``, the
deletion is **soft**: the disk file is unlinked, ``file_path`` and
``filesize_bytes`` are cleared, and a new ``clip_file_deleted_at``
timestamp records when the reclaim happened.

This migration adds:

* ``person_clips.clip_file_deleted_at`` — TIMESTAMPTZ, nullable.
  NULL = the video file is on disk (or never existed; see the
  ``file_path IS NULL`` row state inherited from the recording
  pipeline's ``abandoned`` / ``failed`` states). A non-NULL value
  means an operator (or the retention sweep) reclaimed the video;
  ``file_path`` will also be NULL and ``filesize_bytes`` will be 0.
* ``tenant_settings.clip_retention_days`` — INTEGER, nullable.
  NULL = manual cleanup only (the default). A positive integer
  enables the P25 retention sweep to soft-clear any clip whose
  ``created_at`` is older than N days. CHECK constraint pins the
  acceptable range to ``[1, 3650]`` so a typo can't reclaim the
  archive instantly.

Index ``ix_person_clips_tenant_deleted_created`` accelerates both
the manual preview query (``WHERE tenant_id = … AND
clip_file_deleted_at IS NULL ORDER BY created_at``) and the sweep's
``LIMIT cap`` selection pass.

Schema-agnostic + idempotent — every existence check uses
``information_schema`` against ``current_schema()`` so re-running
the migration on a partially-upgraded tenant is safe.

Revision ID: 0069_clip_video_cleanup
Revises:     0068_ts_datetime_format
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0069_clip_video_cleanup"
down_revision: Union[str, Sequence[str], None] = "0068_ts_datetime_format"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, column: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND column_name  = :c"
            ),
            {"t": table, "c": column},
        ).scalar()
    )


def _has_constraint(bind, table: str, constraint: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.table_constraints "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND constraint_name = :c"
            ),
            {"t": table, "c": constraint},
        ).scalar()
    )


def _has_index(bind, table: str, index: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM pg_indexes "
                "WHERE schemaname = current_schema() "
                "  AND tablename  = :t "
                "  AND indexname  = :i"
            ),
            {"t": table, "i": index},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "person_clips", "clip_file_deleted_at"):
        op.add_column(
            "person_clips",
            sa.Column(
                "clip_file_deleted_at",
                sa.DateTime(timezone=True),
                nullable=True,
            ),
        )

    if not _has_index(
        bind, "person_clips", "ix_person_clips_tenant_deleted_created"
    ):
        op.create_index(
            "ix_person_clips_tenant_deleted_created",
            "person_clips",
            ["tenant_id", "clip_file_deleted_at", "created_at"],
        )

    if not _has_column(bind, "tenant_settings", "clip_retention_days"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "clip_retention_days",
                sa.Integer(),
                nullable=True,
            ),
        )

    if not _has_constraint(
        bind, "tenant_settings", "ck_tenant_settings_clip_retention_days"
    ):
        op.create_check_constraint(
            "ck_tenant_settings_clip_retention_days",
            "tenant_settings",
            "clip_retention_days IS NULL "
            "OR (clip_retention_days >= 1 AND clip_retention_days <= 3650)",
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_constraint(
        bind, "tenant_settings", "ck_tenant_settings_clip_retention_days"
    ):
        op.drop_constraint(
            "ck_tenant_settings_clip_retention_days",
            "tenant_settings",
            type_="check",
        )
    if _has_column(bind, "tenant_settings", "clip_retention_days"):
        op.drop_column("tenant_settings", "clip_retention_days")

    if _has_index(
        bind, "person_clips", "ix_person_clips_tenant_deleted_created"
    ):
        op.drop_index("ix_person_clips_tenant_deleted_created", table_name="person_clips")
    if _has_column(bind, "person_clips", "clip_file_deleted_at"):
        op.drop_column("person_clips", "clip_file_deleted_at")
