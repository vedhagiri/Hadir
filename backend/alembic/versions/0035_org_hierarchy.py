"""Three-tier org hierarchy: divisions → departments → sections.

Operator ask: each employee belongs to a *division* (top), a
*department* (one within that division), and optionally a *section*
(one within that department). A division manager sees every employee
in every department under that division; a department manager sees
only employees in that department; a section manager sees only the
section. Symmetric with how ``user_departments`` already works for
the department tier — we add ``user_divisions`` + ``user_sections``
mirror tables.

Schema-agnostic: every table created here lives in the per-tenant
schema. Existing data is preserved untouched — ``departments.division_id``
and ``employees.section_id`` land as nullable columns so a tenant
that doesn't carry the optional tiers keeps working unchanged.

The CHECK on ``code`` mirrors the existing ``departments`` regex
(``^[A-Z0-9_]{1,16}$``) so the import auto-create path lands clean
data on every tier.

Revision ID: 0035_org_hierarchy
Revises: 0034_cameras_code_zone
Create Date: 2026-04-30
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0035_org_hierarchy"
down_revision: Union[str, None] = "0034_cameras_code_zone"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Codes are uppercased, ASCII-only — same shape as departments.
_CODE_REGEX = "^[A-Z0-9_]{1,16}$"


def upgrade() -> None:
    # 1. divisions table — top tier.
    op.create_table(
        "divisions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("code", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "tenant_id", "code", name="uq_divisions_tenant_code"
        ),
        sa.CheckConstraint(
            f"code ~ '{_CODE_REGEX}'", name="ck_divisions_code_shape"
        ),
    )
    op.create_index(
        "ix_divisions_tenant_id", "divisions", ["tenant_id"]
    )

    # 2. departments gain division_id (nullable for back-compat).
    #    A department without a division stays valid — operator can
    #    backfill incrementally via the UI or a CSV import.
    op.add_column(
        "departments",
        sa.Column(
            "division_id",
            sa.Integer,
            sa.ForeignKey("divisions.id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_departments_division_id", "departments", ["division_id"]
    )

    # 3. sections — nested inside a department. Code unique within
    #    its department (so two departments can both have a "QA"
    #    section without colliding). Tenant_id present for the
    #    isolation invariant + matches the index pattern of the
    #    rest of the per-tenant tables.
    op.create_table(
        "sections",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "department_id",
            sa.Integer,
            sa.ForeignKey("departments.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("code", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "department_id",
            "code",
            name="uq_sections_tenant_dept_code",
        ),
        sa.CheckConstraint(
            f"code ~ '{_CODE_REGEX}'", name="ck_sections_code_shape"
        ),
    )
    op.create_index("ix_sections_tenant_id", "sections", ["tenant_id"])
    op.create_index(
        "ix_sections_department_id", "sections", ["department_id"]
    )

    # 4. employees gain section_id (nullable). Existing rows are
    #    untouched; section is the optional finest-grained tier.
    op.add_column(
        "employees",
        sa.Column(
            "section_id",
            sa.Integer,
            sa.ForeignKey("sections.id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_employees_section_id", "employees", ["section_id"]
    )

    # 5. user_divisions — manager ↔ division, mirrors user_departments.
    op.create_table(
        "user_divisions",
        sa.Column(
            "user_id",
            sa.Integer,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "division_id",
            sa.Integer,
            sa.ForeignKey("divisions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
    )
    op.create_index(
        "ix_user_divisions_tenant_user",
        "user_divisions",
        ["tenant_id", "user_id"],
    )

    # 6. user_sections — manager ↔ section, mirrors user_departments.
    op.create_table(
        "user_sections",
        sa.Column(
            "user_id",
            sa.Integer,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "section_id",
            sa.Integer,
            sa.ForeignKey("sections.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
    )
    op.create_index(
        "ix_user_sections_tenant_user",
        "user_sections",
        ["tenant_id", "user_id"],
    )

    # 7. Grants — symmetric with the rest of the per-tenant tables.
    #    hadir_app role is the legacy name pre-rebrand; the migration
    #    runs under the admin role and applies CRUD grants to whichever
    #    app-runtime role exists in this database. We probe both names
    #    so a rebranded fresh-install (maugood_app) and a legacy
    #    upgrade-in-place (hadir_app) both work.
    bind = op.get_bind()
    app_role_row = bind.execute(
        sa.text(
            "SELECT rolname FROM pg_roles "
            "WHERE rolname IN ('maugood_app','hadir_app') "
            "ORDER BY CASE rolname WHEN 'maugood_app' THEN 0 ELSE 1 END "
            "LIMIT 1"
        )
    ).first()
    if app_role_row is not None:
        app_role = app_role_row[0]
        # Read the active schema once so we can name it explicitly in
        # the bulk GRANT below — ``CURRENT_SCHEMA`` is a value
        # function, not a syntactic placeholder, so it can't be used
        # as a schema name in DDL.
        schema_row = bind.execute(sa.text("SELECT current_schema()")).first()
        active_schema = schema_row[0] if schema_row is not None else "main"
        for tbl in (
            "divisions",
            "sections",
            "user_divisions",
            "user_sections",
        ):
            op.execute(
                sa.text(
                    f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{tbl}" '
                    f'TO {app_role}'
                )
            )
        # SERIAL primary keys auto-create ``<table>_id_seq`` — grant
        # USAGE on the two we added so the app role can INSERT.
        op.execute(
            sa.text(
                f'GRANT USAGE, SELECT ON SEQUENCE '
                f'"{active_schema}"."divisions_id_seq", '
                f'"{active_schema}"."sections_id_seq" TO {app_role}'
            )
        )


def downgrade() -> None:
    # Symmetric reverse order: drop user_* mirror tables, drop FK
    # columns, drop sections, drop divisions index/column, drop the
    # divisions table. ``divisions`` and ``sections`` carry FKs into
    # ``departments`` and ``employees``; we drop the dependent
    # mappings first so the column drops don't cascade-orphan rows.
    op.drop_index(
        "ix_user_sections_tenant_user", table_name="user_sections"
    )
    op.drop_table("user_sections")

    op.drop_index(
        "ix_user_divisions_tenant_user", table_name="user_divisions"
    )
    op.drop_table("user_divisions")

    op.drop_index("ix_employees_section_id", table_name="employees")
    op.drop_column("employees", "section_id")

    op.drop_index("ix_sections_department_id", table_name="sections")
    op.drop_index("ix_sections_tenant_id", table_name="sections")
    op.drop_table("sections")

    op.drop_index(
        "ix_departments_division_id", table_name="departments"
    )
    op.drop_column("departments", "division_id")

    op.drop_index("ix_divisions_tenant_id", table_name="divisions")
    op.drop_table("divisions")
