"""Custom fields editor (v1.0 P12).

Two new per-tenant tables:

* ``custom_fields`` — Admin-defined extra columns for the employee
  record. id, tenant_id, name, code, type ('text'|'number'|'date'|
  'select'), options JSONB nullable (only meaningful for select),
  required bool, display_order. Unique (tenant_id, code).
* ``custom_field_values`` — one row per (employee, field) carrying the
  value as text. Typed on read; we store text so empty values can
  round-trip without a "this date is invalid" footgun. Unique
  (tenant_id, employee_id, field_id) so PATCH is a single upsert.
  ON DELETE CASCADE from both employees and custom_fields — deleting
  a field also deletes its values (the editor warns the operator
  before sending DELETE).

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema. Same pattern as 0010-0014.

Revision ID: 0015_custom_fields
Revises: 0014_leaves_holidays_settings
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015_custom_fields"
down_revision: Union[str, Sequence[str], None] = "0014_leaves_holidays_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----- custom_fields --------------------------------------------------
    op.create_table(
        "custom_fields",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column(
            "options",
            sa.dialects.postgresql.JSONB(),
            nullable=True,
        ),
        sa.Column(
            "required",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "display_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
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
            "tenant_id", "code", name="uq_custom_fields_tenant_code"
        ),
        sa.CheckConstraint(
            "type IN ('text','number','date','select')",
            name="ck_custom_fields_type",
        ),
        sa.CheckConstraint(
            "(type <> 'select') OR (options IS NOT NULL)",
            name="ck_custom_fields_select_options",
        ),
    )
    op.execute('ALTER TABLE custom_fields OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON custom_fields TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE custom_fields_id_seq TO maugood_app"
    )

    # ----- custom_field_values --------------------------------------------
    op.create_table(
        "custom_field_values",
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
            "field_id",
            sa.Integer(),
            sa.ForeignKey("custom_fields.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("value", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "employee_id",
            "field_id",
            name="uq_custom_field_values_tenant_emp_field",
        ),
    )
    op.execute('ALTER TABLE custom_field_values OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_values TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE custom_field_values_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_table("custom_field_values")
    op.drop_table("custom_fields")
