"""0081 — Attendance emails: manager copies.

Adds ``attendance_email_log.recipient_kind`` ('employee' | 'manager')
so each notification can fan out to the employee AND their reporting
manager as two independently-tracked deliveries. The unique
constraint widens to include the kind — one employee row + one
manager row per (employee, date, status), still idempotent.

Schema-agnostic; existing rows backfill to 'employee' via the column
default.

Revision ID: 0081_attendance_email_manager
Revises:     0080_attendance_email
Create Date: 2026-06-11
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0081_attendance_email_manager"
down_revision: Union[str, Sequence[str], None] = "0080_attendance_email"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "attendance_email_log",
        sa.Column(
            "recipient_kind",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'employee'"),
        ),
    )
    op.create_check_constraint(
        "ck_attendance_email_log_recipient_kind",
        "attendance_email_log",
        "recipient_kind IN ('employee', 'manager')",
    )
    op.drop_constraint(
        "uq_attendance_email_log_emp_date_status",
        "attendance_email_log",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_attendance_email_log_emp_date_status_kind",
        "attendance_email_log",
        ["tenant_id", "employee_id", "date", "status", "recipient_kind"],
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM attendance_email_log WHERE recipient_kind <> 'employee'"
    )
    op.drop_constraint(
        "uq_attendance_email_log_emp_date_status_kind",
        "attendance_email_log",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_attendance_email_log_emp_date_status",
        "attendance_email_log",
        ["tenant_id", "employee_id", "date", "status"],
    )
    op.drop_constraint(
        "ck_attendance_email_log_recipient_kind",
        "attendance_email_log",
        type_="check",
    )
    op.drop_column("attendance_email_log", "recipient_kind")
