"""P28.7 — Employee lifecycle: extended fields + delete_requests + former-match.

Three additive surfaces, all schema-agnostic + idempotent:

1. ``employees`` gains seven nullable columns:
   - ``designation`` (TEXT, max 80 enforced at API layer; column is plain TEXT)
   - ``phone`` (TEXT, max 30 enforced at API layer)
   - ``reports_to_user_id`` (FK users(id) ON DELETE SET NULL — separate from
     ``manager_assignments`` which drives approval scope. This is the HR
     org chart.)
   - ``joining_date`` / ``relieving_date`` (DATE)
   - ``deactivated_at`` (TIMESTAMPTZ — set when status flipped to inactive)
   - ``deactivation_reason`` (TEXT — free-text)

2. ``detection_events`` gains two columns:
   - ``former_employee_match`` (BOOLEAN NOT NULL DEFAULT false) — set when
     the matcher hits an *inactive* employee. The primary ``employee_id``
     stays NULL in that case so attendance queries (which filter on
     ``employee_id IS NOT NULL``) automatically exclude former employees.
   - ``former_match_employee_id`` (FK employees(id) ON DELETE SET NULL) —
     stores who the inactive match resolved to so the security report
     can join to the snapshot. NULL on hard-delete (cascade) which
     correctly degrades the report to "former employee, identity gone".

3. New per-tenant ``delete_requests`` table — separate from the existing
   ``requests`` table (which is for attendance/leave exceptions).

Backfill: existing rows get NULL for the new nullable columns and
``false`` for ``former_employee_match`` (the column default).

Revision ID: 0030_p28_7_employee_lifecycle
Revises: 0029_tenant_settings_detection
Create Date: 2026-04-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0030_p28_7_employee_lifecycle"
down_revision: Union[str, Sequence[str], None] = "0029_tenant_settings_detection"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, column: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND column_name  = :c"
            ),
            {"t": table, "c": column},
        ).scalar()
    )


def _has_table(bind, table: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t"
            ),
            {"t": table},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    # 1. employees columns ---------------------------------------------------

    if not _has_column(bind, "employees", "designation"):
        op.add_column(
            "employees",
            sa.Column("designation", sa.Text(), nullable=True),
        )
    if not _has_column(bind, "employees", "phone"):
        op.add_column("employees", sa.Column("phone", sa.Text(), nullable=True))
    if not _has_column(bind, "employees", "reports_to_user_id"):
        op.add_column(
            "employees",
            sa.Column(
                "reports_to_user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
    if not _has_column(bind, "employees", "joining_date"):
        op.add_column(
            "employees", sa.Column("joining_date", sa.Date(), nullable=True)
        )
    if not _has_column(bind, "employees", "relieving_date"):
        op.add_column(
            "employees", sa.Column("relieving_date", sa.Date(), nullable=True)
        )
    if not _has_column(bind, "employees", "deactivated_at"):
        op.add_column(
            "employees",
            sa.Column(
                "deactivated_at", sa.DateTime(timezone=True), nullable=True
            ),
        )
    if not _has_column(bind, "employees", "deactivation_reason"):
        op.add_column(
            "employees", sa.Column("deactivation_reason", sa.Text(), nullable=True)
        )

    # 2. detection_events columns -------------------------------------------

    if not _has_column(bind, "detection_events", "former_employee_match"):
        op.add_column(
            "detection_events",
            sa.Column(
                "former_employee_match",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
    if not _has_column(bind, "detection_events", "former_match_employee_id"):
        op.add_column(
            "detection_events",
            sa.Column(
                "former_match_employee_id",
                sa.Integer(),
                sa.ForeignKey("employees.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
        op.create_index(
            "ix_detection_events_former_match_employee_id",
            "detection_events",
            ["former_match_employee_id"],
        )

    # 3. delete_requests table ---------------------------------------------

    if not _has_table(bind, "delete_requests"):
        op.create_table(
            "delete_requests",
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
                "requested_by",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'pending'"),
            ),
            sa.Column(
                "hr_decided_by",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "hr_decided_at", sa.DateTime(timezone=True), nullable=True
            ),
            sa.Column("hr_comment", sa.Text(), nullable=True),
            sa.Column(
                "admin_override_by",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "admin_override_at", sa.DateTime(timezone=True), nullable=True
            ),
            sa.Column("admin_override_comment", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
            sa.CheckConstraint(
                "status IN ('pending','approved','rejected','admin_override','cancelled')",
                name="ck_delete_requests_status",
            ),
        )
        # Partial unique: at most ONE pending request per employee.
        op.execute(
            text(
                "CREATE UNIQUE INDEX uq_delete_requests_pending_per_employee "
                "ON delete_requests (tenant_id, employee_id) "
                "WHERE status = 'pending'"
            )
        )
        # Apply standard maugood_app grants — everything except DELETE
        # because the table is append-only by design (decisions stay on
        # record). DELETE is reserved for the admin engine for cleanup.
        op.execute(
            text(
                "GRANT SELECT, INSERT, UPDATE ON delete_requests "
                "TO maugood_app"
            )
        )
        op.execute(
            text(
                "GRANT USAGE, SELECT ON SEQUENCE delete_requests_id_seq "
                "TO maugood_app"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "delete_requests"):
        op.drop_table("delete_requests")

    if _has_column(bind, "detection_events", "former_match_employee_id"):
        op.drop_index(
            "ix_detection_events_former_match_employee_id",
            table_name="detection_events",
        )
        op.drop_column("detection_events", "former_match_employee_id")
    if _has_column(bind, "detection_events", "former_employee_match"):
        op.drop_column("detection_events", "former_employee_match")

    for col in (
        "deactivation_reason",
        "deactivated_at",
        "relieving_date",
        "joining_date",
        "reports_to_user_id",
        "phone",
        "designation",
    ):
        if _has_column(bind, "employees", col):
            op.drop_column("employees", col)
