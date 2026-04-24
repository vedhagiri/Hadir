"""SQLAlchemy engine and session factory.

P1 only wires the engine — there are no tables yet. P2 adds Alembic, the
`main` schema, and the initial migration. We keep this module here so future
sessions have an obvious place to extend.
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine

from hadir.config import get_settings


def make_engine() -> Engine:
    """Build the SQLAlchemy engine from settings.

    `future=True` is the default in SQLAlchemy 2.x; we set `pool_pre_ping=True`
    so dropped Postgres connections (common in dev with `docker compose down`)
    are detected and recycled rather than blowing up the next request.
    """

    settings = get_settings()
    return create_engine(settings.database_url, pool_pre_ping=True)
