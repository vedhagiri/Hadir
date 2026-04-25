"""Alembic environment for Hadir.

Runs migrations as the admin role (``hadir_admin``) because migrations
own DDL and grant decisions that ``hadir_app`` is not allowed to make.

Per-schema migration model (v1.0 P2):

* The version table lives in the schema being migrated, not in
  ``public.alembic_version``. Pass ``-x schema=<name>`` on the alembic
  command line to pick the target. The orchestrator
  (``scripts.migrate``) iterates ``public.tenants`` and runs alembic
  once per tenant schema, plus once for ``main`` to carry the pilot
  history forward.
* When invoked without ``-x schema=…``, defaults to ``main`` to
  preserve the pilot's bootstrap behaviour: a fresh DB still ends up
  with ``main.alembic_version`` at head after a single
  ``alembic upgrade head`` run.
* Sets ``search_path`` to the active schema (with ``public`` on the
  path so the citext extension type and the global ``tenants``
  registry both resolve).

Why per-schema rather than the pilot's single ``main.alembic_version``:
each tenant gets its own migration cursor so a future schema-agnostic
migration (0009+) can be applied independently to each tenant. The
public registry only ever holds the ``tenants`` table itself — public
is **not** an alembic target.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from hadir.config import get_settings
from hadir.db import metadata, metadata_global

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Inject the admin URL from the environment rather than alembic.ini so the
# repo has no hard-coded credentials.
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.admin_database_url)


def _target_schema() -> str:
    """Resolve the schema this alembic invocation should migrate.

    Order:
      1. ``-x schema=<name>`` on the command line.
      2. Default to ``main`` for backwards-compatible bootstrap.
    """

    x_args = context.get_x_argument(as_dictionary=True)
    schema = x_args.get("schema")
    if schema:
        return str(schema)
    return "main"


# Combine per-tenant + global metadata for autogenerate. In normal
# upgrades this is unused (we run pre-written revisions), but keeping
# both registered means ``alembic revision --autogenerate`` from a
# tenant-scoped run sees both sets and won't try to re-create the
# global ``tenants`` table inside a tenant schema.
target_metadata = [metadata, metadata_global]


def _configure_context(connection: object | None = None, url: str | None = None) -> None:
    schema = _target_schema()
    context.configure(
        connection=connection,  # type: ignore[arg-type]
        url=url,
        target_metadata=target_metadata,
        version_table="alembic_version",
        version_table_schema=schema,
        include_schemas=True,
        compare_type=True,
        compare_server_default=True,
    )


def run_migrations_offline() -> None:
    _configure_context(url=config.get_main_option("sqlalchemy.url"))
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    schema = _target_schema()
    with connectable.connect() as connection:
        # Make sure the schema exists before we try to write its
        # ``alembic_version`` row. Idempotent on re-runs.
        connection.exec_driver_sql(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        # search_path keeps unqualified table references in the
        # migration files resolving against the active schema. ``public``
        # stays on the path so the global ``tenants`` table and the
        # citext type continue to resolve.
        connection.exec_driver_sql(f'SET search_path TO "{schema}", public')
        connection.commit()

        _configure_context(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
