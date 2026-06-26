"""0088 — Detection lock-wait vs compute split.

Detection (``face_extract_duration_ms``) bundles two very different
costs on the CPU-bound box: time spent *waiting* for the process-wide
``_detect_lock`` (shared with the 21 live-capture workers) and time
spent *actually running* YOLO/InsightFace after acquiring it. Splitting
them tells us whether to fix lock contention (process clips off-peak /
lower live load) or detection cost (imgsz / frame count / model):

* ``detect_lock_wait_ms`` — ms waiting to acquire the detect lock
* ``detect_compute_ms``   — ms running detection after the lock is held

Both nullable: rows processed before this ship carry NULL. No grant
change. Schema-agnostic + idempotent.

Revision ID: 0088_clip_detect_lock_split
Revises:     0087_clip_perf_gap_metrics
Create Date: 2026-06-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0088_clip_detect_lock_split"
down_revision: Union[str, Sequence[str], None] = "0087_clip_perf_gap_metrics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("detect_lock_wait_ms", sa.Integer()),
    ("detect_compute_ms", sa.Integer()),
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
