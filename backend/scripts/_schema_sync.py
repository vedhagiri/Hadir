"""Schema-structure reconciliation — heal drift between metadata + DB.

Mirror of ``_grants.py`` but for structural objects: columns, CHECK
constraints, UNIQUE constraints, and indexes. ``sync_schema_structure``
walks every ``Table`` in ``maugood.db.metadata`` and, for each, asks
Postgres what's already in place, then adds whatever's missing.

**Why this exists.** New tenants are provisioned via
``metadata.create_all`` + ``alembic stamp head``. That skips every
forward ALTER migration that happened after the table's CREATE
landed in metadata — and any constraint or column added by an ALTER
ends up missing on the new schema. Existing tenants run
``alembic upgrade head`` per schema, which DOES apply ALTERs, but
historically also drifted because some early migrations grew the DB
without us backporting the change into ``db.py``.

This reconciler closes both gaps. It runs as a defence-in-depth pass
after every migration + at provisioning + on operator demand. It is
**additive only** — it never DROPs anything. The intent is to heal
schemas to *at least* what ``metadata`` declares; if a tenant has
extra unknowns (an old experiment, an unmigrated index from a hotfix)
they survive untouched.

Three categories of work:

1. **Missing columns** — added via ``ALTER TABLE … ADD COLUMN``
   honouring the metadata column's nullable + server_default.
2. **Missing CHECK / UNIQUE constraints** — added via
   ``ALTER TABLE … ADD CONSTRAINT``. The constraint name is the
   one declared in metadata (e.g. ``uq_cpr_clip_usecase``), which
   is what application code references in ``ON CONFLICT ON
   CONSTRAINT`` clauses.
3. **Missing indexes** — added via ``CREATE INDEX IF NOT EXISTS``
   on the underlying columns, name lifted from metadata.

The discovery queries hit ``information_schema`` + ``pg_catalog`` so
the helper is dialect-aware (Postgres) but works without a live
ORM model — we read the live DB by name, never via SQLAlchemy
reflection, to keep the cost bounded.

Idempotent. Safe to re-run.

Red lines:

* Never DROP. Drift toward extras is preserved; drift toward missing
  is fixed. The CI drift test (P29) is the place to catch
  uncommitted forward migrations.
* The caller is expected to be running as ``maugood_admin`` (or the
  bootstrap superuser via ``MAUGOOD_ADMIN_DATABASE_URL``) — ALTER
  TABLE requires ownership.
* All work happens inside the caller's transaction so a single
  failed pass rolls back cleanly.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKeyConstraint,
    Index,
    Table,
    UniqueConstraint,
    text,
)
from sqlalchemy.engine import Connection
from sqlalchemy.schema import CreateIndex
from sqlalchemy.sql.ddl import AddConstraint

from maugood.db import metadata

logger = logging.getLogger("maugood.schema_sync")

# Tables in metadata that live in ``public`` — skip them when iterating
# per-tenant schemas (they only need to be reconciled against ``public``
# itself, which the orchestrator already does via the ``main`` pass).
_PUBLIC_ONLY_TABLES = {"tenants"}


def _table_exists(conn: Connection, schema: str, table: str) -> bool:
    return bool(
        conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = :s AND table_name = :t "
                "AND table_type = 'BASE TABLE'"
            ),
            {"s": schema, "t": table},
        ).first()
    )


def _existing_columns(conn: Connection, schema: str, table: str) -> set[str]:
    rows = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = :s AND table_name = :t"
        ),
        {"s": schema, "t": table},
    ).all()
    return {str(r.column_name) for r in rows}


def _existing_constraints(
    conn: Connection, schema: str, table: str
) -> set[str]:
    """Return every named constraint on the table, regardless of type."""

    rows = conn.execute(
        text(
            "SELECT conname FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace "
            "WHERE n.nspname = :s AND t.relname = :t"
        ),
        {"s": schema, "t": table},
    ).all()
    return {str(r.conname) for r in rows}


def _existing_indexes(conn: Connection, schema: str, table: str) -> set[str]:
    rows = conn.execute(
        text(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = :s AND tablename = :t"
        ),
        {"s": schema, "t": table},
    ).all()
    return {str(r.indexname) for r in rows}


def _add_column(
    conn: Connection, schema: str, table: str, col: Column[Any]
) -> None:
    """Issue ``ALTER TABLE … ADD COLUMN`` honouring the metadata column.

    SQLAlchemy's ``CreateColumn`` DDL compiler emits the column spec
    we need (type + NOT NULL + DEFAULT). We wrap it in a manual
    ALTER so the statement is unambiguous about which schema.
    """

    from sqlalchemy.schema import CreateColumn

    bind = conn.engine
    col_ddl = str(CreateColumn(col).compile(bind))
    sql = f'ALTER TABLE "{schema}"."{table}" ADD COLUMN {col_ddl}'
    logger.info("add column: %s.%s.%s", schema, table, col.name)
    conn.execute(text(sql))


def _add_constraint(
    conn: Connection,
    schema: str,
    table: str,
    constraint: CheckConstraint | UniqueConstraint | ForeignKeyConstraint,
) -> None:
    """ALTER TABLE ADD CONSTRAINT, using SQLAlchemy's DDL compiler."""

    bind = conn.engine
    # The DDL compiler renders ``CONSTRAINT <name> CHECK/UNIQUE…`` against
    # the unqualified table; we wrap it in ALTER TABLE pointed at the
    # right schema.
    ddl = AddConstraint(constraint)
    rendered = str(ddl.compile(bind))

    # ``rendered`` is "ALTER TABLE <table> ADD CONSTRAINT …". Replace the
    # bare table name with the schema-qualified form so the constraint
    # lands in the right place.
    bare = f"ALTER TABLE {table}"
    qualified = f'ALTER TABLE "{schema}"."{table}"'
    if rendered.startswith(bare):
        rendered = qualified + rendered[len(bare):]
    elif rendered.startswith(f'ALTER TABLE "{table}"'):
        rendered = qualified + rendered[len(f'ALTER TABLE "{table}"'):]

    logger.info(
        "add constraint: %s.%s %s",
        schema,
        table,
        getattr(constraint, "name", "?"),
    )
    conn.execute(text(rendered))


def _add_index(
    conn: Connection, schema: str, table: str, idx: Index
) -> None:
    """CREATE INDEX IF NOT EXISTS on the qualified table.

    Renders the index DDL via SQLAlchemy + injects the schema by
    string-replacing the bare table reference.
    """

    bind = conn.engine
    rendered = str(CreateIndex(idx, if_not_exists=True).compile(bind))
    bare = f" ON {table} "
    qualified = f' ON "{schema}"."{table}" '
    if bare in rendered:
        rendered = rendered.replace(bare, qualified, 1)
    elif f' ON "{table}" ' in rendered:
        rendered = rendered.replace(f' ON "{table}" ', qualified, 1)
    logger.info("add index: %s.%s %s", schema, table, idx.name)
    conn.execute(text(rendered))


def sync_schema_structure(
    conn: Connection, schema_name: str
) -> dict[str, int]:
    """Reconcile every metadata Table against ``schema_name``.

    Iterates ``metadata.tables`` (skipping ``public.*``), and for each:
      * adds missing columns
      * adds missing named constraints (CHECK / UNIQUE / FK)
      * adds missing named indexes

    Returns ``{"tables": N, "columns_added": N, "constraints_added": N,
    "indexes_added": N, "tables_missing": N}``.
    """

    columns_added = 0
    constraints_added = 0
    indexes_added = 0
    tables_missing = 0
    tables_checked = 0

    for table_key, table in metadata.tables.items():
        if not isinstance(table, Table):  # defensive
            continue
        if table.name in _PUBLIC_ONLY_TABLES:
            continue
        # Skip tables explicitly bound to a different schema in metadata.
        if table.schema is not None and table.schema != schema_name:
            continue

        tables_checked += 1

        if not _table_exists(conn, schema_name, table.name):
            tables_missing += 1
            logger.warning(
                "table missing in schema=%s: %s — run alembic upgrade",
                schema_name,
                table.name,
            )
            continue

        existing_cols = _existing_columns(conn, schema_name, table.name)
        existing_cons = _existing_constraints(conn, schema_name, table.name)
        existing_idx = _existing_indexes(conn, schema_name, table.name)

        for col in table.columns:
            if col.name in existing_cols:
                continue
            try:
                _add_column(conn, schema_name, table.name, col)
                columns_added += 1
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "failed to add column %s.%s.%s: %s",
                    schema_name,
                    table.name,
                    col.name,
                    exc,
                )
                raise

        for constraint in table.constraints:
            # Only named CHECK / UNIQUE constraints are in scope here.
            # PK and unnamed FKs are left to migrations.
            name = getattr(constraint, "name", None)
            if not name or name in existing_cons:
                continue
            if not isinstance(
                constraint, (CheckConstraint, UniqueConstraint)
            ):
                continue
            try:
                _add_constraint(conn, schema_name, table.name, constraint)
                constraints_added += 1
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "failed to add constraint %s on %s.%s: %s",
                    name,
                    schema_name,
                    table.name,
                    exc,
                )
                raise

        for idx in table.indexes:
            if not idx.name or idx.name in existing_idx:
                continue
            try:
                _add_index(conn, schema_name, table.name, idx)
                indexes_added += 1
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "failed to add index %s on %s.%s: %s",
                    idx.name,
                    schema_name,
                    table.name,
                    exc,
                )
                raise

    logger.info(
        "schema sync: schema=%s tables=%d columns_added=%d "
        "constraints_added=%d indexes_added=%d tables_missing=%d",
        schema_name,
        tables_checked,
        columns_added,
        constraints_added,
        indexes_added,
        tables_missing,
    )

    return {
        "tables": tables_checked,
        "columns_added": columns_added,
        "constraints_added": constraints_added,
        "indexes_added": indexes_added,
        "tables_missing": tables_missing,
    }
