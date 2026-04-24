"""Employees + employee_photos + seed 3 departments.

``employees`` carries the business ``employee_code`` (unique per tenant) and
a soft-delete-friendly ``status`` column — hard deletes are reserved for
the PDPL right-to-erasure flow that ships in v1.0. ``employee_photos`` is
a schema-only placeholder; the actual file ingestion + Fernet encryption
path lands in P6.

We also seed three pilot departments (Engineering, Operations,
Administration) so a fresh DB can run the employee-import flow without an
extra setup step.

Revision ID: 0002_employees
Revises: 0001_initial
Create Date: 2026-04-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_employees"
down_revision: Union[str, Sequence[str], None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.create_table(
        "employees",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("employee_code", sa.Text(), nullable=False),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column(
            "department_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.departments.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id", "employee_code", name="uq_employees_tenant_code"
        ),
        sa.CheckConstraint(
            "status IN ('active','inactive')", name="ck_employees_status"
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "employee_photos",
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
        sa.Column("angle", sa.Text(), nullable=False, server_default="front"),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column(
            "approved_by_user_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "angle IN ('front','left','right','other')",
            name="ck_employee_photos_angle",
        ),
        schema=SCHEMA,
    )

    # --- Grants -------------------------------------------------------------
    # Ownership goes to hadir_admin for parity with P2 tables; hadir_app gets
    # full CRUD. Neither table has the audit-log restriction.
    for table in ("employees", "employee_photos"):
        op.execute(f'ALTER TABLE "{SCHEMA}"."{table}" OWNER TO hadir_admin')
        op.execute(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{SCHEMA}"."{table}" TO hadir_app'
        )

    # Re-grant sequence privs — the new SERIAL PKs introduced sequences the
    # app role needs USAGE/SELECT on. ALTER DEFAULT PRIVILEGES from P2
    # covered future sequences, but a bulk grant is cheap and keeps this
    # migration self-contained.
    op.execute(
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{SCHEMA}" TO hadir_app'
    )

    # --- Seed departments ---------------------------------------------------
    # Three pilot-wide departments per tenant 1. Codes chosen to be short
    # and collision-safe against a real Omran org chart (we'll swap these
    # for the client's real structure during P14 deployment).
    op.execute(
        f"""
        INSERT INTO "{SCHEMA}".departments (tenant_id, code, name) VALUES
          (1, 'ENG', 'Engineering'),
          (1, 'OPS', 'Operations'),
          (1, 'ADM', 'Administration')
        """
    )


def downgrade() -> None:
    op.execute(f'DELETE FROM "{SCHEMA}".departments WHERE tenant_id = 1 AND code IN (\'ENG\',\'OPS\',\'ADM\')')
    op.drop_table("employee_photos", schema=SCHEMA)
    op.drop_table("employees", schema=SCHEMA)
