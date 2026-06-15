"""Add bcc_address to email_config.

Revision ID: 0082_email_config_bcc
Revises: 0081_attendance_email_manager
Create Date: 2026-06-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0082_email_config_bcc"
down_revision = "0081_attendance_email_manager"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_config",
        sa.Column(
            "bcc_address",
            sa.Text,
            nullable=False,
            server_default="",
        ),
    )


def downgrade() -> None:
    op.drop_column("email_config", "bcc_address")
