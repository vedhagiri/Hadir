"""Initial schema: tenants, users, roles, departments, sessions, audit log.

Also provisions the two Postgres cluster roles the app relies on:

* ``maugood_admin`` — owner of the ``main`` schema; used by Alembic and the
  seed scripts. Full CRUD on every table.
* ``maugood_app`` — request-path connection. Full CRUD on everything **except**
  ``audit_log``, where it only has ``INSERT`` and ``SELECT``. This makes the
  audit log append-only at the database grant level, not just in code
  (per pilot-plan Red Lines).

Role passwords default to the role name for dev. Override in
``MAUGOOD_APP_DB_PASSWORD`` / ``MAUGOOD_ADMIN_DB_PASSWORD`` when moving to any
shared environment — they are CREATEd idempotently so a re-run only updates
the password if the value changes (see ``ALTER ROLE`` calls below).

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-24
"""

from __future__ import annotations

import os
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


# Tables that ``maugood_app`` operates on with full CRUD. ``audit_log`` is
# deliberately excluded — its grants are narrower.
_APP_CRUD_TABLES = (
    "tenants",
    "users",
    "roles",
    "user_roles",
    "departments",
    "user_departments",
    "user_sessions",
)


def _quote_literal(value: str) -> str:
    """Escape a string literal for safe inclusion in a raw SQL statement.

    We'd use parameterised DDL if Postgres allowed it for ``CREATE ROLE``,
    but it doesn't. Passwords come from env vars we control, but we still
    escape single quotes to be safe against operator error.
    """

    return "'" + value.replace("'", "''") + "'"


def upgrade() -> None:
    # --- Extensions ---------------------------------------------------------
    # citext gives us case-insensitive email comparisons at the DB layer, per
    # PROJECT_CONTEXT §3. Installed into ``public`` so every schema (including
    # the future multi-tenant ones) can reference the type unqualified.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public")

    # --- Schema -------------------------------------------------------------
    op.execute(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"')

    # --- Roles --------------------------------------------------------------
    app_password = os.environ.get("MAUGOOD_APP_DB_PASSWORD", "maugood_app")
    admin_password = os.environ.get("MAUGOOD_ADMIN_DB_PASSWORD", "maugood_admin")

    app_pw_literal = _quote_literal(app_password)
    admin_pw_literal = _quote_literal(admin_password)

    op.execute(
        f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maugood_admin') THEN
            CREATE ROLE maugood_admin LOGIN PASSWORD {admin_pw_literal};
          ELSE
            ALTER ROLE maugood_admin WITH LOGIN PASSWORD {admin_pw_literal};
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maugood_app') THEN
            CREATE ROLE maugood_app LOGIN PASSWORD {app_pw_literal};
          ELSE
            ALTER ROLE maugood_app WITH LOGIN PASSWORD {app_pw_literal};
          END IF;
        END
        $$;
        """
    )

    # --- Tables -------------------------------------------------------------
    op.create_table(
        "tenants",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("tenant_id", "email", name="uq_users_tenant_email"),
        schema=SCHEMA,
    )

    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.UniqueConstraint("tenant_id", "code", name="uq_roles_tenant_code"),
        sa.CheckConstraint(
            "code IN ('Admin','HR','Manager','Employee')", name="ck_roles_code"
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "user_roles",
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "role_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.roles.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.UniqueConstraint("tenant_id", "code", name="uq_departments_tenant_code"),
        schema=SCHEMA,
    )

    op.create_table(
        "user_departments",
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "department_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.departments.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.String(length=128), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "data",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "actor_user_id",
            sa.Integer(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Text(), nullable=True),
        sa.Column("before", postgresql.JSONB(), nullable=True),
        sa.Column("after", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            index=True,
        ),
        schema=SCHEMA,
    )

    # --- Grants -------------------------------------------------------------
    # Ownership: maugood_admin owns the schema and everything in it. The app
    # role gets narrower grants, and audit_log is narrower still.
    op.execute(f'ALTER SCHEMA "{SCHEMA}" OWNER TO maugood_admin')

    for table in (*_APP_CRUD_TABLES, "audit_log"):
        op.execute(f'ALTER TABLE "{SCHEMA}"."{table}" OWNER TO maugood_admin')

    # maugood_app needs to USE the schema at all.
    op.execute(f'GRANT USAGE ON SCHEMA "{SCHEMA}" TO maugood_app')

    # Full CRUD on non-audit tables.
    for table in _APP_CRUD_TABLES:
        op.execute(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{SCHEMA}"."{table}" TO maugood_app'
        )

    # Audit log: INSERT + SELECT only. No UPDATE, no DELETE, no TRUNCATE.
    op.execute(f'GRANT SELECT, INSERT ON "{SCHEMA}"."audit_log" TO maugood_app')

    # Sequences (used by SERIAL PKs) need USAGE + SELECT for inserts to work.
    op.execute(
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{SCHEMA}" TO maugood_app'
    )
    op.execute(
        f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{SCHEMA}" '
        "GRANT USAGE, SELECT ON SEQUENCES TO maugood_app"
    )

    # --- Seed data ----------------------------------------------------------
    # Default tenant: one row, id=1, name=''. The empty string is a
    # placeholder the operator's setup wizard fills in (e.g. via
    # ``scripts/seed_admin.py --tenant-name "<Customer Name>"``). Until
    # then the frontend falls back to the product name ("Maugood") so
    # the UI doesn't render a blank brand.
    #
    # The pilot's ``Omran`` literal lived here through v0.1; v1.0 takes
    # it out so a fresh deploy to any client doesn't surface another
    # customer's name in their sidebar. Existing deployments are
    # unaffected — Alembic only runs each migration once, so a DB whose
    # tenants row is already named ``Omran`` keeps that value until the
    # operator renames it.
    op.execute(f"INSERT INTO \"{SCHEMA}\".tenants (id, name) VALUES (1, '')")
    op.execute(
        f'SELECT setval(pg_get_serial_sequence(\'"{SCHEMA}".tenants\', \'id\'), 1, true)'
    )

    # The four pilot roles per tenant 1. v1.0 will seed these for each new
    # tenant as part of tenant creation.
    op.execute(
        f"""
        INSERT INTO "{SCHEMA}".roles (tenant_id, code, name) VALUES
          (1, 'Admin',    'Administrator'),
          (1, 'HR',       'Human Resources'),
          (1, 'Manager',  'Manager'),
          (1, 'Employee', 'Employee')
        """
    )


def downgrade() -> None:
    # Dropping the schema CASCADEs the tables and their constraints. Sequences
    # follow. We leave the DB roles in place because they are cluster-wide
    # and may be in use by parallel test databases — operators can drop them
    # manually with ``DROP ROLE maugood_app, maugood_admin;`` when truly unused.
    op.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
