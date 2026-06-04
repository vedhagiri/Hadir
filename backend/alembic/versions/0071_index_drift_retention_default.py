"""0071 — heal person_clips index drift + clip-retention default.

Two release-hardening fixes, both schema-agnostic + idempotent
(``information_schema`` / ``pg_indexes`` existence checks against
``current_schema()`` so re-running on any partially-upgraded tenant is
safe).

1. **Index drift heal.** Migration 0054 created
   ``ix_person_clips_tenant_recording_status (tenant_id,
   recording_status)`` but at least one tenant schema reached head with
   the column + CHECK present and the index **missing** (a force-stamp
   left 0054 partially applied — observed on ``tenant_giitm``). This
   re-creates the index only where it's absent; a no-op on schemas that
   already have it.

2. **Clip-retention default for NEW tenants.** ``clip_retention_days``
   shipped NULL (0069) → the retention sweep skips clips → unbounded
   video growth. This sets a server-side column DEFAULT of 90 days so
   every newly-provisioned tenant is bounded out of the box.

   **Deliberately NOT a backfill.** Existing tenant rows keep their
   current value (NULL = keep-forever). Auto-populating them would make
   the next retention sweep start *deleting* already-accumulated
   footage — a data-policy decision that must be made consciously per
   tenant via Settings → Storage, not imposed by a migration. The
   DEFAULT only affects rows inserted after this migration.

Revision ID: 0071_index_drift_retention_default
Revises:     0070_employee_photo_content_hash
Create Date: 2026-06-03
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


# NB: revision id kept <= 32 chars (alembic_version.version_num is
# varchar(32)); the filename can be longer than the id.
revision: str = "0071_idx_drift_clip_retention"
down_revision: Union[str, Sequence[str], None] = "0070_employee_photo_content_hash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


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


def upgrade() -> None:
    bind = op.get_bind()

    # (1) Heal the missing index — no-op where 0054 already created it.
    if _has_column(bind, "person_clips", "recording_status") and not _has_index(
        bind, "person_clips", "ix_person_clips_tenant_recording_status"
    ):
        op.create_index(
            "ix_person_clips_tenant_recording_status",
            "person_clips",
            ["tenant_id", "recording_status"],
        )

    # (2) Default clip retention for NEW tenants only (existing NULL rows
    #     are left untouched — see the module docstring).
    if _has_column(bind, "tenant_settings", "clip_retention_days"):
        op.execute(
            text(
                "ALTER TABLE tenant_settings "
                "ALTER COLUMN clip_retention_days SET DEFAULT 90"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()

    # Reverse only the column DEFAULT. The index is 0054's artifact — this
    # migration merely healed a missing copy, so we do NOT drop it here
    # (that would remove a legitimate index on schemas where 0054 created
    # it correctly).
    if _has_column(bind, "tenant_settings", "clip_retention_days"):
        op.execute(
            text(
                "ALTER TABLE tenant_settings "
                "ALTER COLUMN clip_retention_days DROP DEFAULT"
            )
        )
