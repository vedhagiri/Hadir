"""
bootstrap_dev.py — minimum viable login set for a fresh Maugood machine.

WHAT THIS DOES
==============
After ``docker compose up`` on a clean machine, run this once to get:

  1 Super-Admin (MTS staff)
  Tenant ``mts_demo`` (synthetic demo) with 6 role variations:
      - Admin
      - HR
      - Manager (Engineering)
      - Manager (Operations)
      - Dual-role HR + Manager
      - Employee
  Tenant ``inaisys`` (real corporate test) with 3 users:
      - Admin
      - HR
      - Employee

Total: 1 super-admin + 9 tenant users = 10 logins.

WHAT THIS DOES *NOT* DO
=======================
- Does not seed the 100+ synthetic employees / shift policies / departments
  in mts_demo. That's ``pre_omran_reset.py``'s job. This script is the
  smaller "I can log in" bootstrap, not the full demo dataset.
- Does not configure cameras, RTSP URLs, photos, or any face data.
- Does not run database migrations. Run ``alembic upgrade head`` first.

OUTPUT
======
- Prints credentials to stdout (one block per user)
- Writes to ``/data/credentials.txt`` inside the container, plus
  /repo-root/credentials.txt if /data isn't writable (dev outside Docker)
- Both locations are gitignored — verify in .gitignore before commit

IDEMPOTENCY
===========
Safe to run twice. Existing tenants and users are detected and skipped
with a clear log line. To wipe and recreate, run ``pre_omran_reset.py``
which intentionally drops state.

USAGE
=====
After ``docker compose up`` and migrations:
    docker compose exec backend python -m scripts.bootstrap_dev

For verbose mode showing each SQL operation:
    docker compose exec backend python -m scripts.bootstrap_dev --verbose
"""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import string
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from argon2 import PasswordHasher
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

# Reuse the existing tenant provisioning logic — do not duplicate.
# This module's contract: takes a slug, creates the public.tenants row,
# creates the tenant_<slug> schema, runs migrations into it, returns
# the tenant id. We're not reimplementing that here.
try:
    from scripts.provision_tenant import provision_tenant  # type: ignore
except ImportError:
    # If the script lives elsewhere, fall back to a direct path import
    sys.path.insert(0, str(Path(__file__).parent))
    from provision_tenant import provision_tenant  # type: ignore


logger = logging.getLogger("bootstrap_dev")


# ─────────────────────────────────────────────────────────────────────
# Configuration — what we create
# ─────────────────────────────────────────────────────────────────────

@dataclass
class UserSpec:
    """One user to create within a tenant (or as super-admin)."""
    email: str
    full_name: str
    roles: list[str]                       # e.g. ["Admin"], ["HR", "Manager"]
    department: Optional[str] = None       # for tenant users with manager scope
    description: str = ""                  # one-line note for credentials.txt


@dataclass
class TenantSpec:
    """One tenant to create."""
    slug: str                              # human-friendly slug (no `tenant_` prefix)
    name: str                              # display name
    primary_color_key: str = "navy"        # design token name
    description: str = ""
    users: list[UserSpec] = field(default_factory=list)


# These two tenants are the bootstrap baseline. Add more by editing this list.
# pre_omran_reset.py uses the same slugs but adds the full demo dataset on top.
TENANTS: list[TenantSpec] = [
    TenantSpec(
        slug="mts_demo",
        name="MTS Demo",
        primary_color_key="plum",
        description="Synthetic demo tenant — fake cameras, exercise every feature.",
        users=[
            UserSpec(
                email="admin@mts-demo.example.com",
                full_name="MTS Demo Admin",
                roles=["Admin"],
                description="Full tenant admin — can do everything.",
            ),
            UserSpec(
                email="hr@mts-demo.example.com",
                full_name="MTS Demo HR",
                roles=["HR"],
                description="HR-only — approvals, policies, no camera/system access.",
            ),
            UserSpec(
                email="manager.eng@mts-demo.example.com",
                full_name="Engineering Manager",
                roles=["Manager"],
                department="Engineering",
                description="Manager scoped to Engineering department.",
            ),
            UserSpec(
                email="manager.ops@mts-demo.example.com",
                full_name="Operations Manager",
                roles=["Manager"],
                department="Operations",
                description="Manager scoped to Operations department.",
            ),
            UserSpec(
                email="dual.role@mts-demo.example.com",
                full_name="Dual-role User (HR + Manager)",
                roles=["HR", "Manager"],
                department="Operations",
                description="HR + Operations Manager — exercises role switcher.",
            ),
            UserSpec(
                email="employee@mts-demo.example.com",
                full_name="Demo Employee",
                roles=["Employee"],
                description="Plain employee — own attendance only.",
            ),
        ],
    ),
    TenantSpec(
        slug="inaisys",
        name="Inaisys Solutions",
        primary_color_key="navy",
        description="Real corporate tenant — for testing against actual office camera.",
        users=[
            UserSpec(
                email="admin@inaisys.local",
                full_name="Inaisys Admin",
                roles=["Admin"],
                description="Inaisys tenant admin.",
            ),
            UserSpec(
                email="hr@inaisys.local",
                full_name="Inaisys HR",
                roles=["HR"],
                description="Inaisys HR user.",
            ),
            UserSpec(
                email="employee@inaisys.local",
                full_name="Suresh Kumar",
                roles=["Employee"],
                description="Real employee for end-to-end face matching test.",
            ),
        ],
    ),
]


SUPER_ADMIN_EMAIL = "superadmin@mts.test"
SUPER_ADMIN_NAME = "MTS Super Admin"


# ─────────────────────────────────────────────────────────────────────
# Password generation
# ─────────────────────────────────────────────────────────────────────

def generate_password(length: int = 16) -> str:
    """
    Generate a strong random password.

    Uses URL-safe alphabet (letters + digits) plus a few punctuation chars
    that don't need shell-escaping. Length 16 = 95 bits of entropy. Good
    enough that even with leaked Argon2 hashes, brute force is infeasible.

    No symbols that confuse copy-paste: no quotes, backslashes, dollar signs.
    """
    alphabet = string.ascii_letters + string.digits + "!@#-_+"
    # secrets.choice is cryptographically secure — do not use random.choice
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ─────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────

def get_engine() -> Engine:
    """Read MAUGOOD_DATABASE_URL and return a SQLAlchemy engine."""
    url = os.environ.get("MAUGOOD_DATABASE_URL")
    if not url:
        sys.exit("MAUGOOD_DATABASE_URL is not set in the environment.")
    return create_engine(url, future=True)


def super_admin_exists(engine: Engine, email: str) -> bool:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT 1 FROM public.super_admins WHERE email = :email"),
            {"email": email},
        ).first()
    return row is not None


def tenant_exists(engine: Engine, slug: str) -> bool:
    with engine.connect() as conn:
        # Match against the slug column added in P28.5+ migrations. If your
        # codebase still keys off schema_name, the column reference here
        # is ``schema_name`` and the value is ``f"tenant_{slug}"``.
        row = conn.execute(
            text("SELECT 1 FROM public.tenants WHERE slug = :slug"),
            {"slug": slug},
        ).first()
    return row is not None


def user_exists_in_tenant(engine: Engine, schema: str, email: str) -> bool:
    with engine.connect() as conn:
        conn.execute(text(f'SET search_path TO "{schema}", public'))
        row = conn.execute(
            text("SELECT 1 FROM users WHERE email = :email"),
            {"email": email},
        ).first()
    return row is not None


# ─────────────────────────────────────────────────────────────────────
# Creation logic
# ─────────────────────────────────────────────────────────────────────

def create_super_admin(engine: Engine, hasher: PasswordHasher) -> Optional[str]:
    """Create the super-admin if missing. Returns the password if created, else None."""
    if super_admin_exists(engine, SUPER_ADMIN_EMAIL):
        logger.info("super-admin %s already exists, skipping", SUPER_ADMIN_EMAIL)
        return None

    pw = generate_password()
    pw_hash = hasher.hash(pw)

    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO public.super_admins
                    (email, full_name, password_hash, is_active, created_at)
                VALUES
                    (:email, :name, :hash, true, :now)
                """
            ),
            {
                "email": SUPER_ADMIN_EMAIL,
                "name": SUPER_ADMIN_NAME,
                "hash": pw_hash,
                "now": datetime.now(timezone.utc),
            },
        )
    logger.info("created super-admin %s", SUPER_ADMIN_EMAIL)
    return pw


def create_tenant(engine: Engine, spec: TenantSpec) -> int:
    """Create the tenant via existing provisioning logic. Returns tenant_id."""
    if tenant_exists(engine, spec.slug):
        logger.info("tenant %s already exists, looking up id", spec.slug)
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT id FROM public.tenants WHERE slug = :slug"),
                {"slug": spec.slug},
            ).first()
        return int(row.id)

    # provision_tenant from the existing script handles: tenants row,
    # schema creation, alembic migrations, default tenant_settings,
    # default tenant_branding. Do not reimplement.
    tenant_id = provision_tenant(
        slug=spec.slug,
        name=spec.name,
        primary_color_key=spec.primary_color_key,
    )
    logger.info("created tenant %s (id=%d)", spec.slug, tenant_id)
    return tenant_id


def create_user_in_tenant(
    engine: Engine,
    hasher: PasswordHasher,
    tenant_id: int,
    schema: str,
    user: UserSpec,
) -> Optional[str]:
    """Create one user with role assignments. Returns password if created."""
    if user_exists_in_tenant(engine, schema, user.email):
        logger.info("user %s already exists in %s, skipping", user.email, schema)
        return None

    pw = generate_password()
    pw_hash = hasher.hash(pw)

    with engine.begin() as conn:
        conn.execute(text(f'SET search_path TO "{schema}", public'))

        # 1. Insert into users
        result = conn.execute(
            text(
                """
                INSERT INTO users
                    (tenant_id, email, full_name, password_hash, is_active)
                VALUES
                    (:tid, :email, :name, :hash, true)
                RETURNING id
                """
            ),
            {
                "tid": tenant_id,
                "email": user.email,
                "name": user.full_name,
                "hash": pw_hash,
            },
        )
        user_id = result.scalar_one()

        # 2. Assign roles via user_roles
        for role_name in user.roles:
            role_row = conn.execute(
                text("SELECT id FROM roles WHERE name = :name"),
                {"name": role_name},
            ).first()
            if role_row is None:
                raise RuntimeError(
                    f"Role {role_name!r} not found in {schema}. "
                    f"Did the tenant migration seed roles?"
                )
            conn.execute(
                text(
                    """
                    INSERT INTO user_roles (user_id, role_id)
                    VALUES (:uid, :rid)
                    """
                ),
                {"uid": user_id, "rid": role_row.id},
            )

        # 3. If Manager, scope to a department
        if "Manager" in user.roles and user.department:
            dept_row = conn.execute(
                text("SELECT id FROM departments WHERE name = :name"),
                {"name": user.department},
            ).first()
            if dept_row is None:
                # Create the department if absent — bootstrap should not fail
                # because pre_omran_reset.py hasn't run yet
                dept_result = conn.execute(
                    text("INSERT INTO departments (name) VALUES (:name) RETURNING id"),
                    {"name": user.department},
                )
                dept_id = dept_result.scalar_one()
                logger.info("auto-created department %r in %s", user.department, schema)
            else:
                dept_id = dept_row.id

            conn.execute(
                text(
                    """
                    INSERT INTO user_departments (user_id, department_id)
                    VALUES (:uid, :did)
                    """
                ),
                {"uid": user_id, "did": dept_id},
            )

    logger.info("created user %s in %s with roles=%s", user.email, schema, user.roles)
    return pw


# ─────────────────────────────────────────────────────────────────────
# Output formatting
# ─────────────────────────────────────────────────────────────────────

def write_credentials(records: list[dict], paths: list[Path]) -> list[Path]:
    """Write credentials to the first writeable path in the list. Return the paths written."""
    body = format_credentials(records)
    written = []
    for p in paths:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body, encoding="utf-8")
            # Set 0600 — these are secrets even in dev
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass  # Windows or read-only FS; warning emitted via logger
            written.append(p)
            logger.info("wrote credentials to %s", p)
        except OSError as e:
            logger.warning("could not write %s: %s", p, e)
    return written


def format_credentials(records: list[dict]) -> str:
    """Return the credentials.txt body as a string."""
    lines = []
    lines.append("=" * 78)
    lines.append("Maugood bootstrap credentials")
    lines.append(f"Generated: {datetime.now(timezone.utc).isoformat()}")
    lines.append("=" * 78)
    lines.append("")
    lines.append("This file is gitignored. Do not commit it.")
    lines.append("Passwords are random per bootstrap run. To regenerate, drop the")
    lines.append("affected user/tenant rows and re-run bootstrap_dev.py.")
    lines.append("")
    lines.append("=" * 78)
    lines.append("")

    grouped: dict[str, list[dict]] = {}
    for rec in records:
        grouped.setdefault(rec["section"], []).append(rec)

    for section, rows in grouped.items():
        lines.append(f"## {section}")
        lines.append("")
        for r in rows:
            lines.append(f"  Email:    {r['email']}")
            if r.get("tenant_slug"):
                lines.append(f"  Tenant:   {r['tenant_slug']}")
            lines.append(f"  Password: {r['password']}")
            if r.get("description"):
                lines.append(f"  Note:     {r['description']}")
            lines.append("")
        lines.append("-" * 78)
        lines.append("")

    lines.append("End of credentials.")
    lines.append("")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bootstrap a fresh Maugood machine with super-admin and 2 demo tenants."
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Verbose logging (per-SQL).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    engine = get_engine()
    hasher = PasswordHasher()
    records: list[dict] = []

    # ── Super-admin ────────────────────────────────────────────────
    pw = create_super_admin(engine, hasher)
    if pw:
        records.append({
            "section": "Super-Admin (MTS staff console)",
            "email": SUPER_ADMIN_EMAIL,
            "password": pw,
            "description": "Login at /super-admin/login (separate from tenant login).",
        })
    else:
        records.append({
            "section": "Super-Admin (MTS staff console)",
            "email": SUPER_ADMIN_EMAIL,
            "password": "(unchanged — already existed)",
            "description": "If forgotten, drop public.super_admins row and re-run.",
        })

    # ── Tenants ────────────────────────────────────────────────────
    for spec in TENANTS:
        tenant_id = create_tenant(engine, spec)
        schema = f"tenant_{spec.slug}"

        for user in spec.users:
            pw = create_user_in_tenant(engine, hasher, tenant_id, schema, user)
            section = f"Tenant: {spec.slug}  ({spec.name}) — {spec.description}"
            if pw:
                records.append({
                    "section": section,
                    "email": user.email,
                    "tenant_slug": spec.slug,
                    "password": pw,
                    "description": user.description,
                })
            else:
                records.append({
                    "section": section,
                    "email": user.email,
                    "tenant_slug": spec.slug,
                    "password": "(unchanged — already existed)",
                    "description": user.description,
                })

    # ── Output ─────────────────────────────────────────────────────
    body = format_credentials(records)
    print()
    print(body)

    # Try /data/credentials.txt first (mounted volume in Docker), then
    # fall back to repo root if /data isn't writable.
    written = write_credentials(records, [
        Path("/data/credentials.txt"),
        Path("credentials.txt"),
    ])

    if not written:
        logger.warning(
            "Could not write credentials.txt to any path. "
            "The credentials above are your only copy — save them now."
        )
        return 2

    print(f"Credentials written to: {', '.join(str(p) for p in written)}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
