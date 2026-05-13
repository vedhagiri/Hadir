"""Cleanup script — removes ``ZZZ*`` test fixture pollution from
the ``main`` tenant (and any other tenant) accumulated by pytest
fixtures that didn't fully roll back.

BUG-049: Divisions/Sections/Departments display incorrect values
because per-test fixtures left ``ZZZxxxx`` placeholder rows behind.
The fixtures themselves now ROLLBACK; this script cleans up legacy
pollution that pre-dates the rollback fix.

Usage::

    docker compose exec backend python -m scripts.cleanup_test_pollution

Refuses to run when ``MAUGOOD_ENV`` resolves to ``production`` — this
is dev-only by design.
"""

from __future__ import annotations

import logging
import sys

from sqlalchemy import delete, select, text

from maugood.config import get_settings
from maugood.db import (
    departments,
    divisions,
    get_engine,
    sections,
    tenant_context,
)


logger = logging.getLogger("cleanup_test_pollution")


def _clean_schema(schema: str) -> dict[str, int]:
    """Drop ``ZZZ*``-coded rows from divisions / departments / sections
    in the active tenant schema. Returns per-table delete counts."""

    engine = get_engine()
    counts: dict[str, int] = {"divisions": 0, "departments": 0, "sections": 0}
    with tenant_context(schema):
        with engine.begin() as conn:
            for table_name, table in (
                ("sections", sections),
                ("departments", departments),
                ("divisions", divisions),
            ):
                result = conn.execute(
                    delete(table).where(table.c.code.like("ZZZ%"))
                )
                counts[table_name] = int(result.rowcount or 0)
    return counts


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = get_settings()
    if settings.env == "production":
        print(
            "Refusing to run in production. ZZZ rows are test pollution; "
            "a production tenant should never contain them.",
            file=sys.stderr,
        )
        sys.exit(1)

    engine = get_engine()
    with engine.begin() as conn:
        tenants = conn.execute(
            text("SELECT slug, schema_name FROM public.tenants ORDER BY id")
        ).fetchall()

    grand = 0
    for row in tenants:
        schema = str(row.schema_name)
        counts = _clean_schema(schema)
        total = sum(counts.values())
        grand += total
        if total > 0:
            logger.info(
                "cleanup %s: divisions=%d departments=%d sections=%d (total=%d)",
                schema,
                counts["divisions"],
                counts["departments"],
                counts["sections"],
                total,
            )
        else:
            logger.info("cleanup %s: no ZZZ rows", schema)

    print(f"\n✓ Removed {grand} polluted row(s) across {len(tenants)} tenant(s).")


if __name__ == "__main__":
    main()
