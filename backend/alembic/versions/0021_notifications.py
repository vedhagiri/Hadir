"""Notifications + per-user preferences (v1.0 P20).

Replaces the P16 ``notifications_queue`` stub: that table was a
landing pad for the override-recipients list while the delivery
side was deferred. P20 ships the real feature with two new tables.

* ``notifications`` — queue + history. One row per recipient × event.
  ``read_at`` flips when the user opens it in-app. ``email_sent_at``
  flips when the delivery worker successfully dispatches via the
  P18 email provider (the worker honours each user's
  ``notification_preferences`` row — the per-user-per-category
  ``email`` flag is authoritative, the P20 red line).
* ``notification_preferences`` — composite PK
  ``(user_id, tenant_id, category)``. A missing row means
  "defaults" — both ``in_app`` and ``email`` true. Operators
  flip rows from the Settings → Notifications page.

Schema-agnostic FKs to unqualified ``tenants(id)``.

Revision ID: 0021_notifications
Revises: 0020_erp_export_config
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0021_notifications"
down_revision: Union[str, Sequence[str], None] = "0020_erp_export_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CATEGORIES = (
    "approval_assigned",
    "approval_decided",
    "overtime_flagged",
    "camera_unreachable",
    "report_ready",
    "admin_override",
)


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("link_url", sa.Text(), nullable=True),
        sa.Column(
            "payload",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "email_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("email_failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "category IN (" + ",".join(f"'{c}'" for c in _CATEGORIES) + ")",
            name="ck_notifications_category",
        ),
    )
    op.create_index(
        "ix_notifications_tenant_user_unread",
        "notifications",
        ["tenant_id", "user_id", "read_at"],
    )
    op.create_index(
        "ix_notifications_tenant_email_pending",
        "notifications",
        ["tenant_id", "email_sent_at", "email_failed_at"],
    )
    op.execute('ALTER TABLE notifications OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO maugood_app"
    )

    op.create_table(
        "notification_preferences",
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("category", sa.Text(), primary_key=True),
        sa.Column(
            "in_app",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "email",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "category IN (" + ",".join(f"'{c}'" for c in _CATEGORIES) + ")",
            name="ck_notification_preferences_category",
        ),
    )
    op.execute('ALTER TABLE notification_preferences OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences "
        "TO maugood_app"
    )

    # The P16 stub queue is no longer written to. Drop it now —
    # nothing in production depends on it (M2 still in dev), and
    # leaving an unused table around adds noise to per-tenant schemas.
    op.drop_table("notifications_queue")


def downgrade() -> None:
    # Re-create notifications_queue if the operator rolls back. We
    # don't carry over the P16 indexes since they were trivial; the
    # constraint shape mirrors 0018_notifications_queue.
    op.create_table(
        "notifications_queue",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "recipient_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "request_id",
            sa.Integer(),
            sa.ForeignKey("requests.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "payload",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute('ALTER TABLE notifications_queue OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_queue TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE notifications_queue_id_seq TO maugood_app"
    )

    op.drop_index(
        "ix_notifications_tenant_email_pending", table_name="notifications"
    )
    op.drop_index(
        "ix_notifications_tenant_user_unread", table_name="notifications"
    )
    op.drop_table("notification_preferences")
    op.drop_table("notifications")
