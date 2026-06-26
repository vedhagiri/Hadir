"""0086 — Pipeline performance metrics on clip_processing_results.

Adds four nullable per-(clip, use_case) performance columns so the new
Pipeline Analytics tab can show where processing time goes without
relying on external shell scripts. All are lightweight values the
pipeline already has (or cheaply samples) at finish time:

* ``queue_wait_ms``  — ms spent waiting in the cropping queue
  (cropping start − submit). Surfaces queue-delay bottlenecks.
* ``face_crop_ms``   — ms spent saving + encrypting face crops
  (separate from detection time in ``face_extract_duration_ms``).
* ``cpu_percent``    — host CPU% sampled when the clip finished
  cropping (best-effort host snapshot; workers are shared so this is
  a sample, not a per-clip attribution).
* ``memory_mb``      — backend process RSS (MB) at the same sample.

All nullable: existing rows + any clip processed before this ships
simply carry NULL. No grant change — ``maugood_app`` already holds
SELECT/INSERT/UPDATE/DELETE on ``clip_processing_results``.

Schema-agnostic + idempotent: existence checks run against
``current_schema()`` so re-running on a partially-upgraded tenant is
safe; unqualified table name lands the columns in whichever schema the
alembic search_path points at.

Revision ID: 0086_clip_perf_metrics
Revises:     0085_tenant_settings_reconnect
Create Date: 2026-06-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0086_clip_perf_metrics"
down_revision: Union[str, Sequence[str], None] = "0085_tenant_settings_reconnect"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("queue_wait_ms", sa.Integer()),
    ("face_crop_ms", sa.Integer()),
    ("cpu_percent", sa.Float()),
    ("memory_mb", sa.Float()),
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
    for name, type_ in _COLUMNS:
        if not _has_column(bind, "clip_processing_results", name):
            op.add_column(
                "clip_processing_results",
                sa.Column(name, type_, nullable=True),
            )


def downgrade() -> None:
    bind = op.get_bind()
    for name, _type in reversed(_COLUMNS):
        if _has_column(bind, "clip_processing_results", name):
            op.drop_column("clip_processing_results", name)
