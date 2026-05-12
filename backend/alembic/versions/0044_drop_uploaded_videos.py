"""Drop uploaded_videos table — Upload Video feature removed.

Revision ID: 0044_drop_uploaded_videos
Revises: 0043_uploaded_videos
Create Date: 2026-05-11
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0044_drop_uploaded_videos"
down_revision: Union[str, None] = "0043_uploaded_videos"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS uploaded_videos CASCADE")


def downgrade() -> None:
    pass
