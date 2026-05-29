"""0070 — employee_photos content hash for duplicate detection.

Reference-image uploads now enforce a per-employee duplicate guard
across every entry point (drawer / bulk / self-upload / map-from-
unidentified). The guard keys on the SHA-256 of the *plaintext* image
bytes, stored alongside each photo row.

This migration adds:

* ``employee_photos.content_sha256`` — TEXT, nullable. NULL on legacy
  rows (pre-0070) and on rows whose source content couldn't be hashed.
* Index ``ix_employee_photos_dedup`` on
  ``(tenant_id, employee_id, content_sha256)`` — backs the
  "does this employee already have this exact image" lookup.

Schema-agnostic + idempotent — every existence check uses
``information_schema`` / ``pg_indexes`` against ``current_schema()`` so
re-running on a partially-upgraded tenant is safe.

Revision ID: 0070_employee_photo_content_hash
Revises:     0069_clip_video_cleanup
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0070_employee_photo_content_hash"
down_revision: Union[str, Sequence[str], None] = "0069_clip_video_cleanup"
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

    if not _has_column(bind, "employee_photos", "content_sha256"):
        op.add_column(
            "employee_photos",
            sa.Column("content_sha256", sa.Text(), nullable=True),
        )

    if not _has_index(bind, "employee_photos", "ix_employee_photos_dedup"):
        op.create_index(
            "ix_employee_photos_dedup",
            "employee_photos",
            ["tenant_id", "employee_id", "content_sha256"],
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_index(bind, "employee_photos", "ix_employee_photos_dedup"):
        op.drop_index(
            "ix_employee_photos_dedup", table_name="employee_photos"
        )
    if _has_column(bind, "employee_photos", "content_sha256"):
        op.drop_column("employee_photos", "content_sha256")
