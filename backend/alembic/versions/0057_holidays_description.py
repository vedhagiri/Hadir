"""0057 — Add description column to holidays.

BUG-021 — operators want a free-text description column on holiday
rows so the import .xlsx can carry context beyond the holiday name
(e.g. "Public holiday, government offices closed"). Nullable text;
existing rows stay at NULL.

Revision ID: 0057_holidays_description
Revises: 0056_encoding_faster
Create Date: 2026-05-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0057_holidays_description"
down_revision: str = "0056_encoding_faster"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "holidays",
        sa.Column("description", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("holidays", "description")
