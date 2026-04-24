"""Seed an Admin user for tenant 1.

Usage::

    python -m scripts.seed_admin --email admin@example.com --password 'correct horse battery staple'

Or via environment variables (convenient in CI / deploy scripts)::

    HADIR_SEED_EMAIL=admin@example.com HADIR_SEED_PASSWORD='...' python -m scripts.seed_admin

The password is hashed with Argon2id before going anywhere near the database
or logs. The script prints the seeded email and the resulting user id; it
never echoes the password (and refuses to run if one is not provided).

Connects as ``hadir_app`` (the same role the application uses) so the grants
put in place by migration ``0001_initial`` are exercised end-to-end.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional

from argon2 import PasswordHasher
from sqlalchemy import insert, select
from sqlalchemy.engine import Engine

from hadir.db import make_engine, roles, user_roles, users

logger = logging.getLogger("hadir.seed_admin")

PILOT_TENANT_ID = 1
ADMIN_ROLE_CODE = "Admin"


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed an Admin user for tenant 1.")
    parser.add_argument(
        "--email",
        default=os.environ.get("HADIR_SEED_EMAIL"),
        help="Admin email. Defaults to $HADIR_SEED_EMAIL.",
    )
    # Password has NO default on the CLI — we don't want it showing up in
    # --help output. It reads from $HADIR_SEED_PASSWORD only.
    parser.add_argument(
        "--password",
        default=None,
        help="Admin password. If omitted, reads $HADIR_SEED_PASSWORD.",
    )
    parser.add_argument(
        "--full-name",
        default=os.environ.get("HADIR_SEED_FULL_NAME", "Pilot Admin"),
        help="Display name. Defaults to $HADIR_SEED_FULL_NAME or 'Pilot Admin'.",
    )
    return parser.parse_args(argv)


def _resolve_password(cli_password: Optional[str]) -> str:
    password = cli_password or os.environ.get("HADIR_SEED_PASSWORD")
    if not password:
        logger.error(
            "No password supplied. Pass --password or set HADIR_SEED_PASSWORD. "
            "Seed aborted."
        )
        sys.exit(2)
    return password


def seed_admin(
    engine: Engine,
    *,
    email: str,
    password: str,
    full_name: str,
    tenant_id: int = PILOT_TENANT_ID,
) -> int:
    """Create or update an Admin user and return their id.

    If a user already exists at ``(tenant_id, email)`` the password hash and
    full name are updated in place and the admin role is re-asserted. This
    makes the script safe to re-run during pilot setup.
    """

    hasher = PasswordHasher()
    password_hash = hasher.hash(password)

    with engine.begin() as conn:
        admin_role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == tenant_id,
                roles.c.code == ADMIN_ROLE_CODE,
            )
        ).scalar_one()

        existing_id = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == tenant_id,
                users.c.email == email,
            )
        ).scalar_one_or_none()

        if existing_id is None:
            user_id = conn.execute(
                insert(users)
                .values(
                    tenant_id=tenant_id,
                    email=email,
                    password_hash=password_hash,
                    full_name=full_name,
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        else:
            conn.execute(
                users.update()
                .where(users.c.id == existing_id, users.c.tenant_id == tenant_id)
                .values(
                    password_hash=password_hash,
                    full_name=full_name,
                    is_active=True,
                )
            )
            user_id = int(existing_id)

        # Idempotent role assignment: only insert if missing.
        has_role = conn.execute(
            select(user_roles.c.user_id).where(
                user_roles.c.tenant_id == tenant_id,
                user_roles.c.user_id == user_id,
                user_roles.c.role_id == admin_role_id,
            )
        ).first()
        if has_role is None:
            conn.execute(
                insert(user_roles).values(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role_id=admin_role_id,
                )
            )

    return int(user_id)


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = _parse_args(argv)

    if not args.email:
        logger.error("No email supplied. Pass --email or set HADIR_SEED_EMAIL.")
        return 2
    email = args.email.strip().lower()
    password = _resolve_password(args.password)

    engine = make_engine()
    user_id = seed_admin(
        engine,
        email=email,
        password=password,
        full_name=args.full_name,
    )
    # We log email + user id only. Password never appears in stdout/stderr.
    logger.info("Seeded Admin user: id=%s email=%s tenant_id=%s", user_id, email, PILOT_TENANT_ID)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
