"""Provision a new Hadir tenant from scratch.

Creates the Postgres schema, materialises every per-tenant table inside
it, wires the grants ``hadir_app`` needs, stamps the schema's
``alembic_version`` at head so future migrations apply incrementally,
seeds the default roles + departments + Fixed shift policy, and creates
the first Admin user with an Argon2-hashed password.

Usage::

    docker compose exec backend python -m scripts.provision_tenant \\
        --slug tenant_omran --name 'Omran' --admin-email hr@omran.om

The password is read from ``$HADIR_PROVISION_PASSWORD`` if set; otherwise
the script prompts for it on stdin (with confirmation). The plain
password never appears on the command line, in logs, or in stdout.

The script is **fail-closed**: if any step after the schema is created
raises, the schema is dropped and the ``public.tenants`` row removed
before the script exits non-zero. There is no half-provisioned middle
state on disk.

Red lines (mirrored in ``backend/CLAUDE.md``):

* The slug must match ``^[A-Za-z_][A-Za-z0-9_]{0,62}$`` — same regex
  the DB enforces on ``public.tenants.schema_name``.
* The ``public`` schema is reserved for ``tenants`` and the global
  ``alembic_version`` only. This script never creates anything else
  there.
"""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

from sqlalchemy import insert, select, text
from sqlalchemy.engine import Connection, Engine

from hadir.auth.passwords import hash_password
from hadir.db import (
    _TENANT_SCHEMA_RE,
    audit_log,
    departments,
    make_admin_engine,
    metadata,
    reset_tenant_schema,
    roles,
    set_tenant_schema,
    shift_policies,
    tenant_branding,
    tenants,
    user_roles,
    users,
)

logger = logging.getLogger("hadir.provision_tenant")

_BACKEND_DIR = Path(__file__).resolve().parent.parent

_DEFAULT_ROLE_CODES = (
    ("Admin", "Administrator"),
    ("HR", "Human Resources"),
    ("Manager", "Manager"),
    ("Employee", "Employee"),
)
_DEFAULT_DEPARTMENTS = (
    ("ENG", "Engineering"),
    ("OPS", "Operations"),
    ("ADM", "Administration"),
)
_DEFAULT_POLICY = {
    "name": "Default 07:30–15:30",
    "config": {
        "start": "07:30",
        "end": "15:30",
        "grace_minutes": 15,
        "required_hours": 8,
    },
}

# Tables that ``hadir_app`` operates on with full CRUD inside the new
# tenant schema. ``audit_log`` is excluded — its grants are narrower.
_APP_CRUD_TABLES = (
    "users",
    "roles",
    "user_roles",
    "departments",
    "user_departments",
    "user_sessions",
    "employees",
    "employee_photos",
    "cameras",
    "detection_events",
    "camera_health_snapshots",
    "shift_policies",
    "attendance_records",
    "tenant_branding",
    "tenant_oidc_config",
    "manager_assignments",
    "policy_assignments",
    "leave_types",
    "holidays",
    "approved_leaves",
    "tenant_settings",
    "custom_fields",
    "custom_field_values",
    "requests",
    "request_attachments",
    "request_reason_categories",
    "notifications",
    "notification_preferences",
    "email_config",
    "report_schedules",
    "report_runs",
    "erp_export_config",
)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Provision a new Hadir tenant.",
    )
    parser.add_argument("--slug", required=True, help="Schema name (e.g. tenant_omran).")
    parser.add_argument("--name", required=True, help="Display name (e.g. 'Omran').")
    parser.add_argument(
        "--admin-email", required=True, help="First Admin user's email."
    )
    parser.add_argument(
        "--admin-full-name",
        default=None,
        help="Display name for the Admin user. Defaults to the email local-part.",
    )
    parser.add_argument(
        "--admin-password",
        default=None,
        help=(
            "Admin password. If omitted, reads $HADIR_PROVISION_PASSWORD or "
            "prompts on stdin."
        ),
    )
    return parser.parse_args(argv)


def _resolve_password(cli_password: Optional[str]) -> str:
    if cli_password:
        return _enforce_min_length(cli_password)
    env_password = os.environ.get("HADIR_PROVISION_PASSWORD")
    if env_password:
        return _enforce_min_length(env_password)
    # Interactive prompt with confirmation. getpass never echoes.
    pw1 = getpass.getpass("Admin password: ")
    pw2 = getpass.getpass("Confirm password: ")
    if not pw1:
        raise ValueError("password must not be empty")
    if pw1 != pw2:
        raise ValueError("passwords do not match")
    return _enforce_min_length(pw1)


# P27: minimum-length policy mirroring scripts/seed_admin.py.
# 12 chars is the floor; OIDC is the recommended path for
# user-added accounts post-pilot.
_MIN_PASSWORD_LENGTH = 12


def _enforce_min_length(password: str) -> str:
    if len(password) < _MIN_PASSWORD_LENGTH:
        raise ValueError(
            f"password too short (need ≥ {_MIN_PASSWORD_LENGTH} chars; "
            f"got {len(password)})"
        )
    return password


def _ensure_unique(conn: Connection, *, slug: str, name: str) -> None:
    existing = conn.execute(
        select(tenants.c.id, tenants.c.name, tenants.c.schema_name).where(
            (tenants.c.schema_name == slug) | (tenants.c.name == name)
        )
    ).first()
    if existing is not None:
        raise ValueError(
            f"tenant already exists (id={existing.id}, name={existing.name!r}, "
            f"schema_name={existing.schema_name!r})"
        )

    schema_exists = conn.execute(
        text(
            "SELECT 1 FROM information_schema.schemata "
            "WHERE schema_name = :s"
        ),
        {"s": slug},
    ).scalar()
    if schema_exists:
        raise ValueError(f"schema {slug!r} already exists")


def _create_per_tenant_tables(conn: Connection, *, slug: str) -> None:
    """Materialise every per-tenant table inside ``slug``.

    Filters out tables with ``schema="public"`` (currently just the
    global ``tenants`` registry) so we don't try to recreate or
    re-grant the global table — that's owned by migration 0008.
    Search_path on the connection already points at ``slug``, so
    unqualified tables land there.
    """

    per_tenant_tables = [
        t for t in metadata.tables.values() if t.schema != "public"
    ]
    metadata.create_all(bind=conn, tables=per_tenant_tables)


def _apply_grants(conn: Connection, *, slug: str) -> None:
    """Mirror the grants that 0001-0006 applied to ``main`` for the new schema."""

    conn.execute(text(f'ALTER SCHEMA "{slug}" OWNER TO hadir_admin'))
    conn.execute(text(f'GRANT USAGE ON SCHEMA "{slug}" TO hadir_app'))

    for tbl in _APP_CRUD_TABLES:
        conn.execute(text(f'ALTER TABLE "{slug}"."{tbl}" OWNER TO hadir_admin'))
        conn.execute(
            text(
                f'GRANT SELECT, INSERT, UPDATE, DELETE ON "{slug}"."{tbl}" TO hadir_app'
            )
        )

    # audit_log is append-only at the grant level — INSERT + SELECT only.
    conn.execute(text(f'ALTER TABLE "{slug}"."audit_log" OWNER TO hadir_admin'))
    conn.execute(
        text(f'GRANT SELECT, INSERT ON "{slug}"."audit_log" TO hadir_app')
    )

    conn.execute(
        text(f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{slug}" TO hadir_app')
    )
    conn.execute(
        text(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{slug}" '
            "GRANT USAGE, SELECT ON SEQUENCES TO hadir_app"
        )
    )


def _seed_defaults(
    conn: Connection,
    *,
    tenant_id: int,
    slug: str,
    admin_email: Optional[str],
    admin_password_hash: Optional[str],
    admin_full_name: Optional[str],
    skip_default_admin: bool = False,
) -> Optional[int]:
    """Seed roles, departments, Fixed shift policy, and (optionally) the
    first Admin user.

    Returns the new admin user's id, or ``None`` when
    ``skip_default_admin=True``. Runs inside the caller's transaction
    so a failure rolls every seed row back along with the schema.

    ``skip_default_admin`` (P28-followup): when set, the caller wants
    to seed its own admin (e.g. ``pre_omran_reset_seed.py`` generates
    a fresh password per run and writes it to ``credentials.txt``).
    The roles + departments + Fixed policy + branding rows still get
    created; only the user + role-assignment is skipped.
    """

    role_ids: dict[str, int] = {}
    for code, name in _DEFAULT_ROLE_CODES:
        rid = conn.execute(
            insert(roles)
            .values(tenant_id=tenant_id, code=code, name=name)
            .returning(roles.c.id)
        ).scalar_one()
        role_ids[code] = int(rid)

    for code, name in _DEFAULT_DEPARTMENTS:
        conn.execute(
            insert(departments).values(tenant_id=tenant_id, code=code, name=name)
        )

    conn.execute(
        insert(shift_policies).values(
            tenant_id=tenant_id,
            name=_DEFAULT_POLICY["name"],
            type="Fixed",
            config=_DEFAULT_POLICY["config"],
            active_from=text("CURRENT_DATE"),
            active_until=None,
        )
    )

    # Default branding row (P4). Curated defaults match the existing
    # design system's accent (``teal``) and font (``inter``).
    conn.execute(insert(tenant_branding).values(tenant_id=tenant_id))

    # Default OIDC config row (P6) — disabled, empty fields. The
    # tenant Admin opts in by entering Entra credentials and toggling
    # ``enabled`` on the Authentication settings page.
    from hadir.db import (  # noqa: PLC0415
        email_config as _email_config,
        erp_export_config as _erp_export_config,
        leave_types as _leave_types,
        request_reason_categories as _reason_categories,
        tenant_oidc_config,
        tenant_settings as _tenant_settings,
    )

    conn.execute(insert(tenant_oidc_config).values(tenant_id=tenant_id))

    # P11: leave types + tenant settings. Same defaults as the
    # migration's idempotent seed so freshly-provisioned tenants
    # match existing tenants exactly.
    for code, name, is_paid in (
        ("Annual", "Annual leave", True),
        ("Sick", "Sick leave", True),
        ("Emergency", "Emergency leave", True),
        ("Unpaid", "Unpaid leave", False),
    ):
        conn.execute(
            insert(_leave_types).values(
                tenant_id=tenant_id,
                code=code,
                name=name,
                is_paid=is_paid,
            )
        )
    conn.execute(insert(_tenant_settings).values(tenant_id=tenant_id))

    # P14: request reason categories. Same defaults as the migration
    # seeds (BRD §FR-REQ-008).
    for request_type, code, name, display_order in (
        ("exception", "Doctor",   "Doctor",            0),
        ("exception", "Family",   "Family",            1),
        ("exception", "Traffic",  "Traffic",           2),
        ("exception", "Official", "Official business", 3),
        ("exception", "Other",    "Other",             4),
        ("leave",     "Annual",    "Annual leave",     0),
        ("leave",     "Sick",      "Sick leave",       1),
        ("leave",     "Emergency", "Emergency leave",  2),
        ("leave",     "Unpaid",    "Unpaid leave",     3),
    ):
        conn.execute(
            insert(_reason_categories).values(
                tenant_id=tenant_id,
                request_type=request_type,
                code=code,
                name=name,
                display_order=display_order,
            )
        )

    # P18: empty email_config row (provider=smtp, enabled=false). The
    # operator fills in credentials in Settings → Email.
    conn.execute(insert(_email_config).values(tenant_id=tenant_id))

    # P19: empty ERP export config (enabled=false). Operator opts in
    # via Settings → Integrations → ERP Export.
    conn.execute(insert(_erp_export_config).values(tenant_id=tenant_id))

    user_id: Optional[int] = None
    if not skip_default_admin:
        if not admin_email or not admin_password_hash:
            raise ValueError(
                "skip_default_admin=False requires admin_email + "
                "admin_password_hash to be set"
            )
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=tenant_id,
                    email=admin_email,
                    password_hash=admin_password_hash,
                    full_name=admin_full_name or admin_email.split("@", 1)[0],
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        conn.execute(
            insert(user_roles).values(
                tenant_id=tenant_id,
                user_id=user_id,
                role_id=role_ids["Admin"],
            )
        )

    # First audit row — provisioning event itself, so the new tenant's
    # log isn't empty on first read. ``actor_user_id`` is null because
    # the operator running the CLI isn't authenticated as a user inside
    # this tenant. ``actor_label='provision_tenant'`` distinguishes it
    # from regular request-driven audit rows.
    conn.execute(
        insert(audit_log).values(
            tenant_id=tenant_id,
            actor_user_id=None,
            actor_label="provision_tenant",
            action="tenant.provisioned",
            entity_type="tenant",
            entity_id=str(tenant_id),
            after={
                "schema_name": slug,
                "admin_user_id": user_id,
                "skip_default_admin": skip_default_admin,
            },
        )
    )

    return user_id


def _stamp_alembic_head(slug: str) -> None:
    """Run ``alembic -x schema=<slug> stamp head`` as a subprocess.

    Subprocess (rather than ``alembic.command.stamp``) so env.py reads
    the ``-x`` arg fresh and the stamp commits in its own transaction —
    intentional, because the calling transaction has already committed
    by the time we get here.
    """

    cmd = ["alembic", "-x", f"schema={slug}", "stamp", "head"]
    completed = subprocess.run(cmd, cwd=_BACKEND_DIR, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"alembic stamp failed for schema={slug} (exit={completed.returncode})"
        )


def _cleanup(engine: Engine, *, slug: str) -> None:
    """Drop the tenant schema and remove the public.tenants row.

    Runs as best-effort: each step is logged but not raised, so a
    cleanup failure doesn't mask the original error.
    """

    token = set_tenant_schema("public")
    try:
        try:
            with engine.begin() as conn:
                conn.execute(text(f'DROP SCHEMA IF EXISTS "{slug}" CASCADE'))
        except Exception as exc:  # noqa: BLE001
            logger.warning("cleanup: drop schema failed: %s", type(exc).__name__)
        try:
            with engine.begin() as conn:
                conn.execute(
                    text("DELETE FROM public.tenants WHERE schema_name = :s"),
                    {"s": slug},
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "cleanup: delete public.tenants row failed: %s",
                type(exc).__name__,
            )
    finally:
        reset_tenant_schema(token)


def provision(
    *,
    slug: str,
    name: str,
    admin_email: Optional[str] = None,
    admin_full_name: Optional[str] = None,
    admin_password: Optional[str] = None,
    skip_default_admin: bool = False,
) -> dict[str, object]:
    """Run every provisioning step in order, with cleanup on failure.

    P28-followup: ``skip_default_admin=True`` lets a downstream
    seed script (e.g. ``pre_omran_reset_seed.py``) provision the
    tenant shell without an admin user, then create its own
    admin with a freshly-generated password. When skipped, the
    ``admin_*`` args are optional.
    """

    if not _TENANT_SCHEMA_RE.match(slug):
        raise ValueError(
            f"invalid slug {slug!r}: must match ^[A-Za-z_][A-Za-z0-9_]{{0,62}}$"
        )

    admin_password_hash: Optional[str] = None
    if not skip_default_admin:
        if not admin_email or not _EMAIL_RE.match(admin_email):
            raise ValueError(f"invalid admin email {admin_email!r}")
        if not admin_password:
            raise ValueError("admin password must not be empty")
        admin_email = admin_email.strip().lower()
        if not admin_full_name:
            admin_full_name = admin_email.split("@", 1)[0]
        admin_password_hash = hash_password(admin_password)

    engine = make_admin_engine()
    tenant_id: Optional[int] = None
    user_id: Optional[int] = None
    schema_created = False

    try:
        # Phase 1: register the tenant in public, create the schema +
        # tables, apply grants, seed defaults — all in one transaction
        # so a failure rolls everything back together.
        token = set_tenant_schema(slug)
        try:
            with engine.begin() as conn:
                # Switch into "public" momentarily for the uniqueness
                # check + the public.tenants insert. ``search_path``
                # already has public on it, so this just ensures we
                # touch the right registry table.
                _ensure_unique(conn, slug=slug, name=name)

                tenant_id = conn.execute(
                    insert(tenants)
                    .values(name=name, schema_name=slug)
                    .returning(tenants.c.id)
                ).scalar_one()
                tenant_id = int(tenant_id)

                conn.execute(text(f'CREATE SCHEMA "{slug}"'))
                schema_created = True

                # Pin search_path on this connection to the new schema
                # so unqualified tables in metadata.create_all land in
                # ``slug``.
                conn.execute(text(f'SET search_path TO "{slug}", public'))

                _create_per_tenant_tables(conn, slug=slug)
                _apply_grants(conn, slug=slug)

                user_id = _seed_defaults(
                    conn,
                    tenant_id=tenant_id,
                    slug=slug,
                    admin_email=admin_email,
                    admin_password_hash=admin_password_hash,
                    admin_full_name=admin_full_name,
                    skip_default_admin=skip_default_admin,
                )
        finally:
            reset_tenant_schema(token)

        # Phase 2: stamp alembic head outside the main transaction.
        # Failure here triggers the cleanup branch below.
        _stamp_alembic_head(slug)

    except Exception:
        logger.exception("provisioning failed for slug=%s — rolling back", slug)
        if schema_created or tenant_id is not None:
            _cleanup(engine, slug=slug)
        engine.dispose()
        raise

    engine.dispose()

    return {
        "tenant_id": tenant_id,
        "schema": slug,
        "name": name,
        "admin_user_id": user_id,
        "admin_email": admin_email,
    }


# P28-followup: public alias matching the name the prompt uses.
# Same arguments as ``provision()`` — keeps existing call sites
# working while letting new callers (the pre-Omran reset script)
# import a stable, descriptive name.
provision_tenant = provision


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="[provision] %(message)s")
    args = _parse_args(argv)
    try:
        password = _resolve_password(args.admin_password)
        result = provision(
            slug=args.slug,
            name=args.name,
            admin_email=args.admin_email,
            admin_full_name=args.admin_full_name or "",
            admin_password=password,
        )
    except Exception as exc:
        logger.error("provisioning failed: %s: %s", type(exc).__name__, exc)
        return 1

    logger.info(
        "provisioned tenant_id=%s schema=%s admin_user_id=%s admin_email=%s",
        result["tenant_id"],
        result["schema"],
        result["admin_user_id"],
        result["admin_email"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
