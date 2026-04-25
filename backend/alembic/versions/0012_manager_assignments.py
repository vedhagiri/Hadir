"""Manager assignments (v1.0 P8).

Per-tenant table mapping a Manager user to one or more employees. Two
visible properties drive the migration:

* The pair is unique — a given Manager appears once per employee.
* At most one **primary** manager exists per employee, enforced via a
  partial unique index — so a buggy POST that tries to set two
  primaries fails at the database, not in the app code. Per the P8
  red line, "the primary-manager constraint is enforced at the DB
  level, not just application logic."

Schema-agnostic FK to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema (search_path resolves to the
global registry). Same pattern as 0010 / 0011.

Revision ID: 0012_manager_assignments
Revises: 0011_oidc_config
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_manager_assignments"
down_revision: Union[str, Sequence[str], None] = "0011_oidc_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "manager_assignments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "manager_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
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
            "is_primary",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "employee_id",
            "manager_user_id",
            name="uq_manager_assignments_tenant_employee_manager",
        ),
    )

    # Partial unique index for the primary-manager rule. Postgres
    # supports partial indexes natively; this is the load-bearing
    # constraint the P8 red line calls out.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_manager_assignments_one_primary_per_employee
        ON manager_assignments (tenant_id, employee_id)
        WHERE is_primary = TRUE
        """
    )

    # Grants — same pattern as every other per-tenant table.
    op.execute('ALTER TABLE manager_assignments OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON manager_assignments TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE manager_assignments_id_seq TO hadir_app"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS uq_manager_assignments_one_primary_per_employee"
    )
    op.drop_table("manager_assignments")
