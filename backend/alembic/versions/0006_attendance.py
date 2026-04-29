"""Shift policies + attendance records + seed pilot Fixed policy.

Revision ID: 0006_attendance
Revises: 0005_photo_embeddings
Create Date: 2026-04-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_attendance"
down_revision: Union[str, Sequence[str], None] = "0005_photo_embeddings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.create_table(
        "shift_policies",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("config", postgresql.JSONB(), nullable=False),
        sa.Column("active_from", sa.Date(), nullable=False),
        sa.Column("active_until", sa.Date(), nullable=True),
        sa.CheckConstraint(
            "type IN ('Fixed','Flex','Ramadan','Custom')",
            name="ck_shift_policies_type",
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "attendance_records",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "employee_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.employees.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("in_time", sa.Time(), nullable=True),
        sa.Column("out_time", sa.Time(), nullable=True),
        sa.Column("total_minutes", sa.Integer(), nullable=True),
        sa.Column(
            "policy_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.shift_policies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("late", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("early_out", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "short_hours", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("absent", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "overtime_minutes", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "employee_id",
            "date",
            name="uq_attendance_records_tenant_emp_date",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_attendance_records_tenant_date",
        "attendance_records",
        ["tenant_id", "date"],
        schema=SCHEMA,
    )

    # --- Grants -------------------------------------------------------------
    for table in ("shift_policies", "attendance_records"):
        op.execute(f'ALTER TABLE "{SCHEMA}"."{table}" OWNER TO maugood_admin')
        op.execute(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{SCHEMA}"."{table}" TO maugood_app'
        )
    op.execute(
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{SCHEMA}" TO maugood_app'
    )

    # --- Seed pilot policy --------------------------------------------------
    # One Fixed policy for tenant 1 — the exact shape the pilot plan calls
    # for. active_from is the current date at migration time so the
    # scheduler's first recompute finds a policy in effect.
    #
    # We bind parameters rather than inline the JSON literal because
    # SQLAlchemy's pyformat paramstyle would otherwise misread ``:15`` /
    # ``:8`` in the JSON body as bind markers.
    import json as _json  # local import keeps migration top-level clean

    op.execute(
        sa.text(
            f"""
            INSERT INTO "{SCHEMA}".shift_policies
                (tenant_id, name, type, config, active_from, active_until)
            VALUES (
                1, :name, 'Fixed', CAST(:config AS jsonb),
                CURRENT_DATE, NULL
            )
            """
        ).bindparams(
            name="Default 07:30–15:30",
            config=_json.dumps(
                {
                    "start": "07:30",
                    "end": "15:30",
                    "grace_minutes": 15,
                    "required_hours": 8,
                }
            ),
        )
    )


def downgrade() -> None:
    op.drop_index("ix_attendance_records_tenant_date", table_name="attendance_records", schema=SCHEMA)
    op.drop_table("attendance_records", schema=SCHEMA)
    op.drop_table("shift_policies", schema=SCHEMA)
