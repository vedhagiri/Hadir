"""Alembic environment for Hadir.

Runs migrations as the admin role (``hadir_admin``) because migrations
create the ``main`` schema, the ``citext`` extension, the two DB roles, and
the tables. The application never uses this connection at runtime.

Version tracking lives in ``main.alembic_version`` rather than the default
``public.alembic_version`` so migration state follows the tenant-neutral
schema, not ``public``.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from hadir.config import get_settings
from hadir.db import SCHEMA, metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Inject the admin URL from the environment rather than alembic.ini so the
# repo has no hard-coded credentials.
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.admin_database_url)

target_metadata = metadata


def _configure_context(connection: object | None = None, url: str | None = None) -> None:
    context.configure(
        connection=connection,  # type: ignore[arg-type]
        url=url,
        target_metadata=target_metadata,
        version_table="alembic_version",
        version_table_schema=SCHEMA,
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
    with connectable.connect() as connection:
        # The ``main`` schema is created by the initial migration itself, so
        # we can't rely on it existing when the version table is first
        # written. Create it here if missing.
        connection.exec_driver_sql(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"')
        connection.commit()

        _configure_context(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
