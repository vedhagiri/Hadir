"""Per-tenant Google Sign-In (OIDC) configuration.

Sibling of ``0011_oidc_config`` (Entra), but for Google. One row per
tenant in each tenant schema. Stores the Google OAuth **client id**,
the **encrypted** client secret (Fernet, same ``MAUGOOD_AUTH_FERNET_KEY``
as the Entra flow — blast-radius isolation from the RTSP/photo key is
already handled by that split), an optional **allowed hosted domain**
(empty = accept any verified Google account that matches a Maugood
user), an enable flag, and a last-updated timestamp. Toggling
``enabled`` is what makes the login page's "Sign in with Google"
button actually start a flow instead of showing the not-configured
notice.

Schema-agnostic by design — the FK target is the unqualified
``tenants(id)`` so search_path resolution lands on the global registry
regardless of which tenant schema the orchestrator is upgrading. No
hardcoded schema literals appear in this file (``current_schema()`` in
the seed is the migration-lint-approved idiom, same as 0011).

Idempotent default seed: at the bottom of upgrade we insert a row for
the tenant whose ``schema_name`` matches ``current_schema()``.
``ON CONFLICT DO NOTHING`` keeps re-runs safe.

Revision ID: 0091_google_oidc_config
Revises: 0090_clip_daily_cleanup
Create Date: 2026-07-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0091_google_oidc_config"
down_revision: Union[str, Sequence[str], None] = "0090_clip_daily_cleanup"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_google_oidc_config",
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("client_id", sa.Text(), nullable=False, server_default=""),
        # Fernet ciphertext. Nullable because the row is created lazily
        # before the operator has typed the secret — empty config row
        # with ``enabled=false`` is a valid transient state.
        sa.Column("client_secret_encrypted", sa.Text(), nullable=True),
        # Optional Google Workspace hosted-domain restriction. Empty
        # string = no restriction (any verified Google account whose
        # email matches a Maugood user may sign in). When set, the
        # callback refuses an email whose domain doesn't match.
        sa.Column("allowed_domain", sa.Text(), nullable=False, server_default=""),
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

    op.execute("ALTER TABLE tenant_google_oidc_config OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_google_oidc_config TO maugood_app"
    )

    # Seed an empty disabled row for the tenant whose schema is being
    # migrated. Provisioning's create_all materialises the table for
    # new tenants; the config surface lazy-creates the row otherwise.
    op.execute(
        """
        INSERT INTO tenant_google_oidc_config (tenant_id)
        SELECT id FROM tenants
        WHERE schema_name = current_schema()
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("tenant_google_oidc_config")
