"""Add employees.reports_to_employee_id (employee→employee org chart).

The HR roster references managers by **name**, not email, and most
employees have no email at all — so a user-based ``reports_to_user_id``
can't model the org chart without inventing dummy users. This adds a
direct employee→employee link the import resolves by name/code, with
``ON DELETE SET NULL`` so deleting a manager doesn't cascade-delete
their reports. ``reports_to_user_id`` stays for tenants whose staff
have real logins.

Revision ID: 0084_reports_to_employee
Revises:     0083_clip_auto_delete
Create Date: 2026-06-17
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0084_reports_to_employee"
down_revision: Union[str, Sequence[str], None] = "0083_clip_auto_delete"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    result = bind.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :t AND column_name = :c "
            "AND table_schema = current_schema()"
        ),
        {"t": table, "c": column},
    )
    return result.first() is not None


def _has_index(bind, index: str) -> bool:
    result = bind.execute(
        sa.text(
            "SELECT 1 FROM pg_indexes "
            "WHERE indexname = :i AND schemaname = current_schema()"
        ),
        {"i": index},
    )
    return result.first() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "employees", "reports_to_employee_id"):
        op.add_column(
            "employees",
            sa.Column(
                "reports_to_employee_id",
                sa.Integer,
                sa.ForeignKey("employees.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
    if not _has_index(bind, "ix_employees_reports_to_employee"):
        op.create_index(
            "ix_employees_reports_to_employee",
            "employees",
            ["tenant_id", "reports_to_employee_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "ix_employees_reports_to_employee"):
        op.drop_index("ix_employees_reports_to_employee", table_name="employees")
    if _has_column(bind, "employees", "reports_to_employee_id"):
        op.drop_column("employees", "reports_to_employee_id")
