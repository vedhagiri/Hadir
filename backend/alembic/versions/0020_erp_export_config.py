"""ERP file-drop export config (v1.0 P19).

One per-tenant table:

* ``erp_export_config`` (tenant_id PK) — operator-managed file-drop
  schedule. ``output_path`` is a tenant-relative path constrained
  server-side to ``/data/erp/{tenant_id}/...`` (the load-bearing P19
  red line). ``schedule_cron`` drives the runner.

Schema-agnostic — FKs target unqualified ``tenants(id)``. Same
pattern as 0010-0019. Provisioning seeds an empty row per tenant
inline.

Revision ID: 0020_erp_export_config
Revises: 0019_email_and_schedules
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0020_erp_export_config"
down_revision: Union[str, Sequence[str], None] = "0019_email_and_schedules"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "erp_export_config",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "format", sa.Text(), nullable=False, server_default="csv"
        ),
        sa.Column("output_path", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "schedule_cron", sa.Text(), nullable=False, server_default=""
        ),
        sa.Column(
            "window_days",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_status", sa.Text(), nullable=True),
        sa.Column("last_run_path", sa.Text(), nullable=True),
        sa.Column("last_run_error", sa.Text(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "format IN ('csv','json')", name="ck_erp_export_config_format"
        ),
    )
    op.execute('ALTER TABLE erp_export_config OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON erp_export_config TO maugood_app"
    )
    op.execute(
        """
        INSERT INTO erp_export_config (tenant_id)
        SELECT id FROM tenants WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("erp_export_config")
