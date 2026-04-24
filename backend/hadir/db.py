"""SQLAlchemy engine, session factory, and schema metadata.

P2 introduces the initial tables in the ``main`` Postgres schema. SQLAlchemy
Core is used (not the ORM) because most of the codebase is already built
around explicit queries — easier to reason about, easier to audit for the
tenant-scope filter.

Two engines are exposed:

* ``engine`` — connects as ``hadir_app`` and is used by request handlers.
  This role has restricted grants on ``audit_log`` (INSERT + SELECT only);
  every other operation against the audit log is rejected by Postgres.
* ``admin_engine`` — connects as ``hadir_admin`` and is used by Alembic and
  the seed scripts. Do not use this at request time.

See ``backend/CLAUDE.md`` for the full role/grants matrix.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Engine,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    func,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB

from hadir.config import get_settings

# All application tables live under the ``main`` schema. In multi-tenant mode
# (v1.0) additional schemas named after each tenant will be cut from the same
# metadata — the schema label here becomes the default, not a hard-coded
# value.
SCHEMA = "main"

metadata = MetaData(schema=SCHEMA)


# --- Tables -----------------------------------------------------------------
# Every tenant-scoped table carries ``tenant_id`` with a FK to ``tenants(id)``.
# Never query these tables without filtering on ``tenant_id`` — use the
# ``TenantScope`` dependency (``hadir.tenants.scope``) to thread the value
# through repositories.

tenants = Table(
    "tenants",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", Text, nullable=False, unique=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
)


users = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    # CITEXT makes email comparisons case-insensitive at the database layer.
    # Per PROJECT_CONTEXT §3 "User match by email, case-insensitive".
    Column("email", CITEXT, nullable=False),
    Column("password_hash", Text, nullable=False),
    Column("full_name", Text, nullable=False),
    Column("is_active", Boolean, nullable=False, server_default="true"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint("tenant_id", "email", name="uq_users_tenant_email"),
)


roles = Table(
    "roles",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("code", Text, nullable=False),
    Column("name", Text, nullable=False),
    UniqueConstraint("tenant_id", "code", name="uq_roles_tenant_code"),
    CheckConstraint("code IN ('Admin','HR','Manager','Employee')", name="ck_roles_code"),
)


user_roles = Table(
    "user_roles",
    metadata,
    Column(
        "user_id",
        Integer,
        ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "role_id",
        Integer,
        ForeignKey(f"{SCHEMA}.roles.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        primary_key=True,
    ),
)


departments = Table(
    "departments",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("name", Text, nullable=False),
    Column("code", Text, nullable=False),
    UniqueConstraint("tenant_id", "code", name="uq_departments_tenant_code"),
)


user_departments = Table(
    "user_departments",
    metadata,
    Column(
        "user_id",
        Integer,
        ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "department_id",
        Integer,
        ForeignKey(f"{SCHEMA}.departments.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        primary_key=True,
    ),
)


user_sessions = Table(
    "user_sessions",
    metadata,
    # Session IDs are opaque random tokens (e.g. secrets.token_urlsafe(32))
    # — stored as TEXT rather than UUID so P3 can decide the token format
    # without a migration.
    Column("id", String(length=128), primary_key=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "user_id",
        Integer,
        ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column(
        "data",
        JSONB,
        nullable=False,
        server_default="{}",
    ),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "last_seen_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
)


# audit_log is append-only at the database grant level — ``hadir_app`` has
# INSERT + SELECT only. If any application code ever issues an UPDATE or
# DELETE against this table, Postgres will reject it.
audit_log = Table(
    "audit_log",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey(f"{SCHEMA}.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    # Nullable — system-originated events (e.g. scheduled capture cleanup)
    # have no human actor.
    Column(
        "actor_user_id",
        Integer,
        ForeignKey(f"{SCHEMA}.users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("action", Text, nullable=False),
    Column("entity_type", Text, nullable=False),
    # TEXT rather than INTEGER — different entities have different id shapes
    # (employees are int, sessions are strings, future records may be UUID).
    Column("entity_id", Text, nullable=True),
    Column("before", JSONB, nullable=True),
    Column("after", JSONB, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        index=True,
    ),
)


# --- Engines ----------------------------------------------------------------


def make_engine() -> Engine:
    """App-runtime engine.

    ``pool_pre_ping`` catches Postgres restarts (common in dev with
    ``docker compose down``) and recycles dead connections rather than
    letting them fail a request.
    """

    settings = get_settings()
    return create_engine(settings.database_url, pool_pre_ping=True, future=True)


def make_admin_engine() -> Engine:
    """Admin engine used by migrations and ``scripts/seed_admin.py``.

    Not for request-path use. The admin role bypasses the append-only
    constraint on ``audit_log`` and should never service user traffic.
    """

    settings = get_settings()
    return create_engine(settings.admin_database_url, pool_pre_ping=True, future=True)


# Process-wide runtime engine. Lazily created so tests that override the
# database URL before first access get a correctly-configured pool.
_engine: Engine | None = None


def get_engine() -> Engine:
    """Return the cached app-runtime engine, creating it on first call."""

    global _engine
    if _engine is None:
        _engine = make_engine()
    return _engine


def reset_engine() -> None:
    """Drop the cached engine. Test-only utility."""

    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None
