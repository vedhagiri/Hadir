"""Keep the original file name + size of clips whose video was deleted.

Both clip-video delete paths (auto-delete after processing in
``clip_pipeline.pipeline`` and the Storage Analytics clean-up in
``storage_analytics.cleanup``) soft-clear a ``person_clips`` row by
setting ``clip_file_deleted_at``, ``file_path = NULL`` and
``filesize_bytes = 0``. Storage totals rely on those semantics, but the
UI then had nothing to show for the clip except a synthesised
``recording-…`` name and an empty size, which read as a broken row.

Changes (all on ``person_clips``, all nullable):

* ``deleted_file_name``      TEXT   — basename of the file that was removed.
* ``deleted_filesize_bytes`` BIGINT — the file size before removal.
* ``file_deleted_reason``    TEXT   — ``auto_after_processing`` |
  ``cleanup`` | ``daily_cleanup`` (NULL for legacy rows deleted before
  this migration whose reason cannot be recovered).

Backfill: rows already soft-cleared (``clip_file_deleted_at IS NOT
NULL AND deleted_file_name IS NULL``) are filled from the per-clip
``clip_cleanup.auto_deleted_after_processing`` audit rows, which carry
``file_path`` + ``filesize_bytes``. The Storage Analytics clean-up
writes one *batch* audit row with no per-clip file names, so rows it
cleared cannot be name/size-backfilled and keep NULLs; their
``file_deleted_reason`` is still recovered by matching
``clip_file_deleted_at`` to the nearest preceding batch audit row
(``clip_cleanup.executed`` → ``cleanup``,
``clip_cleanup.daily_auto_executed`` → ``daily_cleanup``) within a
15-minute window. ``audit_log`` is only read (SELECT) here — never
updated or deleted.

Schema-agnostic + idempotent: every existence check runs against
``current_schema()`` and the backfill only touches rows still missing
``deleted_file_name``. ``maugood_app`` already holds full CRUD on
``person_clips``; adding columns does not change grants.

Revision ID: 0097_clip_deleted_file_meta
Revises:     0096_device_push_tokens
Create Date: 2026-10-14
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0097_clip_deleted_file_meta"
down_revision: Union[str, Sequence[str], None] = "0096_device_push_tokens"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("deleted_file_name", sa.Text()),
    ("deleted_filesize_bytes", sa.BigInteger()),
    ("file_deleted_reason", sa.Text()),
)


# Read-only against audit_log. Latest audit row per clip wins.
BACKFILL_SQL = """
UPDATE person_clips AS pc
   SET deleted_file_name = regexp_replace(a.file_path, '^.*/', ''),
       deleted_filesize_bytes = CASE
           WHEN a.filesize_txt ~ '^[0-9]+$' THEN a.filesize_txt::bigint
           ELSE NULL
       END,
       file_deleted_reason = COALESCE(pc.file_deleted_reason,
                                      'auto_after_processing')
  FROM (
        SELECT DISTINCT ON (al.tenant_id, al.entity_id)
               al.tenant_id,
               al.entity_id,
               al.after ->> 'file_path'      AS file_path,
               al.after ->> 'filesize_bytes' AS filesize_txt
          FROM audit_log AS al
         WHERE al.action = 'clip_cleanup.auto_deleted_after_processing'
           AND al.entity_type = 'person_clips'
           AND al.after IS NOT NULL
           AND COALESCE(al.after ->> 'file_path', '') <> ''
         ORDER BY al.tenant_id, al.entity_id, al.id DESC
       ) AS a
 WHERE pc.clip_file_deleted_at IS NOT NULL
   AND pc.deleted_file_name IS NULL
   AND a.tenant_id = pc.tenant_id
   AND a.entity_id = pc.id::text
"""


# Reason only, for rows cleared by a Storage Analytics clean-up batch.
# The batch writes clip_file_deleted_at slightly after the audit row's
# transaction-start created_at; pick the nearest preceding batch row.
REASON_BACKFILL_SQL = """
UPDATE person_clips AS pc
   SET file_deleted_reason = (
        SELECT CASE al.action
                   WHEN 'clip_cleanup.daily_auto_executed' THEN 'daily_cleanup'
                   ELSE 'cleanup'
               END
          FROM audit_log AS al
         WHERE al.tenant_id = pc.tenant_id
           AND al.entity_type = 'person_clips'
           AND al.action IN ('clip_cleanup.executed',
                             'clip_cleanup.daily_auto_executed')
           AND al.created_at <= pc.clip_file_deleted_at + interval '5 seconds'
           AND al.created_at >= pc.clip_file_deleted_at - interval '15 minutes'
         ORDER BY al.created_at DESC
         LIMIT 1
       )
 WHERE pc.clip_file_deleted_at IS NOT NULL
   AND pc.file_deleted_reason IS NULL
"""


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


def _has_table(bind, table: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t"
            ),
            {"t": table},
        ).scalar()
    )


def backfill(bind) -> int:
    """Fill the new columns for already-deleted clips. Returns rowcount."""

    if not (_has_table(bind, "person_clips") and _has_table(bind, "audit_log")):
        return 0
    result = bind.execute(text(BACKFILL_SQL))
    bind.execute(text(REASON_BACKFILL_SQL))
    return int(result.rowcount or 0)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "person_clips"):
        return

    for name, type_ in _COLUMNS:
        if not _has_column(bind, "person_clips", name):
            op.add_column(
                "person_clips", sa.Column(name, type_, nullable=True)
            )

    backfill(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "person_clips"):
        return
    for name, _type in reversed(_COLUMNS):
        if _has_column(bind, "person_clips", name):
            op.drop_column("person_clips", name)
