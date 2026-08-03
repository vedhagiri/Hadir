"""Device users + device attendance events + detection_events source.

Schema-agnostic. Adds the two staging tables for device-based attendance
and extends ``detection_events`` so a device-sourced "person seen" row can
coexist with camera rows:

* ``device_users``              — device people mapped to Maugood employees.
* ``device_attendance_events``  — raw taps (face / fingerprint) with retry.
* ``detection_events.source``   — 'camera' (default) | 'device'.
* ``detection_events.device_id``— FK to attendance_devices (null for cameras).
* ``detection_events.camera_id``— relaxed to NULL (device rows have no camera).

See docs/device-attendance-tables.md.

Revision ID: 0095_device_users_events
Revises: 0094_attendance_devices
Create Date: 2026-08-03
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0095_device_users_events"
down_revision: Union[str, None] = "0094_attendance_devices"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- device_users --------------------------------------------------------
    op.create_table(
        "device_users",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("public.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "device_id",
            sa.Integer(),
            sa.ForeignKey("attendance_devices.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("device_user_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("card_no", sa.Text(), nullable=True),
        sa.Column(
            "employee_id",
            sa.Integer(),
            sa.ForeignKey("employees.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "mapping_status", sa.Text(), nullable=False, server_default="unmapped"
        ),
        sa.Column(
            "face_synced", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("raw", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
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
            "device_id",
            "device_user_id",
            name="uq_device_users_tenant_device_user",
        ),
    )
    op.execute("ALTER TABLE device_users OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON device_users TO maugood_app"
    )

    # --- device_attendance_events -------------------------------------------
    op.create_table(
        "device_attendance_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("public.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "device_id",
            sa.Integer(),
            sa.ForeignKey("attendance_devices.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("device_user_id", sa.Text(), nullable=False),
        sa.Column("event_serial", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verify_mode", sa.Text(), nullable=True),
        sa.Column("direction", sa.Text(), nullable=True),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column(
            "attempts", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "employee_id",
            sa.Integer(),
            sa.ForeignKey("employees.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "detection_event_id",
            sa.Integer(),
            sa.ForeignKey("detection_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("raw", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('pending', 'processed', 'failed', 'skipped')",
            name="ck_device_events_status",
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "device_id",
            "event_serial",
            name="uq_device_events_tenant_device_serial",
        ),
    )
    op.create_index(
        "ix_device_events_tenant_status",
        "device_attendance_events",
        ["tenant_id", "status"],
    )
    op.execute("ALTER TABLE device_attendance_events OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON device_attendance_events "
        "TO maugood_app"
    )

    # --- detection_events: accept device rows -------------------------------
    op.alter_column("detection_events", "camera_id", nullable=True)
    op.add_column(
        "detection_events",
        sa.Column(
            "source", sa.Text(), nullable=False, server_default="camera"
        ),
    )
    op.add_column(
        "detection_events",
        sa.Column(
            "device_id",
            sa.Integer(),
            sa.ForeignKey("attendance_devices.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_detection_events_source",
        "detection_events",
        "source IN ('camera', 'device')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_detection_events_source", "detection_events", type_="check"
    )
    op.drop_column("detection_events", "device_id")
    op.drop_column("detection_events", "source")
    op.alter_column("detection_events", "camera_id", nullable=False)

    op.execute("DELETE FROM device_attendance_events")
    op.drop_table("device_attendance_events")
    op.execute("DELETE FROM device_users")
    op.drop_table("device_users")
