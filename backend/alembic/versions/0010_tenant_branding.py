"""Per-tenant branding (v1.0 P4).

Adds one per-tenant table — ``tenant_branding`` — that records the
tenant's chosen primary colour, font, and (optional) logo path. The
options are **curated**: ``primary_color_key`` and ``font_key`` are
both CHECK-constrained against the BRAND_PALETTE / FONT_OPTIONS maps
in ``maugood/branding/constants.py``. There is no free-form hex entry
and no custom font upload — those are explicit BRD red lines
(FR-BRD-002, also called out in PROJECT_CONTEXT §"Tenant branding").

Schema-agnostic by design: the FK target is the **unqualified**
``tenants(id)`` so search_path resolution lands on the global
tenants registry regardless of which tenant schema we're upgrading.
Same trick the per-tenant tables use elsewhere; no hardcoded
schema literals appear in this file.

Idempotent default seed: at the bottom of upgrade we INSERT one row
per tenant whose ``schema_name`` matches ``current_schema()``. Run
inside ``main`` it seeds Omran (id=1, schema_name='main'); run inside
``tenant_<slug>`` it seeds that tenant. ``ON CONFLICT DO NOTHING``
keeps re-runs safe.

Revision ID: 0010_tenant_branding
Revises: 0009_super_admin
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_tenant_branding"
down_revision: Union[str, Sequence[str], None] = "0009_super_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_branding",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            # Unqualified FK target — search_path resolution lands
            # this on the global tenants registry at CREATE time.
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "primary_color_key",
            sa.Text(),
            nullable=False,
            server_default="teal",
        ),
        sa.Column("logo_path", sa.Text(), nullable=True),
        sa.Column(
            "font_key",
            sa.Text(),
            nullable=False,
            server_default="inter",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # Curated palette + font list. Mirrored in
        # maugood/branding/constants.py — change both together.
        sa.CheckConstraint(
            "primary_color_key IN ("
            "'teal','navy','slate','forest','plum','clay','rose','amber'"
            ")",
            name="ck_tenant_branding_primary_color_key",
        ),
        sa.CheckConstraint(
            "font_key IN ('inter','lato','plus-jakarta-sans')",
            name="ck_tenant_branding_font_key",
        ),
    )

    # Grants — same pattern as every other per-tenant table.
    op.execute('ALTER TABLE tenant_branding OWNER TO maugood_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding TO maugood_app"
    )

    # Seed defaults for the tenant whose schema is being migrated.
    # current_schema() returns the first entry on search_path, which the
    # alembic env.py sets to the migrating schema. Idempotent: existing
    # rows are left alone.
    op.execute(
        """
        INSERT INTO tenant_branding (tenant_id)
        SELECT id FROM tenants
        WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("tenant_branding")
