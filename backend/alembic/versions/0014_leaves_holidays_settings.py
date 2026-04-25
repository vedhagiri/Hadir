"""Leaves + holidays module + tenant settings (v1.0 P11).

Four new per-tenant tables plus a column on ``attendance_records``:

* ``leave_types`` — code/name/is_paid/active. Seeded with Annual,
  Sick, Emergency, Unpaid for every tenant.
* ``holidays`` — tenant-wide non-working days. Affects overtime
  calculation when employees DO work that day.
* ``approved_leaves`` — the ledger the engine reads. Submission +
  approval workflow lands in P14/P15; this phase ships only the
  storage + manual create endpoint.
* ``tenant_settings`` — weekend_days JSONB + timezone string. Per
  P11 red line, **timezone is tenant-scoped, not server-scoped**.
* ``attendance_records.leave_type_id`` — nullable FK so the
  engine can mark a row as "covered by leave X" and the API
  surface can return the leave type name.

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema (search_path resolves to
the global registry). Same pattern as 0010-0013.

Revision ID: 0014_leaves_holidays_settings
Revises: 0013_policy_assignments
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_leaves_holidays_settings"
down_revision: Union[str, Sequence[str], None] = "0013_policy_assignments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----- leave_types ----------------------------------------------------
    op.create_table(
        "leave_types",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "is_paid", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id", "code", name="uq_leave_types_tenant_code"
        ),
    )
    op.execute('ALTER TABLE leave_types OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON leave_types TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE leave_types_id_seq TO hadir_app"
    )

    # ----- holidays -------------------------------------------------------
    op.create_table(
        "holidays",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id", "date", name="uq_holidays_tenant_date"
        ),
    )
    op.execute('ALTER TABLE holidays OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE holidays_id_seq TO hadir_app"
    )

    # ----- approved_leaves ------------------------------------------------
    op.create_table(
        "approved_leaves",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
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
        sa.Column(
            "leave_type_id",
            sa.Integer(),
            sa.ForeignKey("leave_types.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "approved_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "approved_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "start_date <= end_date",
            name="ck_approved_leaves_date_range",
        ),
    )
    op.create_index(
        "ix_approved_leaves_tenant_employee_dates",
        "approved_leaves",
        ["tenant_id", "employee_id", "start_date", "end_date"],
    )
    op.execute('ALTER TABLE approved_leaves OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON approved_leaves TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE approved_leaves_id_seq TO hadir_app"
    )

    # ----- tenant_settings ------------------------------------------------
    op.create_table(
        "tenant_settings",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "weekend_days",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(
                "'[\"Friday\", \"Saturday\"]'::jsonb"
            ),
        ),
        sa.Column(
            "timezone",
            sa.Text(),
            nullable=False,
            server_default="Asia/Muscat",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.execute('ALTER TABLE tenant_settings OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO hadir_app"
    )

    # ----- attendance_records.leave_type_id ------------------------------
    op.add_column(
        "attendance_records",
        sa.Column(
            "leave_type_id",
            sa.Integer(),
            sa.ForeignKey("leave_types.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # ----- Seed defaults for the tenant whose schema is being migrated ---
    # Idempotent — runs once per tenant via the orchestrator's loop.

    # leave_types: Annual, Sick, Emergency (paid) + Unpaid (unpaid).
    op.execute(
        """
        INSERT INTO leave_types (tenant_id, code, name, is_paid)
        SELECT t.id, v.code, v.name, v.is_paid
        FROM tenants t
        CROSS JOIN (VALUES
            ('Annual',    'Annual leave',    TRUE),
            ('Sick',      'Sick leave',      TRUE),
            ('Emergency', 'Emergency leave', TRUE),
            ('Unpaid',    'Unpaid leave',    FALSE)
        ) AS v(code, name, is_paid)
        WHERE t.schema_name = current_schema()
        ON CONFLICT (tenant_id, code) DO NOTHING
        """
    )

    # tenant_settings: defaults match Oman (Friday/Saturday weekend,
    # Asia/Muscat timezone). The DB defaults already match these
    # values; we just need a row to exist for the tenant.
    op.execute(
        """
        INSERT INTO tenant_settings (tenant_id)
        SELECT id FROM tenants
        WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_column("attendance_records", "leave_type_id")
    op.drop_table("tenant_settings")
    op.drop_index(
        "ix_approved_leaves_tenant_employee_dates",
        table_name="approved_leaves",
    )
    op.drop_table("approved_leaves")
    op.drop_table("holidays")
    op.drop_table("leave_types")
