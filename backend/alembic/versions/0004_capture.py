"""Detection events + camera health snapshots (P8 capture).

``detection_events`` carries one row per **track entry** — i.e. the first
frame of a new track, not every subsequent frame. That bounds the table
size no matter how long someone stands in front of a camera.

``camera_health_snapshots`` accumulates one row per camera per minute so
the System page (P11) can show frame-rate trends and reachability. The
30-day retention is noted in PROJECT_CONTEXT §3; the cleanup job is a
later concern.

Revision ID: 0004_capture
Revises: 0003_cameras
Create Date: 2026-04-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_capture"
down_revision: Union[str, Sequence[str], None] = "0003_cameras"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.create_table(
        "detection_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "camera_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.cameras.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("bbox", postgresql.JSONB(), nullable=False),
        sa.Column("face_crop_path", sa.Text(), nullable=False),
        sa.Column("embedding", sa.LargeBinary(), nullable=True),
        sa.Column(
            "employee_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.employees.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("track_id", sa.Text(), nullable=False),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_detection_events_tenant_captured_at",
        "detection_events",
        ["tenant_id", "captured_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_detection_events_tenant_camera_captured",
        "detection_events",
        ["tenant_id", "camera_id", "captured_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_detection_events_tenant_employee_captured",
        "detection_events",
        ["tenant_id", "employee_id", "captured_at"],
        schema=SCHEMA,
    )

    op.create_table(
        "camera_health_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "camera_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.cameras.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "frames_last_minute",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("reachable", sa.Boolean(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_camera_health_tenant_camera_captured",
        "camera_health_snapshots",
        ["tenant_id", "camera_id", "captured_at"],
        schema=SCHEMA,
    )

    # --- Grants -------------------------------------------------------------
    for table in ("detection_events", "camera_health_snapshots"):
        op.execute(f'ALTER TABLE "{SCHEMA}"."{table}" OWNER TO maugood_admin')
        op.execute(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{SCHEMA}"."{table}" TO maugood_app'
        )
    op.execute(
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{SCHEMA}" TO maugood_app'
    )


def downgrade() -> None:
    op.drop_table("camera_health_snapshots", schema=SCHEMA)
    op.drop_table("detection_events", schema=SCHEMA)
