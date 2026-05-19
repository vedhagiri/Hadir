"""CI gate: ``maugood.db.metadata`` must stay in sync with the live DB.

The bug this test guards: when a forward ALTER migration ships but
the same column/constraint/index doesn't get backported into
``maugood.db.metadata``, the two provisioning paths diverge:

* Existing tenants → ``alembic upgrade head`` → schema has the new
  thing.
* New tenants → ``metadata.create_all`` + ``alembic stamp head`` →
  schema is missing the new thing, alembic believes it's at head.

That's how ``tenant_giitm`` ended up missing the
``uq_cpr_clip_usecase`` constraint while ``tenant_inaisys`` had it —
``tenant_giitm`` was provisioned after the relevant migration shipped
but before the constraint was back-ported to ``db.py``.

Approach: build a fresh schema from ``metadata.create_all`` and ask
``sync_schema_structure`` what's missing on it relative to live
tenants. The reconciler's job is to add anything declared in
metadata that's not on disk. If we run it twice in a row and the
second pass reports zero work, metadata is the source of truth.

We then go the other way too — pick an existing migrated tenant
(``main`` or the first row in ``public.tenants``) and assert
``sync_schema_structure`` against ``metadata`` adds nothing.

Migration-history-from-empty is intentionally NOT exercised here:
pilot migrations 0001-0008 hardcode the ``main`` schema and are
not schema-agnostic; the boundary is 0009+. The two assertions
below cover the same intent without paying that complexity cost.
"""

from __future__ import annotations

import secrets
from typing import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from maugood.db import metadata, reset_tenant_schema, set_tenant_schema
from scripts._schema_sync import sync_schema_structure


def _suffix() -> str:
    return secrets.token_hex(4)


def _drop_schema(engine: Engine, schema: str) -> None:
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))


def _existing_tenant_schemas(engine: Engine) -> list[str]:
    """Every schema in ``public.tenants`` (including ``main``)."""

    with engine.begin() as conn:
        rows = conn.execute(
            text("SELECT schema_name FROM public.tenants ORDER BY id")
        ).all()
    return [str(r.schema_name) for r in rows]


@pytest.fixture
def fresh_metadata_schema(admin_engine: Engine) -> Iterator[str]:
    """Create + drop a fresh schema populated via ``metadata.create_all``."""

    schema = f"drift_meta_{_suffix()}"
    token = set_tenant_schema(schema)
    try:
        with admin_engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            conn.execute(text(f'SET search_path TO "{schema}", public'))
            per_tenant = [
                t for t in metadata.tables.values() if t.schema != "public"
            ]
            metadata.create_all(bind=conn, tables=per_tenant)
        yield schema
    finally:
        reset_tenant_schema(token)
        _drop_schema(admin_engine, schema)


def test_metadata_is_idempotent_against_itself(
    admin_engine: Engine, fresh_metadata_schema: str
) -> None:
    """``sync_schema_structure`` on a fresh ``create_all`` schema is a no-op.

    If the reconciler reports work to do, it means ``metadata``
    references something ``create_all`` doesn't actually build (a
    typo in a constraint declaration, an index defined on a missing
    column, etc.).
    """

    token = set_tenant_schema(fresh_metadata_schema)
    try:
        with admin_engine.begin() as conn:
            result = sync_schema_structure(conn, fresh_metadata_schema)
    finally:
        reset_tenant_schema(token)

    assert result["columns_added"] == 0, (
        f"metadata.create_all left columns missing: {result}"
    )
    assert result["constraints_added"] == 0, (
        f"metadata.create_all left constraints missing: {result}"
    )
    assert result["indexes_added"] == 0, (
        f"metadata.create_all left indexes missing: {result}"
    )
    assert result["tables_missing"] == 0, (
        f"metadata.create_all skipped tables: {result}"
    )


def test_live_tenants_match_metadata(admin_engine: Engine) -> None:
    """Every live tenant schema must already satisfy ``metadata``.

    Running ``sync_schema_structure`` against a properly-migrated
    tenant must report no work. If it adds anything, db.py is missing
    a column/constraint/index that the migration history has — i.e.
    the new-tenant provisioning path will produce a drifted schema.
    """

    schemas = _existing_tenant_schemas(admin_engine)
    if not schemas:
        pytest.skip("no tenants registered; can't compare metadata vs live")

    problems: list[str] = []
    for schema in schemas:
        token = set_tenant_schema(schema)
        try:
            with admin_engine.begin() as conn:
                result = sync_schema_structure(conn, schema)
        finally:
            reset_tenant_schema(token)

        if (
            result["columns_added"]
            or result["constraints_added"]
            or result["indexes_added"]
        ):
            problems.append(
                f"  schema={schema} drift: "
                f"cols_added={result['columns_added']} "
                f"cons_added={result['constraints_added']} "
                f"idx_added={result['indexes_added']}"
            )

    if problems:
        raise AssertionError(
            "metadata drifted from live tenant schemas — backport the "
            "missing items into maugood/db.py:\n" + "\n".join(problems)
        )
