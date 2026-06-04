"""0072 — Per-camera live_matching_enabled.

Moves live face-recognition/matching from a single tenant-wide switch
(``tenant_settings.live_matching_enabled``, migration 0059) to a
per-camera control. Each camera now independently gates the live
recognition pipeline: the analyzer runs full face detection + embedding
+ matcher_cache calls only when ``detection_enabled AND
live_matching_enabled`` for that camera.

This migration:

* ``cameras.live_matching_enabled`` — BOOLEAN NOT NULL, server_default
  ``false``. The server_default keeps any out-of-band INSERT safe; the
  API create path defaults it to False (a freshly-added camera does
  nothing until the operator turns on what they want).
* **Backfill (preserve current behaviour on upgrade)**: each existing
  camera inherits its tenant's current
  ``tenant_settings.live_matching_enabled`` value, so an upgrade is a
  no-op behaviourally — cameras that were matching keep matching. The
  COALESCE guards the case where a tenant has no ``tenant_settings``
  row (defaults to false).

The tenant-wide ``tenant_settings.live_matching_enabled`` column is
left in place (legacy) — it is no longer consumed to drive workers,
only read once here for the backfill.

Schema-agnostic + idempotent: existence checks use
``information_schema`` against ``current_schema()`` so re-running on a
partially-upgraded tenant is safe; unqualified table names so the
backfill runs per-schema under the alembic search_path.

Revision ID: 0072_cameras_live_matching
Revises:     0071_idx_drift_clip_retention
Create Date: 2026-06-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0072_cameras_live_matching"
down_revision: Union[str, Sequence[str], None] = "0071_idx_drift_clip_retention"
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


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "cameras", "live_matching_enabled"):
        op.add_column(
            "cameras",
            sa.Column(
                "live_matching_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )

    # Backfill from the (legacy) tenant-wide flag so the upgrade
    # preserves current behaviour. Unqualified table names → runs in the
    # active schema. COALESCE guards a tenant with no tenant_settings row.
    if _has_column(bind, "tenant_settings", "live_matching_enabled"):
        op.execute(
            text(
                "UPDATE cameras c SET live_matching_enabled = COALESCE("
                "  (SELECT ts.live_matching_enabled FROM tenant_settings ts "
                "   WHERE ts.tenant_id = c.tenant_id), false)"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "cameras", "live_matching_enabled"):
        op.drop_column("cameras", "live_matching_enabled")
