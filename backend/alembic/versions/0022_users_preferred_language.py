"""Per-user preferred_language for i18n (v1.0 P21).

Adds a single nullable column on ``users``. ``NULL`` means
"follow the browser's Accept-Language" — the row only fills in
when the user explicitly picks a language from the topbar
switcher. CHECK-constrained to the two supported codes so a
buggy client can't write a third value.

Schema-agnostic: ``users`` lives per-tenant, so the migration runs
cleanly under each tenant schema via the orchestrator.

Revision ID: 0022_users_preferred_language
Revises: 0021_notifications
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0022_users_preferred_language"
down_revision: Union[str, Sequence[str], None] = "0021_notifications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("preferred_language", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        "ck_users_preferred_language",
        "users",
        "preferred_language IS NULL OR preferred_language IN ('en','ar')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_users_preferred_language", "users", type_="check"
    )
    op.drop_column("users", "preferred_language")
