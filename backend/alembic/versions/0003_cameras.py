"""Cameras table.

One row per IP camera on the customer LAN. The RTSP URL (including
credentials) is Fernet-encrypted in ``rtsp_url_encrypted`` and never
returned by any API endpoint — callers only see a parsed host/port
through ``rtsp_host``. See ``hadir.cameras.rtsp`` for the encryption
helpers and the red-line enforcement.

Revision ID: 0003_cameras
Revises: 0002_employees
Create Date: 2026-04-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_cameras"
down_revision: Union[str, Sequence[str], None] = "0002_employees"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.create_table(
        "cameras",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("location", sa.Text(), nullable=False, server_default=""),
        sa.Column("rtsp_url_encrypted", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "images_captured_24h",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.UniqueConstraint("tenant_id", "name", name="uq_cameras_tenant_name"),
        schema=SCHEMA,
    )

    op.execute(f'ALTER TABLE "{SCHEMA}"."cameras" OWNER TO hadir_admin')
    op.execute(
        f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{SCHEMA}"."cameras" TO hadir_app'
    )
    op.execute(
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{SCHEMA}" TO hadir_app'
    )


def downgrade() -> None:
    op.drop_table("cameras", schema=SCHEMA)
