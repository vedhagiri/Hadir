"""Policy assignments (v1.0 P9).

Per-tenant table that maps a ``shift_policies`` row to a
**resolution scope** — tenant-wide, per-department, or per-employee.
The attendance engine's policy resolver walks the cascade
``employee > department > tenant > legacy fallback`` to pick which
policy applies to a given (employee, date) tuple.

Schema-agnostic FK to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema (search_path resolves to the
global registry). Same pattern as 0010 / 0011 / 0012.

Constraints:

* ``scope_type IN ('tenant','department','employee')`` — CHECK.
* ``(scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type !=
  'tenant' AND scope_id IS NOT NULL)`` — CHECK so the two columns
  stay coherent.
* ``policy_id`` FK with ON DELETE CASCADE — dropping a policy
  cleans up its assignments.

Note: we don't add an FK constraint on ``scope_id`` because the
referenced table varies (departments vs employees vs nothing). The
application validates referenced existence at the API boundary.

Revision ID: 0013_policy_assignments
Revises: 0012_manager_assignments
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_policy_assignments"
down_revision: Union[str, Sequence[str], None] = "0012_manager_assignments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "policy_assignments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "policy_id",
            sa.Integer(),
            sa.ForeignKey("shift_policies.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("scope_type", sa.Text(), nullable=False),
        sa.Column("scope_id", sa.Integer(), nullable=True),
        sa.Column("active_from", sa.Date(), nullable=False),
        sa.Column("active_until", sa.Date(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "scope_type IN ('tenant','department','employee')",
            name="ck_policy_assignments_scope_type",
        ),
        sa.CheckConstraint(
            "(scope_type = 'tenant' AND scope_id IS NULL) "
            "OR (scope_type IN ('department','employee') AND scope_id IS NOT NULL)",
            name="ck_policy_assignments_scope_id_coherent",
        ),
    )

    op.create_index(
        "ix_policy_assignments_tenant_scope",
        "policy_assignments",
        ["tenant_id", "scope_type", "scope_id"],
    )

    # Grants — same pattern as every other per-tenant table.
    op.execute('ALTER TABLE policy_assignments OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON policy_assignments TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE policy_assignments_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_policy_assignments_tenant_scope", table_name="policy_assignments"
    )
    op.drop_table("policy_assignments")
