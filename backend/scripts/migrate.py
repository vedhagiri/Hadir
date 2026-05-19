"""Migration orchestrator: advance ``main`` then every tenant schema.

The container entrypoint invokes this script in place of a bare
``alembic upgrade head``. The pilot's ``main`` schema carries the
legacy 0001-0007 history plus the boundary migration 0008 (which moves
``tenants`` to ``public``). Once ``public.tenants`` exists, this script
iterates the registry and runs ``alembic upgrade head`` against each
non-``main`` tenant schema so future schema-agnostic migrations
(0009+) reach every tenant uniformly.

Order matters:

1. **main first.** A fresh DB has nothing in ``public`` yet — the
   migration that creates ``public.tenants`` is 0008, applied during
   ``main``'s upgrade. Iterating tenants before main would query a
   table that doesn't exist yet.
2. **Then iterate ``public.tenants``.** For each row whose
   ``schema_name`` differs from ``main``, run alembic against that
   schema. The bootstrap path (no rows other than the seeded pilot)
   is therefore a no-op past step 1.

Errors abort the whole run with a non-zero exit code so the container
fails to start rather than serving traffic against a partially-migrated
DB.

Usage:

    docker compose exec backend python -m scripts.migrate

The script is idempotent — safe to re-run on every container start.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

from sqlalchemy import text

from maugood.db import make_admin_engine, set_tenant_schema, reset_tenant_schema
from scripts._grants import sync_schema_grants
from scripts._schema_sync import sync_schema_structure

logger = logging.getLogger("maugood.migrate")
logging.basicConfig(level=logging.INFO, format="[migrate] %(message)s")


# Run alembic from the same directory the Dockerfile sets WORKDIR to so
# alembic.ini resolves without juggling --config flags.
_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _run_alembic_upgrade(schema: str) -> None:
    """Invoke ``alembic upgrade head -x schema=<schema>`` as a subprocess.

    Subprocess (rather than alembic.command.upgrade) so the env.py
    re-reads ``-x`` from a fresh CLI invocation each time and version
    state can't leak across runs. Also matches what an operator would
    type at the shell, which is what entrypoint.sh used to do directly.
    """

    cmd = [
        "alembic",
        "-x",
        f"schema={schema}",
        "upgrade",
        "head",
    ]
    logger.info("upgrading schema=%s", schema)
    completed = subprocess.run(
        cmd,
        cwd=_BACKEND_DIR,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"alembic upgrade failed for schema={schema} "
            f"(exit={completed.returncode})"
        )


def _sync_grants_for(schema: str) -> None:
    """Re-apply the ownership + grant contract after a migration.

    Forward migrations create new tables as whoever
    ``MAUGOOD_ADMIN_DATABASE_URL`` connects as (the bootstrap superuser).
    That leaves the tables owned by ``maugood`` with no grants for
    ``maugood_app`` — the request path then 500s with "permission denied".
    Running the grants sync after every upgrade closes the loop: any new
    table the migration created is automatically owned by
    ``maugood_admin`` and granted to ``maugood_app`` per the same
    contract ``provision_tenant`` applies.
    """

    token = set_tenant_schema(schema)
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                sync_schema_grants(conn, schema)
        finally:
            engine.dispose()
    finally:
        reset_tenant_schema(token)


def _sync_structure_for(schema: str) -> None:
    """Reconcile schema structure against ``maugood.db.metadata``.

    Defence-in-depth pass after every ``alembic upgrade``. Adds any
    column / CHECK / UNIQUE constraint / index that's declared in
    ``metadata`` but missing on disk — primarily the case for tenants
    provisioned via ``metadata.create_all`` + ``alembic stamp head``
    before a later forward ALTER migration shipped. Idempotent; safe
    to run on an already-aligned schema.
    """

    token = set_tenant_schema(schema)
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                sync_schema_structure(conn, schema)
        finally:
            engine.dispose()
    finally:
        reset_tenant_schema(token)


def _iter_tenant_schemas() -> list[str]:
    """Return every non-main tenant schema_name from the public registry.

    Connects via the admin engine because the orchestrator runs as
    ``maugood_admin`` (request-path role doesn't exist yet at first
    boot). Single-tenant deployments return an empty list and the
    caller skips the loop.
    """

    # Use the admin engine without the tenant-scope checkout listener
    # interfering: set the contextvar to ``public`` so the listener
    # (which insists on a schema in multi mode) puts ``public`` on the
    # path, which is where the registry lives anyway.
    token = set_tenant_schema("public")
    try:
        engine = make_admin_engine()
        try:
            with engine.begin() as conn:
                # The very first boot runs this BEFORE 0008 has applied,
                # so public.tenants doesn't exist yet — return [] and
                # let the orchestrator skip the iteration.
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
                        "SELECT schema_name FROM public.tenants "
                        "WHERE schema_name <> 'main' "
                        "ORDER BY id"
                    )
                ).all()
                return [str(r.schema_name) for r in rows]
        finally:
            engine.dispose()
    finally:
        reset_tenant_schema(token)


def main() -> int:
    # 1. Bring main forward (legacy pilot history + 0008 boundary).
    _run_alembic_upgrade("main")
    _sync_structure_for("main")
    _sync_grants_for("main")

    # 2. Iterate every other tenant and bring it to head, then reconcile
    #    structure + grants for any tables the migration created. New
    #    tenants provisioned via scripts.provision_tenant arrive here
    #    already stamped at head, so the upgrade step is usually a
    #    no-op for them — but the structure + grants syncs still run
    #    (idempotent) so any drift from older builds gets healed on
    #    the next container boot.
    for schema in _iter_tenant_schemas():
        _run_alembic_upgrade(schema)
        _sync_structure_for(schema)
        _sync_grants_for(schema)

    logger.info("all schemas at head; structure + grants reconciled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
