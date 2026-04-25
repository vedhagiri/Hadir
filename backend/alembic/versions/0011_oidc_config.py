"""Per-tenant Entra ID OIDC configuration (v1.0 P6).

One row per tenant in each tenant schema. Stores the Entra tenant id,
client id, the **encrypted** client secret (Fernet, separate key from
RTSP/photos — see ``HADIR_AUTH_FERNET_KEY``), an enable flag, and a
last-updated timestamp. Toggling ``enabled`` is what flips the tenant
shell's login page from local password to "Sign in with Microsoft".

Schema-agnostic by design: the FK target is the unqualified
``tenants(id)`` so search_path resolution lands on the global registry
regardless of which tenant schema the orchestrator is upgrading. Same
pattern as 0010 — no hardcoded schema literals appear in this file.

Idempotent default seed: at the bottom of upgrade we insert a row for
the tenant whose ``schema_name`` matches ``current_schema()``.
``ON CONFLICT DO NOTHING`` keeps re-runs safe.

Revision ID: 0011_oidc_config
Revises: 0010_tenant_branding
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_oidc_config"
down_revision: Union[str, Sequence[str], None] = "0010_tenant_branding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_oidc_config",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        # Microsoft tenant GUID. Free-form text because Entra also
        # accepts the canonical names (``common``, ``organizations``,
        # ``consumers``) for multi-tenant apps; we don't use those for
        # Hadir, but keeping the column free-form means we don't have
        # to reach for a UUID type.
        sa.Column("entra_tenant_id", sa.Text(), nullable=False, server_default=""),
        sa.Column("client_id", sa.Text(), nullable=False, server_default=""),
        # Fernet ciphertext. Nullable because the row is created lazily
        # before the operator has typed the secret — empty config row
        # with ``enabled=false`` is a valid transient state.
        sa.Column("client_secret_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.execute('ALTER TABLE tenant_oidc_config OWNER TO hadir_admin')
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_oidc_config TO hadir_app"
    )

    # Seed an empty disabled row for the tenant whose schema is being
    # migrated. Provisioning's create_all materialises the table for
    # new tenants and the CLI inserts the row directly.
    op.execute(
        """
        INSERT INTO tenant_oidc_config (tenant_id)
        SELECT id FROM tenants
        WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("tenant_oidc_config")
