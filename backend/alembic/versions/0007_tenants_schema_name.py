"""Add tenants.schema_name (v1.0 P1).

The pilot's single tenant lives in schema ``main``; this column makes
that mapping explicit and gives v1.0 multi-tenant a place to record
``tenant_<slug>`` schemas as they're provisioned (P2's CLI). Login
resolves ``user.tenant_id`` → ``tenants.schema_name`` and stores the
result on ``user_sessions.data`` for the request middleware.

Revision ID: 0007_tenants_schema_name
Revises: 0006_attendance
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_tenants_schema_name"
down_revision: Union[str, Sequence[str], None] = "0006_attendance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "schema_name",
            sa.Text(),
            nullable=False,
            server_default="main",
        ),
        schema=SCHEMA,
    )
    # Existing pilot tenant (id=1, name='Omran') already maps to ``main``
    # via the server_default. No backfill needed; we just constrain the
    # value so a typo can't introduce a schema clash.
    op.create_check_constraint(
        "ck_tenants_schema_name_format",
        "tenants",
        # Mirror the regex in maugood.db._TENANT_SCHEMA_RE so an operator
        # can't slip a junk schema name in via a manual UPDATE.
        "schema_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'",
        schema=SCHEMA,
    )
    # Schema names must be globally unique — two tenants pointing at
    # the same schema would defeat the isolation contract entirely.
    op.create_unique_constraint(
        "uq_tenants_schema_name",
        "tenants",
        ["schema_name"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("uq_tenants_schema_name", "tenants", schema=SCHEMA)
    op.drop_constraint(
        "ck_tenants_schema_name_format", "tenants", schema=SCHEMA
    )
    op.drop_column("tenants", "schema_name", schema=SCHEMA)
