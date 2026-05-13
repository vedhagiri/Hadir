"""0053 — Flip cameras.clip_detection_source default to 'body'.

Phase A landed migration 0052 with the column default set to 'face' so
existing tenants kept their pre-migration trigger semantics. Operator
feedback after Phase C is that body-presence is the right *default* —
faces are often invisible (back-of-head, looking down at a desk,
seated employees) and the recording should keep running while any
human body is in frame.

This migration changes the server_default for new cameras only; rows
created before this migration keep whatever value the operator
already set (typically 'face' on a tenant that pre-dates 0052).
Operators who want to flip every existing camera to body in one go
can do so via:

    UPDATE cameras SET clip_detection_source = 'body'
    WHERE clip_detection_source = 'face';

run inside the tenant's schema. The CameraDrawer always lets the
operator override per-camera regardless of the default.

Revision ID: 0053_body_default
Revises: 0052_clip_chunks_phase_a
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0053_body_default"
down_revision: Union[str, None] = "0052_clip_chunks_phase_a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "cameras",
        "clip_detection_source",
        server_default=sa.text("'body'"),
    )


def downgrade() -> None:
    op.alter_column(
        "cameras",
        "clip_detection_source",
        server_default=sa.text("'face'"),
    )
