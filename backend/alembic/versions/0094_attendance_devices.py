"""Attendance devices — face-recognition terminal registry.

Schema-agnostic: every per-tenant schema gets ``attendance_devices`` under
whatever ``search_path`` Alembic is invoked with. Credentials are stored
Fernet-encrypted (username:password); the plaintext lives nowhere else.
The device serial (read from the terminal on create) is unique per tenant.

See docs/design/device-attendance-integration.md. The ``device_users`` +
``device_attendance_events`` staging tables and the
``tenant_settings.attendance_source`` switch land in follow-up migrations.

Revision ID: 0094_attendance_devices
Revises: 0093_entra_user_sync
Create Date: 2026-08-03
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0094_attendance_devices"
down_revision: Union[str, None] = "0093_entra_user_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "attendance_devices",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("public.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("location", sa.Text(), nullable=False, server_default=""),
        sa.Column("driver", sa.Text(), nullable=False, server_default="hikvision"),
        sa.Column("host", sa.Text(), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False, server_default=sa.text("80")),
        sa.Column("credentials_encrypted", sa.Text(), nullable=False),
        sa.Column("serial_number", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("firmware", sa.Text(), nullable=True),
        sa.Column("door_no", sa.Text(), nullable=True),
        sa.Column(
            "enrollment_scope", sa.Text(), nullable=False, server_default="all"
        ),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "health_status", sa.Text(), nullable=False, server_default="unknown"
        ),
        sa.Column(
            "users_synced", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("last_user_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id",
            "serial_number",
            name="uq_attendance_devices_tenant_serial",
        ),
    )
    op.create_index(
        "ix_attendance_devices_tenant",
        "attendance_devices",
        ["tenant_id"],
    )
    op.execute("ALTER TABLE attendance_devices OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_devices TO maugood_app"
    )


def downgrade() -> None:
    op.execute("DELETE FROM attendance_devices")
    op.drop_table("attendance_devices")
