"""P28.8 — Camera metadata: auto-detected RTSP properties + manual fields.

Adds seven nullable columns to ``cameras``:

* Auto-detected by the worker on first successful RTSP read
  (never edited via the API):
  - ``detected_resolution_w`` / ``detected_resolution_h`` (INTEGER)
  - ``detected_fps`` (NUMERIC(5,2))
  - ``detected_codec`` (TEXT — e.g. "H264", "H265", "MJPG")
  - ``detected_at`` (TIMESTAMPTZ)

* Manual entry by Admin:
  - ``brand`` (TEXT — "Hikvision", "Dahua", "Axis", …)
  - ``model`` (TEXT — "DS-2CD2143G2-I")
  - ``mount_location`` (TEXT — free text, max 200 chars enforced at API)

Backfill: existing rows get NULL for all seven. The auto-detected
fields populate naturally next time their workers (re)start.

Schema-agnostic + idempotent.

Revision ID: 0031_p28_8_camera_metadata
Revises: 0030_p28_7_employee_lifecycle
Create Date: 2026-04-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0031_p28_8_camera_metadata"
down_revision: Union[str, Sequence[str], None] = "0030_p28_7_employee_lifecycle"
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

    pairs = [
        ("detected_resolution_w", sa.Integer()),
        ("detected_resolution_h", sa.Integer()),
        ("detected_fps", sa.Numeric(5, 2)),
        ("detected_codec", sa.Text()),
        ("detected_at", sa.DateTime(timezone=True)),
        ("brand", sa.Text()),
        ("model", sa.Text()),
        ("mount_location", sa.Text()),
    ]
    for name, type_ in pairs:
        if not _has_column(bind, "cameras", name):
            op.add_column("cameras", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    for name in (
        "mount_location",
        "model",
        "brand",
        "detected_at",
        "detected_codec",
        "detected_fps",
        "detected_resolution_h",
        "detected_resolution_w",
    ):
        if _has_column(bind, "cameras", name):
            op.drop_column("cameras", name)
