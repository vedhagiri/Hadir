"""Per-user preferred_theme + preferred_density (v1.0 P22).

Mirrors the P21 ``preferred_language`` shape: two nullable columns
on ``users`` with CHECK constraints locking the values to the
documented enums. ``NULL`` means "follow system" for theme and
"comfortable" for density — the frontend resolver consumes both.

Schema-agnostic: ``users`` lives per-tenant, so the migration runs
cleanly under each tenant schema via the orchestrator.

Revision ID: 0023_users_theme_density
Revises: 0022_users_preferred_language
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0023_users_theme_density"
down_revision: Union[str, Sequence[str], None] = "0022_users_preferred_language"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("preferred_theme", sa.Text(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("preferred_density", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        "ck_users_preferred_theme",
        "users",
        "preferred_theme IS NULL OR preferred_theme IN ('system','light','dark')",
    )
    op.create_check_constraint(
        "ck_users_preferred_density",
        "users",
        "preferred_density IS NULL OR preferred_density IN ('compact','comfortable')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_users_preferred_density", "users", type_="check"
    )
    op.drop_constraint(
        "ck_users_preferred_theme", "users", type_="check"
    )
    op.drop_column("users", "preferred_density")
    op.drop_column("users", "preferred_theme")
