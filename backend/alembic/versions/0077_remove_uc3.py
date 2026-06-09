"""0077 — Remove use-case 3 (UC3) data + crop files.

UC3 is being fully removed from the product (code removal lands alongside
this migration). This migration purges its persisted data per tenant
schema:

* Best-effort unlinks every on-disk ``face_crops.file_path`` whose
  ``use_case = 'uc3'`` (the Fernet-encrypted crop JPEGs), then DELETEs
  those ``face_crops`` rows.
* DELETEs every ``clip_processing_results`` row with ``use_case = 'uc3'``.
* Strips ``'uc3'`` from any explicit ``tenant_settings.clip_pipeline_use_cases``
  JSONB array (defensive — the runtime default already drops to
  ``uc1, uc2`` in code). An array that becomes empty is set back to NULL
  ("inherit the now-(uc1,uc2) default").

``person_clips`` rows are untouched — UC1 takes over ownership of the
canonical ``matched_employees`` backfill in the pipeline code, so existing
match data stays valid.

Schema-agnostic + idempotent: unqualified table names land in whichever
schema the Alembic search_path points at; re-running deletes nothing more.
No grant changes (deleting rows / unlinking files touches no GRANT).
Irreversible — ``downgrade`` is a no-op (the deleted rows + files cannot
be reconstructed).

Revision ID: 0077_remove_uc3
Revises:     0076_cameras_default_logs_only
Create Date: 2026-06-09
"""

from __future__ import annotations

import logging
import os
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0077_remove_uc3"
down_revision: Union[str, Sequence[str], None] = "0076_cameras_default_logs_only"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.0077_remove_uc3")


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
                "WHERE table_schema = current_schema() AND table_name = :t"
            ),
            {"t": table},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    # --- face_crops: unlink encrypted crop files, then delete rows --------------
    if _has_table(bind, "face_crops"):
        paths = bind.execute(
            text(
                "SELECT file_path FROM face_crops "
                "WHERE use_case = 'uc3' AND file_path IS NOT NULL"
            )
        ).scalars().all()
        removed = 0
        for p in paths:
            try:
                os.unlink(p)
                removed += 1
            except FileNotFoundError:
                pass
            except OSError as exc:  # permissions / read-only / etc — best effort
                logger.warning("0077: could not unlink uc3 crop %s: %s", p, exc)
        deleted = bind.execute(
            text("DELETE FROM face_crops WHERE use_case = 'uc3'")
        ).rowcount
        logger.info(
            "0077: face_crops uc3 purge — rows=%s files_unlinked=%s",
            deleted, removed,
        )

    # --- clip_processing_results: delete uc3 rows -------------------------------
    if _has_table(bind, "clip_processing_results"):
        deleted = bind.execute(
            text("DELETE FROM clip_processing_results WHERE use_case = 'uc3'")
        ).rowcount
        logger.info("0077: clip_processing_results uc3 purge — rows=%s", deleted)

    # --- tenant_settings: strip 'uc3' from explicit enable lists ---------------
    if _has_column(bind, "tenant_settings", "clip_pipeline_use_cases"):
        # Remove the "uc3" element from the JSONB array; collapse an
        # emptied array back to NULL (inherit the now-(uc1,uc2) default).
        bind.execute(
            text(
                "UPDATE tenant_settings "
                "SET clip_pipeline_use_cases = ("
                "  SELECT NULLIF("
                "    COALESCE(jsonb_agg(e) FILTER (WHERE e <> '\"uc3\"'::jsonb), '[]'::jsonb),"
                "    '[]'::jsonb"
                "  )"
                "  FROM jsonb_array_elements(clip_pipeline_use_cases) e"
                ") "
                "WHERE clip_pipeline_use_cases @> '[\"uc3\"]'::jsonb"
            )
        )


def downgrade() -> None:
    # Irreversible: deleted rows + unlinked crop files cannot be restored.
    pass
