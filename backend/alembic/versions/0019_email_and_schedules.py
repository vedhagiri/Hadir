"""Email config + scheduled reports (v1.0 P18).

Three per-tenant tables:

* ``email_config`` (tenant_id PK) — provider choice + provider
  credentials. Secrets (``smtp_password_encrypted``,
  ``graph_client_secret_encrypted``) are Fernet-encrypted before
  insert; the app role only ever sees the ciphertext.
* ``report_schedules`` — operator-defined recurring jobs. Stores the
  cron expression + filter config + recipient emails + bookkeeping
  fields (``last_run_at``, ``last_run_status``, ``next_run_at``).
  ``active=false`` opts a row out of the runner.
* ``report_runs`` — one row per execution. The runner inserts a row
  with status=``running`` before doing any work and updates it to
  ``succeeded`` / ``failed`` on completion. Carries the resolved
  output file path (relative to the configured root) so the
  signed-URL download endpoint can stream the file later.

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema. Same pattern as 0010-0018.

Provisioning seeds an empty ``email_config`` row per tenant
(provider=``smtp``, enabled=false) so a freshly-provisioned tenant
just needs the operator to fill in credentials in the UI.

Revision ID: 0019_email_and_schedules
Revises: 0018_notifications_queue
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0019_email_and_schedules"
down_revision: Union[str, Sequence[str], None] = "0018_notifications_queue"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----- email_config ---------------------------------------------------
    op.create_table(
        "email_config",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "provider", sa.Text(), nullable=False, server_default="smtp"
        ),
        sa.Column("smtp_host", sa.Text(), nullable=False, server_default=""),
        sa.Column("smtp_port", sa.Integer(), nullable=False, server_default="587"),
        sa.Column(
            "smtp_username", sa.Text(), nullable=False, server_default=""
        ),
        sa.Column("smtp_password_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "smtp_use_tls",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "graph_tenant_id", sa.Text(), nullable=False, server_default=""
        ),
        sa.Column(
            "graph_client_id", sa.Text(), nullable=False, server_default=""
        ),
        sa.Column("graph_client_secret_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "from_address", sa.Text(), nullable=False, server_default=""
        ),
        sa.Column("from_name", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "provider IN ('smtp','microsoft_graph')",
            name="ck_email_config_provider",
        ),
    )
    op.execute('ALTER TABLE email_config OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON email_config TO hadir_app"
    )
    # Seed an empty row for the migrating tenant — provisioning does
    # the same inline for new tenants.
    op.execute(
        """
        INSERT INTO email_config (tenant_id)
        SELECT id FROM tenants WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )

    # ----- report_schedules ----------------------------------------------
    op.create_table(
        "report_schedules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "report_type", sa.Text(), nullable=False, server_default="attendance"
        ),
        sa.Column("format", sa.Text(), nullable=False),
        sa.Column(
            "filter_config",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "recipients",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("schedule_cron", sa.Text(), nullable=False),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_status", sa.Text(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
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
        sa.CheckConstraint(
            "format IN ('xlsx','pdf')", name="ck_report_schedules_format"
        ),
        sa.CheckConstraint(
            "report_type IN ('attendance')",
            name="ck_report_schedules_report_type",
        ),
    )
    op.create_index(
        "ix_report_schedules_tenant_active_next",
        "report_schedules",
        ["tenant_id", "active", "next_run_at"],
    )
    op.execute('ALTER TABLE report_schedules OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedules TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE report_schedules_id_seq TO hadir_app"
    )

    # ----- report_runs ---------------------------------------------------
    op.create_table(
        "report_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "schedule_id",
            sa.Integer(),
            sa.ForeignKey("report_schedules.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="running"
        ),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("file_size_bytes", sa.Integer(), nullable=True),
        sa.Column(
            "recipients_delivered_to",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "delivery_mode", sa.Text(), nullable=True
        ),  # 'attached' | 'link' | null when not yet decided
        sa.CheckConstraint(
            "status IN ('running','succeeded','failed')",
            name="ck_report_runs_status",
        ),
    )
    op.create_index(
        "ix_report_runs_tenant_schedule_started",
        "report_runs",
        ["tenant_id", "schedule_id", "started_at"],
    )
    op.execute('ALTER TABLE report_runs OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON report_runs TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE report_runs_id_seq TO hadir_app"
    )


def downgrade() -> None:
    op.drop_index("ix_report_runs_tenant_schedule_started", table_name="report_runs")
    op.drop_table("report_runs")
    op.drop_index(
        "ix_report_schedules_tenant_active_next", table_name="report_schedules"
    )
    op.drop_table("report_schedules")
    op.drop_table("email_config")
