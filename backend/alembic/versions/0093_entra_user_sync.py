"""Entra AD user sync — user AD columns + group→role mapping.

Supports the AD Users management surface: an admin-initiated Microsoft
Graph sync that provisions/updates ``users`` from the Entra directory,
plus an explicit, admin-configured Entra-group → Maugood-role mapping.

Adds to ``users`` (all nullable / defaulted so the migration is safe on
existing rows):
* ``source``          TEXT NOT NULL DEFAULT 'local'  (CHECK local|entra)
* ``ms_object_id``    TEXT NULL   — Graph user object id
* ``upn``             TEXT NULL   — userPrincipalName
* ``job_title``       TEXT NULL
* ``ad_department``   TEXT NULL   — free-text dept from AD (distinct from
                                    the user_departments join)
* ``ad_status``       TEXT NULL   — 'active' | 'disabled' (accountEnabled)
* ``auth_provider``   TEXT NULL   — last provider used: password|microsoft|google
* ``last_login_at``   TIMESTAMPTZ NULL
* ``login_count``     INTEGER NOT NULL DEFAULT 0
* ``last_synced_at``  TIMESTAMPTZ NULL
Plus a partial UNIQUE ``(tenant_id, ms_object_id)`` so a Graph object
maps to exactly one Maugood user per tenant.

New per-tenant table ``entra_group_role_map`` (admin-configured):
* the Entra security-group object id → a Maugood role code.

Schema-agnostic (guards on ``current_schema()``; unqualified
``tenants.id`` FK target only).

Revision ID: 0093_entra_user_sync
Revises:     0092_oidc_redirect_uri_override
Create Date: 2026-07-03
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0093_entra_user_sync"
down_revision: Union[str, Sequence[str], None] = "0092_oidc_redirect_uri_override"
branch_labels = None
depends_on = None


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


def _has_table(bind, table: str) -> bool:
    return (
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_name = :t AND table_schema = current_schema()"
            ),
            {"t": table},
        ).first()
        is not None
    )


_USER_COLS = [
    ("source", sa.Text(), {"nullable": False, "server_default": "local"}),
    ("ms_object_id", sa.Text(), {"nullable": True}),
    ("upn", sa.Text(), {"nullable": True}),
    ("job_title", sa.Text(), {"nullable": True}),
    ("ad_department", sa.Text(), {"nullable": True}),
    ("ad_status", sa.Text(), {"nullable": True}),
    ("auth_provider", sa.Text(), {"nullable": True}),
    ("last_login_at", sa.DateTime(timezone=True), {"nullable": True}),
    (
        "login_count",
        sa.Integer(),
        {"nullable": False, "server_default": "0"},
    ),
    ("last_synced_at", sa.DateTime(timezone=True), {"nullable": True}),
]


def upgrade() -> None:
    bind = op.get_bind()

    for name, coltype, kw in _USER_COLS:
        if not _has_column(bind, "users", name):
            op.add_column("users", sa.Column(name, coltype, **kw))

    op.execute(
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_source"
    )
    op.execute(
        "ALTER TABLE users ADD CONSTRAINT ck_users_source "
        "CHECK (source IN ('local','entra'))"
    )

    # One Graph object → one user per tenant. Partial so the many
    # local users (NULL ms_object_id) don't collide.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_ms_object "
        "ON users (tenant_id, ms_object_id) WHERE ms_object_id IS NOT NULL"
    )

    if not _has_table(bind, "entra_group_role_map"):
        op.create_table(
            "entra_group_role_map",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "tenant_id",
                sa.Integer(),
                sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
                nullable=False,
                index=True,
            ),
            sa.Column("group_id", sa.Text(), nullable=False),
            sa.Column("group_name", sa.Text(), nullable=False, server_default=""),
            sa.Column("role_code", sa.Text(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint(
                "tenant_id", "group_id", name="uq_entra_group_role_tenant_group"
            ),
            sa.CheckConstraint(
                "role_code IN ('Admin','HR','Manager','Employee')",
                name="ck_entra_group_role_code",
            ),
        )
        op.execute("ALTER TABLE entra_group_role_map OWNER TO maugood_admin")
        op.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON entra_group_role_map TO maugood_app"
        )
        op.execute(
            "GRANT USAGE, SELECT ON SEQUENCE entra_group_role_map_id_seq TO maugood_app"
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "entra_group_role_map"):
        op.drop_table("entra_group_role_map")
    op.execute("DROP INDEX IF EXISTS uq_users_tenant_ms_object")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_source")
    for name, _t, _kw in reversed(_USER_COLS):
        if _has_column(bind, "users", name):
            op.drop_column("users", name)
