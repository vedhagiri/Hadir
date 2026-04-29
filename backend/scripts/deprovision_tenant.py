"""Deprovision a Maugood tenant: drop the schema, remove the registry row.

**This is destructive.** It runs ``DROP SCHEMA <slug> CASCADE`` and
deletes the corresponding ``public.tenants`` row. Every employee record,
attendance row, encrypted face photo metadata, audit history, and
session for that tenant is gone the moment the transaction commits.

Usage::

    docker compose exec backend python -m scripts.deprovision_tenant \\
        --slug tenant_x --confirm

Required guardrails:

* Refuses to run without ``--confirm`` *and* a typed re-confirmation
  on stdin matching the slug. ``--confirm`` alone isn't enough — an
  operator must read the slug back to the prompt.
* Refuses to run in production (``MAUGOOD_ENV=production``) unless
  ``--backup-taken`` is passed. The flag asserts that the operator has
  taken a fresh DB backup *in this same session* — there is no way for
  the script to verify that, so the assertion is a hard checkpoint
  on the operator's discipline, not a technical guarantee. Hence
  ``--backup-taken`` is documented and must be passed deliberately.
* Refuses to drop the pilot schema ``main``. That row is only
  removable by a separate migration if the pilot tenant is ever
  rebadged.

The encrypted face crops on disk under ``/data/faces/<tenant_id>/`` are
**not** removed by this script — they're outside the DB and the
operator must clean up the volume separately. The script logs the
expected path so a follow-up ``rm -rf`` is one command away.
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Optional

from sqlalchemy import select, text

from maugood.config import get_settings
from maugood.db import (
    make_admin_engine,
    reset_tenant_schema,
    set_tenant_schema,
    tenants,
)
from maugood.tenants.slug import SLUG_RE

logger = logging.getLogger("maugood.deprovision_tenant")


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Deprovision a Maugood tenant (DESTRUCTIVE).",
    )
    parser.add_argument(
        "--slug",
        required=True,
        help="Friendly tenant slug (e.g. 'omran'). Looked up against public.tenants.slug.",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help=(
            "First confirmation gate. Required, but on its own not "
            "sufficient — an interactive re-typing of the slug follows."
        ),
    )
    parser.add_argument(
        "--backup-taken",
        action="store_true",
        help=(
            "Assert that a fresh DB backup was taken in this same session. "
            "Required when MAUGOOD_ENV=production."
        ),
    )
    parser.add_argument(
        "--yes-i-know",
        action="store_true",
        help=(
            "Skip the interactive slug re-confirmation. Intended for "
            "automation; never use this without --backup-taken in production."
        ),
    )
    return parser.parse_args(argv)


def _interactive_confirm(slug: str) -> bool:
    """Prompt the operator to re-type the slug. Returns True on match."""

    logger.warning(
        "About to DROP SCHEMA %s CASCADE. Type the slug to confirm:",
        slug,
    )
    try:
        typed = input("> ").strip()
    except EOFError:
        return False
    return typed == slug


def deprovision(*, slug: str) -> dict[str, object]:
    """Drop the schema and registry row for the friendly ``slug``.

    Raises if the slug is invalid, the tenant doesn't exist, or it's
    the protected pilot tenant (``slug='main'``).
    """

    if not SLUG_RE.match(slug):
        raise ValueError(
            f"invalid slug {slug!r}: must match {SLUG_RE.pattern}"
        )
    if slug == "main":
        raise ValueError(
            "refusing to drop the pilot tenant (slug='main') — this "
            "script cannot remove the legacy tenant"
        )

    engine = make_admin_engine()
    token = set_tenant_schema("public")
    try:
        with engine.begin() as conn:
            # Look up by friendly slug; the row's schema_name is the
            # internal Postgres identifier we DROP.
            row = conn.execute(
                select(tenants.c.id, tenants.c.name, tenants.c.schema_name).where(
                    tenants.c.slug == slug
                )
            ).first()
            if row is None:
                raise ValueError(f"no tenant with slug={slug!r}")

            tenant_id = int(row.id)
            tenant_name = row.name
            schema_name = str(row.schema_name)

            # CASCADE drops every per-tenant table along with FK
            # constraints from those tables to public.tenants — leaves
            # the registry row free to delete.
            conn.execute(text(f'DROP SCHEMA "{schema_name}" CASCADE'))

            conn.execute(
                text("DELETE FROM public.tenants WHERE id = :tid"),
                {"tid": tenant_id},
            )

        return {
            "tenant_id": tenant_id,
            "tenant_name": tenant_name,
            "slug": slug,
            "schema": schema_name,
            "expected_face_crops_path": f"/data/faces/{tenant_id}/",
            "expected_capture_crops_path": f"/data/faces/captures/{tenant_id}/",
        }
    finally:
        reset_tenant_schema(token)
        engine.dispose()


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="[deprovision] %(message)s")
    args = _parse_args(argv)

    if not args.confirm:
        logger.error("missing --confirm; refusing to proceed")
        return 2

    settings = get_settings()
    if settings.env == "production" and not args.backup_taken:
        logger.error(
            "production environment detected — refusing to deprovision without "
            "--backup-taken (take a fresh DB backup in this session and pass "
            "--backup-taken to acknowledge)"
        )
        return 2

    if not args.yes_i_know:
        if not _interactive_confirm(args.slug):
            logger.error("slug re-confirmation failed; aborting")
            return 2

    try:
        result = deprovision(slug=args.slug)
    except Exception as exc:
        logger.error("deprovisioning failed: %s: %s", type(exc).__name__, exc)
        return 1

    logger.info(
        "deprovisioned tenant_id=%s name=%s schema=%s",
        result["tenant_id"],
        result["tenant_name"],
        result["schema"],
    )
    logger.warning(
        "encrypted face crops under %s and %s were NOT removed; clean up "
        "the volume separately if required",
        result["expected_face_crops_path"],
        result["expected_capture_crops_path"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
