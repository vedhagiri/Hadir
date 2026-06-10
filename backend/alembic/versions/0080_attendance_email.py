"""0080 — Attendance status emails: tenant toggles + delivery log.

Two additions for the attendance email notification feature (employees
receive a branded email when their day is computed Present / Late /
Absent, via the tenant's Settings → Email provider):

* ``tenant_settings.attendance_email_config`` — JSONB carrying the
  three tenant-wide toggles the Admin flips in Settings →
  Notifications: ``{"present": bool, "late": bool, "absent": bool}``.
  All three default **false** — the feature is strictly opt-in so a
  deploy never starts mass-emailing employees by surprise.

* New per-tenant table ``attendance_email_log`` — one row per
  (employee, date, status) email. The row is the queue entry AND the
  durable delivery log: enqueued by the attendance scheduler when a
  status materialises, drained by the notification email worker
  (3 attempts, errors recorded), and listed read-only in the UI for
  troubleshooting. The unique constraint makes enqueueing idempotent —
  recompute ticks can fire the producer repeatedly without duplicate
  emails.

References to ``tenants.id`` are unqualified so the migration is
schema-agnostic — env.py sets ``search_path`` per tenant schema.

Revision ID: 0080_attendance_email
Revises:     0079_remove_clip_recording
Create Date: 2026-06-10
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0080_attendance_email"
down_revision: Union[str, Sequence[str], None] = "0079_remove_clip_recording"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CONFIG_DEFAULT = '{"present": false, "late": false, "absent": false}'


def upgrade() -> None:
    # --- tenant_settings: attendance_email_config ---------------------------
    op.add_column(
        "tenant_settings",
        sa.Column(
            "attendance_email_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(f"'{_CONFIG_DEFAULT}'::jsonb"),
        ),
    )

    # --- attendance_email_log ------------------------------------------------
    op.create_table(
        "attendance_email_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "employee_id",
            sa.Integer(),
            sa.ForeignKey("employees.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        # Snapshot of what was actually emailed — filled at send time so
        # the log answers "what did we send, to whom, when".
        sa.Column("recipient_email", sa.Text(), nullable=True),
        sa.Column("subject", sa.Text(), nullable=True),
        sa.Column("in_time", sa.Time(), nullable=True),
        sa.Column("out_time", sa.Time(), nullable=True),
        sa.Column("late_minutes", sa.Integer(), nullable=True),
        sa.Column("total_minutes", sa.Integer(), nullable=True),
        sa.Column(
            "attempts",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("skipped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('present', 'late', 'absent')",
            name="ck_attendance_email_log_status",
        ),
    )
    op.create_unique_constraint(
        "uq_attendance_email_log_emp_date_status",
        "attendance_email_log",
        ["tenant_id", "employee_id", "date", "status"],
    )
    op.create_index(
        "ix_attendance_email_log_tenant_created",
        "attendance_email_log",
        ["tenant_id", sa.text("created_at DESC")],
    )
    # Partial index keeps the worker's pending scan cheap as the log grows.
    op.create_index(
        "ix_attendance_email_log_pending",
        "attendance_email_log",
        ["tenant_id", "id"],
        postgresql_where=sa.text(
            "sent_at IS NULL AND skipped_at IS NULL"
        ),
    )
    op.execute("ALTER TABLE attendance_email_log OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_email_log TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE attendance_email_log_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_attendance_email_log_pending", table_name="attendance_email_log"
    )
    op.drop_index(
        "ix_attendance_email_log_tenant_created",
        table_name="attendance_email_log",
    )
    op.drop_constraint(
        "uq_attendance_email_log_emp_date_status",
        "attendance_email_log",
        type_="unique",
    )
    op.drop_table("attendance_email_log")

    op.drop_column("tenant_settings", "attendance_email_config")
