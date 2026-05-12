"""No-op — table already created by earlier run; will be dropped in 0044.

Revision ID: 0043_uploaded_videos
Revises: 0042_clip_matched_employees
Create Date: 2026-05-11
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0043_uploaded_videos"
down_revision: Union[str, None] = "0042_clip_matched_employees"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # uploaded_videos table was created by an earlier run that left no
    # migration file.  This no‑op preserves the chain so that 0044 can
    # drop it cleanly.
    pass


def downgrade() -> None:
    pass
