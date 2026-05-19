"""Reconcile per-tenant schema grants across every tenant.

Operator entry point for the durable post-migration grants sync.
Iterates ``public.tenants`` (every row, including ``main``) and applies
``sync_schema_grants`` to each schema. Safe to re-run at any time —
the helper is idempotent.

Usage::

    docker compose exec backend python -m scripts.sync_grants

This is the same code ``scripts.migrate`` runs after every per-schema
``alembic upgrade head``. Running it standalone is the recovery path
for tenants that drifted before the post-migration hook was added.
"""

from __future__ import annotations

import logging
import sys

from sqlalchemy import text

from maugood.db import make_admin_engine, reset_tenant_schema, set_tenant_schema
from scripts._grants import sync_schema_grants

logger = logging.getLogger("maugood.sync_grants")
logging.basicConfig(level=logging.INFO, format="[sync-grants] %(message)s")


def _all_schemas() -> list[str]:
    """Return every schema in ``public.tenants`` (including ``main``).

    Returns ``[]`` on a fresh DB where ``public.tenants`` hasn't been
    created yet (the orchestrator runs the bootstrap migrations first,
    so this is only the empty-DB case).
    """

    token = set_tenant_schema("public")
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                exists = conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.tables "
                        "  WHERE table_schema='public' AND table_name='tenants'"
                        ")"
                    )
                ).scalar()
                if not exists:
                    return []
                rows = conn.execute(
                    text(
                        "SELECT schema_name FROM public.tenants ORDER BY id"
                    )
                ).all()
                return [str(r.schema_name) for r in rows]
        finally:
            engine.dispose()
    finally:
        reset_tenant_schema(token)


def sync_one(schema_name: str) -> dict[str, int]:
    """Run the grants sync against a single schema in its own transaction."""

    token = set_tenant_schema(schema_name)
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                return sync_schema_grants(conn, schema_name)
        finally:
            engine.dispose()
    finally:
        reset_tenant_schema(token)


def main() -> int:
    schemas = _all_schemas()
    if not schemas:
        logger.info("no tenants registered yet — nothing to sync")
        return 0

    failures: list[tuple[str, str]] = []
    for schema in schemas:
        try:
            sync_one(schema)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "grants sync failed for schema=%s: %s: %s",
                schema,
                type(exc).__name__,
                exc,
            )
            failures.append((schema, f"{type(exc).__name__}: {exc}"))

    if failures:
        logger.error("%d schema(s) failed grants sync", len(failures))
        return 1
    logger.info("grants synced across %d schema(s)", len(schemas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
