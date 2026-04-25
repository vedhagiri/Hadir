"""Notifications queue (v1.0 P16).

One per-tenant table the request workflow appends to whenever a
human action needs to surface to other parties — today only Admin
override fires it (notifying the original Manager + HR deciders and
the submitting Employee). P20 wires the actual delivery channel
(email + in-app); this migration just gives that phase a stable
landing pad.

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema. Same pattern as 0010-0017.

Revision ID: 0018_notifications_queue
Revises: 0017_request_reason_categories
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0018_notifications_queue"
down_revision: Union[str, Sequence[str], None] = "0017_request_reason_categories"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
        # ``recipient_user_id`` is nullable so we can queue a row for
        # an Employee who isn't a Hadir login user (the lower-cased
        # email match might miss). Delivery in P20 falls back to the
        # ``payload.recipient_email`` we copy in below.
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
        sa.Column(
            "sent_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_notifications_queue_tenant_unsent",
        "notifications_queue",
        ["tenant_id", "sent_at"],
    )
    op.execute('ALTER TABLE notifications_queue OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_queue "
        "TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE notifications_queue_id_seq TO hadir_app"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_notifications_queue_tenant_unsent",
        table_name="notifications_queue",
    )
    op.drop_table("notifications_queue")
