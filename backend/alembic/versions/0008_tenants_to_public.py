"""Move ``tenants`` from ``main`` to ``public`` (v1.0 P2).

This is the **boundary migration** between pilot single-tenant
(everything in ``main``) and v1.0 multi-tenant (``public.tenants`` is
the only globally-visible table; every other table lives per-tenant in
its own schema). After this migration:

* ``public.tenants`` is the global registry. It carries the same shape
  as the pilot's ``main.tenants`` (id, name, schema_name, created_at)
  plus the constraints from 0007 (regex CHECK + UNIQUE schema_name).
* All foreign keys that used to point at ``main.tenants(id)`` are
  rewired to ``public.tenants(id)``. Cross-schema FKs are allowed in
  Postgres and are dropped along with the child schema if the tenant
  is ever deprovisioned (DROP SCHEMA … CASCADE).
* ``main.tenants`` is dropped. The pilot tenant row (id=1, Omran,
  schema_name='main') is preserved in ``public.tenants``.

This migration is **not** schema-agnostic — it explicitly references
``main`` and ``public`` and rewires constraints across the whole DB.
That is correct: this is the one-shot pilot→multi-tenant cut.
Subsequent migrations (0009+) MUST be schema-agnostic and tracked per
tenant schema. The migration-lint pytest enforces that going forward.

Revision ID: 0008_tenants_to_public
Revises: 0007_tenants_schema_name
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0008_tenants_to_public"
down_revision: Union[str, Sequence[str], None] = "0007_tenants_schema_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The ``public`` schema is created automatically by Postgres at
    # database initialisation, but be defensive — the entrypoint runs
    # this on a fresh DB too.
    op.execute('CREATE SCHEMA IF NOT EXISTS "public"')

    # 1. Create public.tenants with the same shape as main.tenants.
    #    We use raw SQL rather than op.create_table so the operation
    #    stays explicit about the schema and so we can inline the
    #    CHECK + UNIQUE constraints from 0007 without having to thread
    #    them through op.create_table's ``schema=`` arg.
    op.execute(
        """
        CREATE TABLE public.tenants (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            schema_name TEXT NOT NULL DEFAULT 'main',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_tenants_name UNIQUE (name),
            CONSTRAINT uq_tenants_schema_name UNIQUE (schema_name),
            CONSTRAINT ck_tenants_schema_name_format
                CHECK (schema_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$')
        )
        """
    )

    # 2. Copy rows from main.tenants, preserving ids so existing FK
    #    values stay valid after we rewire the constraint targets.
    op.execute(
        """
        INSERT INTO public.tenants (id, name, schema_name, created_at)
        SELECT id, name, schema_name, created_at FROM main.tenants
        """
    )

    # 3. Advance the new sequence past the highest existing id so the
    #    next INSERT (e.g. provisioning a new tenant) doesn't collide.
    op.execute(
        """
        SELECT setval(
            pg_get_serial_sequence('public.tenants', 'id'),
            COALESCE((SELECT MAX(id) FROM public.tenants), 1),
            true
        )
        """
    )

    # 4. Discover and rewire every FK currently pointing at
    #    main.tenants(id). We let Postgres keep the existing constraint
    #    name so subsequent migrations and ad-hoc DBA queries don't
    #    have to learn a new naming convention. ``delete_rule`` is read
    #    from information_schema and re-applied verbatim — we don't
    #    silently flatten any RESTRICTs to NO ACTION.
    op.execute(
        """
        DO $$
        DECLARE
            rec RECORD;
        BEGIN
            FOR rec IN
                SELECT tc.constraint_name,
                       tc.table_schema,
                       tc.table_name,
                       kcu.column_name,
                       rc.delete_rule
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema   = kcu.table_schema
                JOIN information_schema.referential_constraints AS rc
                  ON tc.constraint_name = rc.constraint_name
                 AND tc.table_schema   = rc.constraint_schema
                JOIN information_schema.constraint_column_usage AS ccu
                  ON tc.constraint_name = ccu.constraint_name
                 AND tc.table_schema   = ccu.constraint_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND ccu.table_schema   = 'main'
                  AND ccu.table_name     = 'tenants'
                  AND ccu.column_name    = 'id'
            LOOP
                EXECUTE format(
                    'ALTER TABLE %I.%I DROP CONSTRAINT %I',
                    rec.table_schema, rec.table_name, rec.constraint_name
                );
                EXECUTE format(
                    'ALTER TABLE %I.%I ADD CONSTRAINT %I '
                    'FOREIGN KEY (%I) REFERENCES public.tenants(id) '
                    'ON DELETE %s',
                    rec.table_schema, rec.table_name, rec.constraint_name,
                    rec.column_name, rec.delete_rule
                );
            END LOOP;
        END
        $$
        """
    )

    # 5. Drop the old table. Every FK that referenced it has been
    #    rewired in the loop above, so this DROP succeeds without
    #    CASCADE. If anything is left, fail loudly — that means the
    #    rewiring missed a constraint and we don't want to silently
    #    cascade-drop it.
    op.execute("DROP TABLE main.tenants")

    # 6. Grants. ``maugood_admin`` owns the table; ``maugood_app`` gets
    #    the same CRUD it had on main.tenants, plus the sequence priv
    #    needed for inserts. ``public`` schema USAGE is granted by
    #    default to PUBLIC, so we don't need an explicit grant there.
    op.execute("ALTER TABLE public.tenants OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO maugood_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE public.tenants_id_seq TO maugood_app"
    )


def downgrade() -> None:
    # Reverse: recreate main.tenants, copy the data back, rewire FKs,
    # drop public.tenants. Used only if an operator needs to roll back
    # the boundary migration before any new tenants have been
    # provisioned — once tenant_<slug> schemas exist this downgrade
    # would orphan them, so it intentionally refuses if any non-main
    # tenant rows are present.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.tenants WHERE schema_name <> 'main') THEN
                RAISE EXCEPTION
                    'cannot downgrade 0008: non-main tenants exist in public.tenants';
            END IF;
        END
        $$
        """
    )

    op.execute(
        """
        CREATE TABLE main.tenants (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            schema_name TEXT NOT NULL DEFAULT 'main',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_tenants_schema_name UNIQUE (schema_name),
            CONSTRAINT ck_tenants_schema_name_format
                CHECK (schema_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$')
        )
        """
    )
    op.execute(
        """
        INSERT INTO main.tenants (id, name, schema_name, created_at)
        SELECT id, name, schema_name, created_at FROM public.tenants
        """
    )
    op.execute(
        """
        SELECT setval(
            pg_get_serial_sequence('main.tenants', 'id'),
            COALESCE((SELECT MAX(id) FROM main.tenants), 1),
            true
        )
        """
    )

    op.execute(
        """
        DO $$
        DECLARE
            rec RECORD;
        BEGIN
            FOR rec IN
                SELECT tc.constraint_name,
                       tc.table_schema,
                       tc.table_name,
                       kcu.column_name,
                       rc.delete_rule
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema   = kcu.table_schema
                JOIN information_schema.referential_constraints AS rc
                  ON tc.constraint_name = rc.constraint_name
                 AND tc.table_schema   = rc.constraint_schema
                JOIN information_schema.constraint_column_usage AS ccu
                  ON tc.constraint_name = ccu.constraint_name
                 AND tc.table_schema   = ccu.constraint_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND ccu.table_schema   = 'public'
                  AND ccu.table_name     = 'tenants'
                  AND ccu.column_name    = 'id'
            LOOP
                EXECUTE format(
                    'ALTER TABLE %I.%I DROP CONSTRAINT %I',
                    rec.table_schema, rec.table_name, rec.constraint_name
                );
                EXECUTE format(
                    'ALTER TABLE %I.%I ADD CONSTRAINT %I '
                    'FOREIGN KEY (%I) REFERENCES main.tenants(id) '
                    'ON DELETE %s',
                    rec.table_schema, rec.table_name, rec.constraint_name,
                    rec.column_name, rec.delete_rule
                );
            END LOOP;
        END
        $$
        """
    )

    op.execute("DROP TABLE public.tenants")

    op.execute('ALTER TABLE "main"."tenants" OWNER TO maugood_admin')
    op.execute(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "main"."tenants" TO maugood_app'
    )
