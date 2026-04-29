"""Seed (or upsert) an MTS staff user in ``public.mts_staff``.

Usage::

    docker compose exec -e MAUGOOD_SUPER_ADMIN_PASSWORD='…' backend \\
        python -m scripts.seed_super_admin --email you@mts.om \\
        --full-name "Your Name"

Or via env vars (CI / deploy)::

    MAUGOOD_SUPER_ADMIN_EMAIL=you@mts.om \\
    MAUGOOD_SUPER_ADMIN_PASSWORD='…' \\
    MAUGOOD_SUPER_ADMIN_FULL_NAME='Your Name' \\
        python -m scripts.seed_super_admin

Idempotent: re-running with the same email upserts the password hash
and full name. Argon2id-hashed; the plain password never appears in
stdout, stderr, or the audit log.

The script connects via ``maugood_admin`` (the migrations role) so it
can write to ``public.mts_staff`` even on a brand-new DB before the
``maugood_app`` grants are exercised by any other path.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional

from sqlalchemy import insert, select, update

from maugood.auth.passwords import hash_password
from maugood.db import (
    make_admin_engine,
    mts_staff,
    reset_tenant_schema,
    set_tenant_schema,
)

logger = logging.getLogger("maugood.seed_super_admin")


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed an MTS Super-Admin user (public.mts_staff)."
    )
    parser.add_argument(
        "--email",
        default=os.environ.get("MAUGOOD_SUPER_ADMIN_EMAIL"),
        help="Operator email. Defaults to $MAUGOOD_SUPER_ADMIN_EMAIL.",
    )
    parser.add_argument(
        "--password",
        default=None,
        help=(
            "Operator password. If omitted, reads $MAUGOOD_SUPER_ADMIN_PASSWORD."
        ),
    )
    parser.add_argument(
        "--full-name",
        default=os.environ.get("MAUGOOD_SUPER_ADMIN_FULL_NAME", "MTS Super Admin"),
        help="Display name. Defaults to $MAUGOOD_SUPER_ADMIN_FULL_NAME or 'MTS Super Admin'.",
    )
    return parser.parse_args(argv)


def seed_super_admin(*, email: str, password: str, full_name: str) -> int:
    """Insert or update the MTS staff row keyed on email."""

    password_hash = hash_password(password)

    engine = make_admin_engine()
    token = set_tenant_schema("public")
    try:
        with engine.begin() as conn:
            existing = conn.execute(
                select(mts_staff.c.id).where(mts_staff.c.email == email)
            ).scalar_one_or_none()

            if existing is None:
                staff_id = conn.execute(
                    insert(mts_staff)
                    .values(
                        email=email,
                        password_hash=password_hash,
                        full_name=full_name,
                        is_active=True,
                    )
                    .returning(mts_staff.c.id)
                ).scalar_one()
            else:
                conn.execute(
                    update(mts_staff)
                    .where(mts_staff.c.id == existing)
                    .values(
                        password_hash=password_hash,
                        full_name=full_name,
                        is_active=True,
                    )
                )
                staff_id = int(existing)
        return int(staff_id)
    finally:
        reset_tenant_schema(token)
        engine.dispose()


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = _parse_args(argv)

    if not args.email:
        logger.error(
            "No email supplied. Pass --email or set MAUGOOD_SUPER_ADMIN_EMAIL."
        )
        return 2
    email = args.email.strip().lower()

    password = args.password or os.environ.get("MAUGOOD_SUPER_ADMIN_PASSWORD")
    if not password:
        logger.error(
            "No password supplied. Pass --password or set "
            "MAUGOOD_SUPER_ADMIN_PASSWORD."
        )
        return 2

    staff_id = seed_super_admin(
        email=email, password=password, full_name=args.full_name
    )
    logger.info("Seeded MTS staff user: id=%s email=%s", staff_id, email)
    return 0


if __name__ == "__main__":
    sys.exit(main())
