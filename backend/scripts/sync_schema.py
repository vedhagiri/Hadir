"""Reconcile per-tenant schema structure across every tenant.

Operator entry point for the durable post-migration schema sync.
Iterates ``public.tenants`` (every row, including ``main``) and applies
``sync_schema_structure`` + ``sync_schema_grants`` to each schema.
Safe to re-run at any time — both helpers are idempotent and additive.

Usage::

    docker compose exec backend python -m scripts.sync_schema

This is the same code ``scripts.migrate`` runs after every per-schema
``alembic upgrade head``. Running it standalone is the recovery path
for tenants that drifted before the post-migration hook was added,
or after a manual ``metadata.create_all`` against an existing schema.

Order per schema:

1. ``sync_schema_structure`` — adds missing columns, constraints, and
   indexes from ``maugood.db.metadata``.
2. ``sync_schema_grants`` — re-asserts ownership + GRANTs on every
   table (idempotent).

Errors on one schema log + continue to the next; the script exits
non-zero if any schema failed.
"""

from __future__ import annotations

import logging
import sys

from sqlalchemy import text

from maugood.db import make_admin_engine, reset_tenant_schema, set_tenant_schema
from scripts._grants import sync_schema_grants
from scripts._schema_sync import sync_schema_structure

logger = logging.getLogger("maugood.sync_schema")
logging.basicConfig(level=logging.INFO, format="[sync-schema] %(message)s")


def _all_schemas() -> list[str]:
    """Return every schema in ``public.tenants`` (including ``main``).

    Returns ``[]`` on a fresh DB where ``public.tenants`` hasn't been
    created yet.
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
    """Run structure + grants reconcile against one schema."""

    token = set_tenant_schema(schema_name)
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                struct = sync_schema_structure(conn, schema_name)
                grants = sync_schema_grants(conn, schema_name)
            return {**struct, **{f"grants_{k}": v for k, v in grants.items()}}
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
            result = sync_one(schema)
            logger.info("schema=%s synced: %s", schema, result)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "schema sync failed for schema=%s: %s: %s",
                schema,
                type(exc).__name__,
                exc,
            )
            failures.append((schema, f"{type(exc).__name__}: {exc}"))

    if failures:
        logger.error("%d schema(s) failed schema sync", len(failures))
        return 1
    logger.info("schemas synced across %d schema(s)", len(schemas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
