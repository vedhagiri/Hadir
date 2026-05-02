"""Photo provenance + approval queue.

Two new columns on ``employee_photos``:

* ``uploaded_by_user_id`` — FK to ``users.id``, nullable, ON DELETE
  SET NULL. Tracks who put the photo in the system. Existing rows
  get NULL (= "uploaded by an operator pre-migration"), which means
  the Employee self-delete path can't touch them — only the Admin/HR
  override path can. This is intentional: legacy photos came from
  Admin/HR via the drawer / bulk upload routes anyway.

* ``approval_status`` — text NOT NULL DEFAULT 'approved', CHECK in
  {approved, pending, rejected}. Existing rows default to
  ``approved`` so the matcher cache keeps using them; new
  Admin/HR-uploaded photos also auto-approve. Employee self-uploads
  land as ``pending`` and an Admin/HR action flips them to
  ``approved`` (or ``rejected``, which the approval endpoint
  outright deletes — ``rejected`` is a transient state not stored
  in practice).

Schema-agnostic — every per-tenant schema gets the same columns
under whatever ``search_path`` Alembic is invoked with.

Revision ID: 0036_photo_provenance_approval
Revises: 0035_org_hierarchy
Create Date: 2026-05-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0036_photo_provenance_approval"
down_revision: Union[str, None] = "0035_org_hierarchy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "employee_photos",
        sa.Column(
            "uploaded_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "employee_photos",
        sa.Column(
            "approval_status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'approved'"),
        ),
    )
    op.create_check_constraint(
        "ck_employee_photos_approval_status",
        "employee_photos",
        "approval_status IN ('approved', 'pending', 'rejected')",
    )
    # Index for the Admin/HR pending-queue endpoint — bounded query
    # but the index keeps it cheap as the queue grows.
    op.create_index(
        "ix_employee_photos_pending",
        "employee_photos",
        ["tenant_id", "approval_status"],
        postgresql_where=sa.text("approval_status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("ix_employee_photos_pending", table_name="employee_photos")
    op.drop_constraint(
        "ck_employee_photos_approval_status",
        "employee_photos",
        type_="check",
    )
    op.drop_column("employee_photos", "approval_status")
    op.drop_column("employee_photos", "uploaded_by_user_id")
