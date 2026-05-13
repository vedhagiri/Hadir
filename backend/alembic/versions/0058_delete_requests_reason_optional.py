"""0058 — Make delete_requests.reason nullable.

Operator request — reasons on permanent-delete submissions are now
optional. The column was originally NOT NULL with a 10-char Pydantic
floor; both constraints relax to "free-text up to 500 chars or NULL".

Revision ID: 0058_dr_reason_optional
Revises: 0057_holidays_description
Create Date: 2026-05-14
"""

from __future__ import annotations

from alembic import op


revision: str = "0058_dr_reason_optional"
down_revision: str = "0057_holidays_description"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    op.alter_column(
        "delete_requests",
        "reason",
        nullable=True,
    )


def downgrade() -> None:
    # Refuses to drop NULL rows — set them to a placeholder first if
    # rolling back with data already in the column.
    op.alter_column(
        "delete_requests",
        "reason",
        nullable=False,
    )
