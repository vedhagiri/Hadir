"""Request state machine — submission + approval workflow (v1.0 P13).

Two new per-tenant tables:

* ``requests`` — exception or leave submitted by an Employee. Carries
  per-decision-stage actor + comment fields (manager/hr/admin) plus a
  status column constrained by CHECK to the eight named states. The
  state machine itself is enforced in application code; the CHECK
  guarantees no rogue value lands in the column.
* ``request_attachments`` — supporting files (e.g. medical
  certificate) the employee uploads alongside the request. Schema +
  grants only; the upload UI lands in P14.

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema. Same pattern as 0010-0015.

Revision ID: 0016_requests
Revises: 0015_custom_fields
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_requests"
down_revision: Union[str, Sequence[str], None] = "0015_custom_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----- requests --------------------------------------------------------
    op.create_table(
        "requests",
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
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("reason_category", sa.Text(), nullable=False),
        sa.Column("reason_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("target_date_start", sa.Date(), nullable=False),
        sa.Column("target_date_end", sa.Date(), nullable=True),
        sa.Column(
            "leave_type_id",
            sa.Integer(),
            sa.ForeignKey("leave_types.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="submitted",
        ),
        # Per-stage actor + decision metadata.
        sa.Column(
            "manager_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "manager_decision_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("manager_comment", sa.Text(), nullable=True),
        sa.Column(
            "hr_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "hr_decision_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("hr_comment", sa.Text(), nullable=True),
        sa.Column(
            "admin_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "admin_decision_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("admin_comment", sa.Text(), nullable=True),
        sa.Column(
            "submitted_at",
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "type IN ('exception','leave')", name="ck_requests_type"
        ),
        sa.CheckConstraint(
            "status IN ("
            "'submitted','manager_approved','manager_rejected',"
            "'hr_approved','hr_rejected',"
            "'admin_approved','admin_rejected','cancelled'"
            ")",
            name="ck_requests_status",
        ),
        sa.CheckConstraint(
            "target_date_end IS NULL OR target_date_end >= target_date_start",
            name="ck_requests_date_range",
        ),
        # Leave requests must reference a leave type; exceptions must not.
        sa.CheckConstraint(
            "(type = 'leave' AND leave_type_id IS NOT NULL) "
            "OR (type = 'exception' AND leave_type_id IS NULL)",
            name="ck_requests_leave_type_consistency",
        ),
    )
    op.create_index(
        "ix_requests_tenant_status",
        "requests",
        ["tenant_id", "status"],
    )
    op.create_index(
        "ix_requests_tenant_employee_status",
        "requests",
        ["tenant_id", "employee_id", "status"],
    )
    op.create_index(
        "ix_requests_tenant_manager_status",
        "requests",
        ["tenant_id", "manager_user_id", "status"],
    )
    op.execute('ALTER TABLE requests OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON requests TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE requests_id_seq TO maugood_app"
    )

    # ----- request_attachments --------------------------------------------
    op.create_table(
        "request_attachments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "request_id",
            sa.Integer(),
            sa.ForeignKey("requests.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("original_filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "size_bytes", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.execute('ALTER TABLE request_attachments OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON request_attachments TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE request_attachments_id_seq TO maugood_app"
    )


def downgrade() -> None:
    op.drop_table("request_attachments")
    op.drop_index("ix_requests_tenant_manager_status", table_name="requests")
    op.drop_index("ix_requests_tenant_employee_status", table_name="requests")
    op.drop_index("ix_requests_tenant_status", table_name="requests")
    op.drop_table("requests")
