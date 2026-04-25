"""Request reason categories (v1.0 P14).

One per-tenant table — operators can extend the seeded list via the
new Settings → Request reasons page. Two scopes: ``exception`` and
``leave``. Seeded with the BRD §FR-REQ-008 lists for each tenant on
upgrade.

Schema-agnostic FKs to unqualified ``tenants(id)`` so the migration
runs cleanly under every tenant schema. Same pattern as 0010-0016.

Revision ID: 0017_request_reason_categories
Revises: 0016_requests
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0017_request_reason_categories"
down_revision: Union[str, Sequence[str], None] = "0016_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEFAULT_CATEGORIES = (
    # (request_type, code, name, display_order)
    ("exception", "Doctor",   "Doctor",            0),
    ("exception", "Family",   "Family",            1),
    ("exception", "Traffic",  "Traffic",           2),
    ("exception", "Official", "Official business", 3),
    ("exception", "Other",    "Other",             4),
    ("leave",     "Annual",    "Annual leave",    0),
    ("leave",     "Sick",      "Sick leave",      1),
    ("leave",     "Emergency", "Emergency leave", 2),
    ("leave",     "Unpaid",    "Unpaid leave",    3),
)


def upgrade() -> None:
    op.create_table(
        "request_reason_categories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("request_type", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
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
        sa.UniqueConstraint(
            "tenant_id",
            "request_type",
            "code",
            name="uq_request_reason_categories_tenant_type_code",
        ),
        sa.CheckConstraint(
            "request_type IN ('exception','leave')",
            name="ck_request_reason_categories_request_type",
        ),
    )
    op.execute('ALTER TABLE request_reason_categories OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON request_reason_categories TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE request_reason_categories_id_seq TO hadir_app"
    )

    # Seed the BRD §FR-REQ-008 defaults for whichever tenant's schema
    # is being migrated. Idempotent via UNIQUE (tenant, type, code).
    rows_sql = ", ".join(
        f"('{t}', '{code}', '{name}', {order})"
        for (t, code, name, order) in _DEFAULT_CATEGORIES
    )
    op.execute(
        f"""
        INSERT INTO request_reason_categories
            (tenant_id, request_type, code, name, display_order)
        SELECT t.id, v.request_type, v.code, v.name, v.display_order
        FROM tenants t
        CROSS JOIN (VALUES {rows_sql})
            AS v(request_type, code, name, display_order)
        WHERE t.schema_name = current_schema()
        ON CONFLICT (tenant_id, request_type, code) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("request_reason_categories")
