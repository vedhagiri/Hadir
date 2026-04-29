"""v1.0 P1 isolation canary.

Provisions two real Postgres schemas (``tenant_a`` / ``tenant_b``) with
the same minimal table shape, seeds disjoint rows, and verifies that a
query issued under one tenant's ``search_path`` can never see the
other's data. **If this test ever fails, tenant isolation is broken.**

Independent of the rest of the test suite — it doesn't go through the
FastAPI auth flow or the ``main`` schema; it directly drives the same
``set_tenant_schema`` / engine pair the production code uses.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from maugood.config import get_settings
from maugood.db import (
    DEFAULT_SCHEMA,
    get_engine,
    make_admin_engine,
    set_tenant_schema,
    reset_tenant_schema,
    tenant_context,
)


_SCHEMAS = ("tenant_a", "tenant_b")


@pytest.fixture
def two_isolated_schemas():
    """Create ``tenant_a`` + ``tenant_b`` schemas with one tiny table each.

    Drops them on teardown. Uses the admin engine — DDL is owner-only.
    """

    admin = make_admin_engine()

    # Wrap setup AND teardown in a tenant_context("main") so the
    # checkout event has a non-None contextvar even when a test body
    # has flipped settings to multi mode (the test's monkeypatch only
    # reverts AFTER fixture finalizers run). DDL is schema-explicit so
    # the chosen schema doesn't actually matter for correctness.
    setup_token = set_tenant_schema("main")
    with admin.begin() as conn:
        for s in _SCHEMAS:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{s}" CASCADE'))
            conn.execute(text(f'CREATE SCHEMA "{s}"'))
            # Minimal table — same shape in both schemas, different rows.
            conn.execute(
                text(
                    f'CREATE TABLE "{s}".widgets (id INT PRIMARY KEY, label TEXT NOT NULL)'
                )
            )
            # Grant the app role read+write so the app engine can hit
            # the new schema (parity with what the per-tenant
            # provisioning CLI will do in P2).
            conn.execute(
                text(
                    f'GRANT USAGE ON SCHEMA "{s}" TO maugood_app'
                )
            )
            conn.execute(
                text(
                    f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES '
                    f'IN SCHEMA "{s}" TO maugood_app'
                )
            )

        # Disjoint rows: tenant_a has IDs 1+2; tenant_b has IDs 100+200.
        conn.execute(
            text(
                'INSERT INTO "tenant_a".widgets (id, label) VALUES '
                "(1, 'A-one'), (2, 'A-two')"
            )
        )
        conn.execute(
            text(
                'INSERT INTO "tenant_b".widgets (id, label) VALUES '
                "(100, 'B-hundred'), (200, 'B-two-hundred')"
            )
        )

    # Reset before yielding so the test body starts with no context.
    reset_tenant_schema(setup_token)

    try:
        yield _SCHEMAS
    finally:
        teardown_token = set_tenant_schema("main")
        try:
            with admin.begin() as conn:
                for s in _SCHEMAS:
                    conn.execute(text(f'DROP SCHEMA IF EXISTS "{s}" CASCADE'))
        finally:
            reset_tenant_schema(teardown_token)


# ---------------------------------------------------------------------------
# Single-mode backward compat — default schema fallback
# ---------------------------------------------------------------------------


def test_single_mode_default_search_path_is_main() -> None:
    """No tenant context set → checkout defaults to ``main`` in single mode."""

    settings = get_settings()
    assert settings.tenant_mode == "single", (
        "this test asserts single-mode default; "
        "set MAUGOOD_TENANT_MODE=single to run"
    )

    engine = get_engine()
    with engine.begin() as conn:
        assert conn.execute(text("SELECT current_schema()")).scalar_one() == DEFAULT_SCHEMA


# ---------------------------------------------------------------------------
# Isolation — the canary
# ---------------------------------------------------------------------------


def test_query_under_tenant_a_only_sees_tenant_a_rows(two_isolated_schemas) -> None:
    engine = get_engine()
    with tenant_context("tenant_a"):
        with engine.begin() as conn:
            ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )
    assert ids == [1, 2]


def test_query_under_tenant_b_only_sees_tenant_b_rows(two_isolated_schemas) -> None:
    engine = get_engine()
    with tenant_context("tenant_b"):
        with engine.begin() as conn:
            ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )
    assert ids == [100, 200]


def test_switching_context_switches_visible_rows(two_isolated_schemas) -> None:
    """A single test process can hit both schemas without leakage."""

    engine = get_engine()

    with tenant_context("tenant_a"):
        with engine.begin() as conn:
            a_ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )

    with tenant_context("tenant_b"):
        with engine.begin() as conn:
            b_ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )

    assert a_ids == [1, 2]
    assert b_ids == [100, 200]
    assert set(a_ids).isdisjoint(set(b_ids))


def test_inserts_route_to_active_schema_only(two_isolated_schemas) -> None:
    """A row inserted under tenant_a does not appear under tenant_b."""

    engine = get_engine()
    with tenant_context("tenant_a"):
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO widgets (id, label) VALUES (3, 'A-three')")
            )

    with tenant_context("tenant_b"):
        with engine.begin() as conn:
            ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )
    assert 3 not in ids, "tenant_a's insert leaked into tenant_b"
    assert ids == [100, 200]


# ---------------------------------------------------------------------------
# Fail-closed in multi mode
# ---------------------------------------------------------------------------


def test_multi_mode_no_context_refuses_to_query(monkeypatch) -> None:
    """In multi mode with no tenant context, the connection-checkout event
    raises before any SQL is issued (the v1.0 fail-closed red line)."""

    from maugood.config import Settings as _Settings  # noqa: PLC0415
    import maugood.config as _config  # noqa: PLC0415
    import maugood.db as _db  # noqa: PLC0415

    # Override get_settings to return multi mode for this test only.
    real_get_settings = _config.get_settings
    multi_settings = real_get_settings().model_copy(update={"tenant_mode": "multi"})
    monkeypatch.setattr(_config, "get_settings", lambda: multi_settings)
    # The db module imported get_settings at module load — patch the
    # reference held there too.
    monkeypatch.setattr(_db, "get_settings", lambda: multi_settings)

    # Make sure no contextvar is set before the checkout. Reset just in
    # case a previous test left one in flight.
    token = set_tenant_schema(None)
    try:
        engine = get_engine()
        with pytest.raises(RuntimeError, match="no tenant schema in scope"):
            with engine.begin() as conn:
                conn.execute(text("SELECT 1"))
    finally:
        reset_tenant_schema(token)


def test_multi_mode_with_context_works(monkeypatch, two_isolated_schemas) -> None:
    """Same multi-mode override, but with a context — queries succeed."""

    import maugood.config as _config  # noqa: PLC0415
    import maugood.db as _db  # noqa: PLC0415

    multi_settings = _config.get_settings().model_copy(update={"tenant_mode": "multi"})
    monkeypatch.setattr(_config, "get_settings", lambda: multi_settings)
    monkeypatch.setattr(_db, "get_settings", lambda: multi_settings)

    engine = get_engine()
    with tenant_context("tenant_a"):
        with engine.begin() as conn:
            ids = sorted(
                int(r[0])
                for r in conn.execute(text("SELECT id FROM widgets")).all()
            )
    assert ids == [1, 2]
