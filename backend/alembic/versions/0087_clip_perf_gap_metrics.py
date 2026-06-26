"""0087 — Gap-closing pipeline performance metrics.

Follow-up to 0086. The per-clip total time had a large (~50-65%)
unattributed gap because clip decrypt/load, frame decode, and detection
efficiency weren't measured. These columns close it so
``total ≈ queue_wait + clip_load + frame_decode + detection(extract) +
face_crop + match`` is fully accounted for:

* ``clip_load_ms``          — read encrypted MP4 + Fernet-decrypt + write temp
* ``frame_decode_ms``       — cv2 decode/sample of frames (``_sample_frames``)
* ``frames_sampled``        — frames handed to detection
* ``frames_motion_skipped`` — frames skipped by the motion pre-screen (UC1)
* ``frames_detected``       — frames with ≥1 face detection
* ``faces_detected``        — total face detections across processed frames

All nullable: rows processed before this ships carry NULL. No grant
change — ``maugood_app`` already holds CRUD on
``clip_processing_results``.

Schema-agnostic + idempotent (information_schema check against
current_schema, unqualified table name).

Revision ID: 0087_clip_perf_gap_metrics
Revises:     0086_clip_perf_metrics
Create Date: 2026-06-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0087_clip_perf_gap_metrics"
down_revision: Union[str, Sequence[str], None] = "0086_clip_perf_metrics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("clip_load_ms", sa.Integer()),
    ("frame_decode_ms", sa.Integer()),
    ("frames_sampled", sa.Integer()),
    ("frames_motion_skipped", sa.Integer()),
    ("frames_detected", sa.Integer()),
    ("faces_detected", sa.Integer()),
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
