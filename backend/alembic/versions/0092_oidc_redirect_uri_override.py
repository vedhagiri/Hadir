"""Add an editable redirect-URI override to both OIDC config tables.

By default the redirect URI Maugood sends to the identity provider is
derived from ``MAUGOOD_OIDC_REDIRECT_BASE_URL`` + the fixed callback
path. This adds a per-tenant, per-provider ``redirect_uri`` override so
an Admin can set it from the UI (e.g. a custom domain or a dev port)
without touching server env. Empty string = use the computed default.

Adds ``redirect_uri TEXT NOT NULL DEFAULT ''`` to:
* ``tenant_oidc_config``         (Microsoft / Entra)
* ``tenant_google_oidc_config``  (Google)

Schema-agnostic (guards on ``current_schema()``; no hardcoded schema
literals).

Revision ID: 0092_oidc_redirect_uri_override
Revises:     0091_google_oidc_config
Create Date: 2026-07-03
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0092_oidc_redirect_uri_override"
down_revision: Union[str, Sequence[str], None] = "0091_google_oidc_config"
branch_labels = None
depends_on = None

_TABLES = ("tenant_oidc_config", "tenant_google_oidc_config")


def _has_column(bind, table: str, column: str) -> bool:
    return (
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = :t AND column_name = :c "
                "AND table_schema = current_schema()"
            ),
            {"t": table, "c": column},
        ).first()
        is not None
    )


def upgrade() -> None:
    bind = op.get_bind()
    for table in _TABLES:
        if not _has_column(bind, table, "redirect_uri"):
            op.add_column(
                table,
                sa.Column(
                    "redirect_uri",
                    sa.Text(),
                    nullable=False,
                    server_default="",
                ),
            )


def downgrade() -> None:
    bind = op.get_bind()
    for table in _TABLES:
        if _has_column(bind, table, "redirect_uri"):
            op.drop_column(table, "redirect_uri")
