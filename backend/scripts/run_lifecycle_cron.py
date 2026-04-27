"""Manual trigger for the P28.7 employee lifecycle cron.

Used by the validation walkthrough so Suresh can confirm the auto-flip
without waiting for midnight. Walks every active tenant in
``public.tenants`` and runs the same logic the daily cron does.

    docker compose exec backend python -m scripts.run_lifecycle_cron
    docker compose exec backend python -m scripts.run_lifecycle_cron --tenant-slug inaisys

Per-tenant errors are logged + skipped — one bad tenant does not block
the rest.
"""

from __future__ import annotations

import argparse
import logging
import sys

from sqlalchemy import select

from hadir.db import make_admin_engine, tenant_context, tenants as t_tenants
from hadir.employees.lifecycle_cron import run_all_tenants, run_for_tenant


def _resolve_one_tenant(slug: str) -> tuple[int, str]:
    """Resolve a friendly slug to (tenant_id, schema_name)."""

    admin_engine = make_admin_engine()
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(t_tenants.c.id, t_tenants.c.schema_name).where(
                    t_tenants.c.slug == slug
                )
            ).first()
    if row is None:
        raise SystemExit(f"unknown tenant slug: {slug!r}")
    return int(row.id), str(row.schema_name)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tenant-slug",
        help="Run for a single tenant only (default: all active tenants)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if args.tenant_slug:
        tenant_id, schema = _resolve_one_tenant(args.tenant_slug)
        flipped = run_for_tenant(tenant_id, schema)
        print(f"tenant_id={tenant_id} schema={schema} flipped={flipped}")
        return 0

    summary = run_all_tenants()
    if not summary:
        print("no active tenants in public.tenants")
        return 0
    for tid, count in summary.items():
        print(f"tenant_id={tid} flipped={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
