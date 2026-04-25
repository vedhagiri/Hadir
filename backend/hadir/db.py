"""SQLAlchemy engine, session factory, and schema metadata.

Pilot used a single Postgres schema (``main``) baked into the metadata.
v1.0 P1 generalises this: ``MetaData()`` carries no schema, every Table
is unqualified, and the active schema is selected per-connection via
``SET search_path``. A SQLAlchemy ``checkout`` event reads the
``_tenant_schema_var`` ContextVar and applies it to each pooled
connection at borrow time.

Behaviour by ``HADIR_TENANT_MODE``:

* ``single`` — pilot mode. If no tenant context is set, the checkout
  defaults the search_path to ``main`` so existing pilot code paths
  (seed_admin, capture workers, scheduler, tests) keep working.
* ``multi`` — v1.0 mode. Refuses to issue queries unless a tenant
  context is set explicitly. This is the **fail-closed** red line:
  a code path that reaches the DB without resolving a tenant raises
  before any SQL leaves the process.

SQLAlchemy Core (not the ORM) — same reasoning as in pilot.

Two engines:

* ``make_engine()`` — connects as ``hadir_app`` (request path).
  Restricted grants on ``audit_log`` (INSERT + SELECT only).
* ``make_admin_engine()`` — connects as the DB owner (migrations,
  seed scripts). Do not use at request time.

See ``backend/CLAUDE.md`` for the full role/grants matrix and the
documented approach (events vs DI) chosen for P1.
"""

from __future__ import annotations

import contextvars
import logging
import re
from contextlib import contextmanager
from typing import Iterator, Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Engine,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    Text,
    Time,
    UniqueConstraint,
    create_engine,
    event,
    func,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB

from hadir.config import get_settings

logger = logging.getLogger(__name__)

# Default schema used in single-tenant mode and as the conventional name
# for the pilot tenant in multi-tenant mode (the existing Omran data
# stays in ``main``; new tenants get ``tenant_<slug>`` schemas).
SCHEMA = "main"
DEFAULT_SCHEMA = SCHEMA

# ---------------------------------------------------------------------------
# Tenant routing — contextvar + connection-checkout search_path
# ---------------------------------------------------------------------------
# Postgres schema identifiers must match a defensive whitelist before we
# ever interpolate them into a SET statement. Schemas are sourced from
# ``tenants.schema_name`` (which we'll constrain in P2's provisioning
# CLI) and from server-side fixtures, never user input — but defence in
# depth here keeps us safe if either of those constraints slips later.
_TENANT_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")

_tenant_schema_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "hadir_tenant_schema", default=None
)


def set_tenant_schema(schema: Optional[str]) -> contextvars.Token:
    """Set the active tenant schema for this context. Returns a reset token."""

    if schema is not None and not _TENANT_SCHEMA_RE.match(schema):
        raise ValueError(f"invalid tenant schema name: {schema!r}")
    return _tenant_schema_var.set(schema)


def get_tenant_schema() -> Optional[str]:
    return _tenant_schema_var.get()


def reset_tenant_schema(token: contextvars.Token) -> None:
    _tenant_schema_var.reset(token)


@contextmanager
def tenant_context(schema: Optional[str]) -> Iterator[None]:
    """Run a block with ``schema`` as the active tenant schema.

    Used by background workers, schedulers, and the lifespan startup
    routines that touch the DB outside an HTTP request scope. The
    ``TenantScopeMiddleware`` does the same for the request path.
    """

    token = set_tenant_schema(schema)
    try:
        yield
    finally:
        reset_tenant_schema(token)


def _resolve_active_schema() -> str:
    """Return the schema to apply on the next connection checkout.

    Single mode falls back to ``main`` when no context is set; multi
    mode refuses (fail-closed). This is enforced at the *connection
    checkout* boundary so a forgotten ``with tenant_context(...):``
    surfaces immediately, not as a silent cross-tenant read.
    """

    schema = _tenant_schema_var.get()
    if schema is not None:
        return schema
    settings = get_settings()
    if settings.tenant_mode == "single":
        return DEFAULT_SCHEMA
    raise RuntimeError(
        "no tenant schema in scope — refusing to issue queries "
        "(HADIR_TENANT_MODE=multi). Wrap the code path in "
        "hadir.db.tenant_context(schema=...) or attach the request "
        "to a session."
    )


def _attach_search_path_listener(engine: Engine) -> None:
    """Install the per-checkout ``SET search_path`` event handler."""

    @event.listens_for(engine, "checkout")
    def _on_checkout(dbapi_conn, _conn_record, _conn_proxy):  # type: ignore[no-untyped-def]
        schema = _resolve_active_schema()
        # Validated again here in case a non-matching value slipped past
        # ``set_tenant_schema``.
        if not _TENANT_SCHEMA_RE.match(schema):
            raise RuntimeError(f"unsafe tenant schema {schema!r}")
        cur = dbapi_conn.cursor()
        try:
            # ``public`` stays on the path so extension types (citext,
            # functions installed in public) keep resolving.
            cur.execute(f'SET search_path TO "{schema}", public')
        finally:
            cur.close()


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------
# A single ``MetaData`` carries both the tenant-scoped tables (no schema
# qualifier — placed by ``SET search_path``) and the globally-visible
# ``tenants`` table (``schema="public"`` baked in on the Table itself).
# Keeping them in one metadata lets SQLAlchemy resolve cross-schema
# foreign keys (per-tenant tables → ``public.tenants``) at table-build
# time. The provisioning CLI calls ``create_all(tables=…)`` with the
# global tables filtered out so it only materialises the per-tenant
# set inside a fresh tenant schema.

metadata = MetaData()
# Used by ``alembic env.py`` to keep autogenerate aware of the global
# slot when running against the public schema. Same object as
# ``metadata`` — the alias just documents intent at the call site.
metadata_global = metadata


# --- Tables -----------------------------------------------------------------
# Every tenant-scoped table carries ``tenant_id`` with a FK to ``tenants(id)``.
# Never query these tables without filtering on ``tenant_id`` — use the
# ``TenantScope`` dependency (``hadir.tenants.scope``) to thread the value
# through repositories.

# P2: tenants is the single globally-visible table — lives in ``public``
# so it sits outside any tenant's schema and the orchestrator can iterate
# it to discover which tenant schemas to migrate. ``schema="public"`` is
# baked into the Table itself so the per-tenant ``create_all`` path can
# filter it out by inspecting ``Table.schema``.
tenants = Table(
    "tenants",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", Text, nullable=False, unique=True),
    # Postgres schema this tenant's data lives in. Pilot tenant uses
    # ``main`` for backward compat; v1.0 provisioning creates
    # ``tenant_<slug>`` schemas. Constrained server-side via the regex
    # in migration 0007 to match ``_TENANT_SCHEMA_RE`` above.
    Column("schema_name", Text, nullable=False, server_default="main", unique=True),
    # P3: ``active`` or ``suspended``. Login and the request middleware
    # refuse a suspended tenant; the Super-Admin console can flip the
    # state (which is itself audit-logged in both places).
    Column("status", Text, nullable=False, server_default="active"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint("status IN ('active','suspended')", name="ck_tenants_status"),
    schema="public",
)


# --- Per-tenant branding (P4) ----------------------------------------------
# One row per tenant. ``primary_color_key`` and ``font_key`` are both
# constrained server-side via CHECK to the curated lists in
# ``hadir/branding/constants.py`` — there is no free-form hex entry and
# no custom font upload (BRD FR-BRD-002 red line).

tenant_branding = Table(
    "tenant_branding",
    metadata,
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("primary_color_key", Text, nullable=False, server_default="teal"),
    Column("logo_path", Text, nullable=True),
    Column("font_key", Text, nullable=False, server_default="inter"),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "primary_color_key IN ("
        "'teal','navy','slate','forest','plum','clay','rose','amber'"
        ")",
        name="ck_tenant_branding_primary_color_key",
    ),
    CheckConstraint(
        "font_key IN ('inter','lato','plus-jakarta-sans')",
        name="ck_tenant_branding_font_key",
    ),
)


# --- Policy assignments (P9) -----------------------------------------------
# Maps a ``shift_policies`` row to a resolution scope (tenant /
# department / employee). The engine's resolver walks
# ``employee > department > tenant > legacy fallback`` to pick the
# active policy per (employee, date).

policy_assignments = Table(
    "policy_assignments",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "policy_id",
        Integer,
        ForeignKey("shift_policies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("scope_type", Text, nullable=False),
    Column("scope_id", Integer, nullable=True),
    Column("active_from", Date, nullable=False),
    Column("active_until", Date, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "scope_type IN ('tenant','department','employee')",
        name="ck_policy_assignments_scope_type",
    ),
    CheckConstraint(
        "(scope_type = 'tenant' AND scope_id IS NULL) "
        "OR (scope_type IN ('department','employee') AND scope_id IS NOT NULL)",
        name="ck_policy_assignments_scope_id_coherent",
    ),
)


# --- Manager assignments (P8) ----------------------------------------------
# Many-to-many between Manager users and employees. Up to one
# ``is_primary=true`` row per (tenant_id, employee_id) — enforced at
# the DB level via the partial unique index in migration 0012.

manager_assignments = Table(
    "manager_assignments",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "manager_user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("is_primary", Boolean, nullable=False, server_default="false"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id",
        "employee_id",
        "manager_user_id",
        name="uq_manager_assignments_tenant_employee_manager",
    ),
)


# --- Leaves + holidays + tenant settings (P11) ----------------------------

leave_types = Table(
    "leave_types",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("code", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("is_paid", Boolean, nullable=False, server_default="true"),
    Column("active", Boolean, nullable=False, server_default="true"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id", "code", name="uq_leave_types_tenant_code"
    ),
)


holidays = Table(
    "holidays",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("date", Date, nullable=False),
    Column("name", Text, nullable=False),
    Column("active", Boolean, nullable=False, server_default="true"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id", "date", name="uq_holidays_tenant_date"
    ),
)


approved_leaves = Table(
    "approved_leaves",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "leave_type_id",
        Integer,
        ForeignKey("leave_types.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("start_date", Date, nullable=False),
    Column("end_date", Date, nullable=False),
    Column("notes", Text, nullable=True),
    Column(
        "approved_by_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column(
        "approved_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "start_date <= end_date",
        name="ck_approved_leaves_date_range",
    ),
    Index(
        "ix_approved_leaves_tenant_employee_dates",
        "tenant_id",
        "employee_id",
        "start_date",
        "end_date",
    ),
)


# Per-tenant settings — ``weekend_days`` (JSONB list of weekday names
# matching ``date.strftime("%A")``) + ``timezone`` (IANA name). Per
# the P11 red line, **timezone is tenant-scoped, not server-scoped**.
tenant_settings = Table(
    "tenant_settings",
    metadata,
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "weekend_days",
        JSONB,
        nullable=False,
        server_default='["Friday", "Saturday"]',
    ),
    Column(
        "timezone",
        Text,
        nullable=False,
        server_default="Asia/Muscat",
    ),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
)


# --- Requests (P13) --------------------------------------------------------
# Exception + leave requests submitted by employees and walked through the
# state machine (submitted → manager_{approved,rejected} →
# hr_{approved,rejected} → admin_{approved,rejected} | cancelled).
# State transitions are enforced in application code; the CHECK on
# ``status`` is defence-in-depth.

requests = Table(
    "requests",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("type", Text, nullable=False),
    Column("reason_category", Text, nullable=False),
    Column("reason_text", Text, nullable=False, server_default=""),
    Column("target_date_start", Date, nullable=False),
    Column("target_date_end", Date, nullable=True),
    Column(
        "leave_type_id",
        Integer,
        ForeignKey("leave_types.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("status", Text, nullable=False, server_default="submitted"),
    Column(
        "manager_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("manager_decision_at", DateTime(timezone=True), nullable=True),
    Column("manager_comment", Text, nullable=True),
    Column(
        "hr_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("hr_decision_at", DateTime(timezone=True), nullable=True),
    Column("hr_comment", Text, nullable=True),
    Column(
        "admin_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("admin_decision_at", DateTime(timezone=True), nullable=True),
    Column("admin_comment", Text, nullable=True),
    Column(
        "submitted_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint("type IN ('exception','leave')", name="ck_requests_type"),
    CheckConstraint(
        "status IN ("
        "'submitted','manager_approved','manager_rejected',"
        "'hr_approved','hr_rejected',"
        "'admin_approved','admin_rejected','cancelled'"
        ")",
        name="ck_requests_status",
    ),
    CheckConstraint(
        "target_date_end IS NULL OR target_date_end >= target_date_start",
        name="ck_requests_date_range",
    ),
    CheckConstraint(
        "(type = 'leave' AND leave_type_id IS NOT NULL) "
        "OR (type = 'exception' AND leave_type_id IS NULL)",
        name="ck_requests_leave_type_consistency",
    ),
    Index("ix_requests_tenant_status", "tenant_id", "status"),
    Index(
        "ix_requests_tenant_employee_status",
        "tenant_id",
        "employee_id",
        "status",
    ),
    Index(
        "ix_requests_tenant_manager_status",
        "tenant_id",
        "manager_user_id",
        "status",
    ),
)


request_attachments = Table(
    "request_attachments",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "request_id",
        Integer,
        ForeignKey("requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("file_path", Text, nullable=False),
    Column("original_filename", Text, nullable=False),
    Column("content_type", Text, nullable=False, server_default=""),
    Column("size_bytes", Integer, nullable=False, server_default="0"),
    Column(
        "uploaded_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
)


# --- Custom fields (P12) ---------------------------------------------------
# Admin-defined extra columns for the employee record. Field definitions
# live in ``custom_fields``; per-employee values live in
# ``custom_field_values`` as text (typed on read). Storing values in a
# separate table — never as free-form JSON on ``employees`` — is the P12
# red line: the value table is the single source of truth, and a
# field-rename / field-delete is a focused mutation rather than a
# whole-employee patch.

custom_fields = Table(
    "custom_fields",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("name", Text, nullable=False),
    Column("code", Text, nullable=False),
    Column("type", Text, nullable=False),
    Column("options", JSONB, nullable=True),
    Column("required", Boolean, nullable=False, server_default="false"),
    Column("display_order", Integer, nullable=False, server_default="0"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id", "code", name="uq_custom_fields_tenant_code"
    ),
    CheckConstraint(
        "type IN ('text','number','date','select')",
        name="ck_custom_fields_type",
    ),
    CheckConstraint(
        "(type <> 'select') OR (options IS NOT NULL)",
        name="ck_custom_fields_select_options",
    ),
)


custom_field_values = Table(
    "custom_field_values",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "field_id",
        Integer,
        ForeignKey("custom_fields.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("value", Text, nullable=False, server_default=""),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id",
        "employee_id",
        "field_id",
        name="uq_custom_field_values_tenant_emp_field",
    ),
)


# --- Per-tenant OIDC config (P6) -------------------------------------------
# One row per tenant. ``client_secret_encrypted`` is Fernet-encrypted
# with ``HADIR_AUTH_FERNET_KEY`` (separate from the photo/RTSP key —
# blast-radius isolation is the point of the split). The plain secret
# never appears in the API surface, in audit rows, or in logs.

tenant_oidc_config = Table(
    "tenant_oidc_config",
    metadata,
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("entra_tenant_id", Text, nullable=False, server_default=""),
    Column("client_id", Text, nullable=False, server_default=""),
    Column("client_secret_encrypted", Text, nullable=True),
    Column("enabled", Boolean, nullable=False, server_default="false"),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
)


# --- Super-Admin global tables (P3) ----------------------------------------
# All three live in ``public`` alongside ``tenants``. They are NOT per-tenant
# and the provisioning CLI's create_all filter (``schema != 'public'``)
# excludes them when materialising a new tenant schema.

mts_staff = Table(
    "mts_staff",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("email", CITEXT, nullable=False, unique=True),
    Column("password_hash", Text, nullable=False),
    Column("full_name", Text, nullable=False),
    Column("is_active", Boolean, nullable=False, server_default="true"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    schema="public",
)


super_admin_sessions = Table(
    "super_admin_sessions",
    metadata,
    Column("id", String(length=128), primary_key=True),
    Column(
        "mts_staff_id",
        Integer,
        ForeignKey("public.mts_staff.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    # ``data`` carries optional ``impersonated_tenant_id`` once the
    # operator hits "Access as" on a tenant in the console.
    Column("data", JSONB, nullable=False, server_default="{}"),
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
    schema="public",
)


# Append-only at the grant level — ``hadir_app`` has INSERT + SELECT only.
# Mirrors the contract on per-tenant ``audit_log`` so cross-tenant
# Super-Admin actions cannot be retroactively rewritten.
super_admin_audit = Table(
    "super_admin_audit",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "super_admin_user_id",
        Integer,
        ForeignKey("public.mts_staff.id", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    ),
    Column("action", Text, nullable=False),
    Column("entity_type", Text, nullable=False),
    Column("entity_id", Text, nullable=True),
    Column("before", JSONB, nullable=True),
    Column("after", JSONB, nullable=True),
    Column("ip", Text, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    schema="public",
)


users = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
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
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
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
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "role_id",
        Integer,
        ForeignKey("roles.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
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
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
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
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "department_id",
        Integer,
        ForeignKey("departments.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
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
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
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
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    # Nullable — system-originated events (e.g. scheduled capture cleanup)
    # have no human actor.
    Column(
        "actor_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
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


# --- Employees (P5) ---------------------------------------------------------

employees = Table(
    "employees",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    # Employee code is the business id (e.g. 'OM0097'). Case-sensitive here;
    # normalisation happens at the API layer.
    Column("employee_code", Text, nullable=False),
    Column("full_name", Text, nullable=False),
    Column("email", Text, nullable=True),
    Column(
        "department_id",
        Integer,
        ForeignKey("departments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    # Soft-delete flag. 'inactive' hides the row from every default list;
    # hard-delete is reserved for the PDPL right-to-erasure flow (v1.0).
    Column("status", Text, nullable=False, server_default="active"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint("tenant_id", "employee_code", name="uq_employees_tenant_code"),
    CheckConstraint("status IN ('active','inactive')", name="ck_employees_status"),
)


# Photos land in P6; this table exists in P5 so the FK target is stable and
# the upcoming file-write path has somewhere to store metadata.
employee_photos = Table(
    "employee_photos",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("angle", Text, nullable=False, server_default="front"),
    Column("file_path", Text, nullable=False),
    Column(
        "approved_by_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("approved_at", DateTime(timezone=True), nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    # Fernet-encrypted 512-float-32 embedding from InsightFace buffalo_l
    # recognition. Null until enrollment runs (lazy; P9).
    Column("embedding", LargeBinary, nullable=True),
    CheckConstraint(
        "angle IN ('front','left','right','other')", name="ck_employee_photos_angle"
    ),
)


# --- Cameras (P7) -----------------------------------------------------------

cameras = Table(
    "cameras",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("name", Text, nullable=False),
    Column("location", Text, nullable=False, server_default=""),
    # Fernet-encrypted text token. The plain URL (with credentials) lives
    # NOWHERE else — not in logs, API responses, audit rows, or error
    # messages. Decrypt happens only when a request needs to hit the
    # camera (preview now; capture pipeline in P8).
    Column("rtsp_url_encrypted", Text, nullable=False),
    Column("enabled", Boolean, nullable=False, server_default="true"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column("last_seen_at", DateTime(timezone=True), nullable=True),
    Column(
        "images_captured_24h",
        Integer,
        nullable=False,
        server_default="0",
    ),
    UniqueConstraint("tenant_id", "name", name="uq_cameras_tenant_name"),
)


# --- Capture (P8) -----------------------------------------------------------
# detection_events: one row per *track entry* (not per frame), so the table
# doesn't explode. P9 fills in ``embedding`` + ``employee_id`` + ``confidence``
# once identification is wired up.
detection_events = Table(
    "detection_events",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "camera_id",
        Integer,
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "captured_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    # Bounding box in image pixel coordinates: {"x": int, "y": int, "w": int, "h": int}.
    Column("bbox", JSONB, nullable=False),
    Column("face_crop_path", Text, nullable=False),
    # P9 fills these.
    Column("embedding", LargeBinary, nullable=True),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("confidence", Float, nullable=True),
    Column("track_id", Text, nullable=False),
    Index(
        "ix_detection_events_tenant_captured_at",
        "tenant_id",
        "captured_at",
    ),
    Index(
        "ix_detection_events_tenant_camera_captured",
        "tenant_id",
        "camera_id",
        "captured_at",
    ),
    Index(
        "ix_detection_events_tenant_employee_captured",
        "tenant_id",
        "employee_id",
        "captured_at",
    ),
)


# Retention: 30 days (PROJECT_CONTEXT §3). A cleanup job lands later;
# the rows themselves are defined here so the app can insert from day one.
camera_health_snapshots = Table(
    "camera_health_snapshots",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "camera_id",
        Integer,
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "captured_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column("frames_last_minute", Integer, nullable=False, server_default="0"),
    Column("reachable", Boolean, nullable=False),
    Column("note", Text, nullable=True),
    Index(
        "ix_camera_health_tenant_camera_captured",
        "tenant_id",
        "camera_id",
        "captured_at",
    ),
)


# --- Attendance (P10) -------------------------------------------------------

shift_policies = Table(
    "shift_policies",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("name", Text, nullable=False),
    Column("type", Text, nullable=False),
    # Pilot stores a narrow blob: {"start":"07:30","end":"15:30",
    # "grace_minutes":15,"required_hours":8}. v1.0 extends this as each
    # policy type grows its own fields.
    Column("config", JSONB, nullable=False),
    Column("active_from", Date, nullable=False),
    Column("active_until", Date, nullable=True),
    CheckConstraint(
        "type IN ('Fixed','Flex','Ramadan','Custom')",
        name="ck_shift_policies_type",
    ),
)


# attendance_records: one row per (employee_id, date) in the tenant.
# Refreshed every 15 minutes by the scheduler while ``date`` equals today;
# rows for past days are treated as frozen by the pilot (v1.0 adds a late-
# recompute flow).
attendance_records = Table(
    "attendance_records",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column(
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("date", Date, nullable=False),
    Column("in_time", Time, nullable=True),
    Column("out_time", Time, nullable=True),
    Column("total_minutes", Integer, nullable=True),
    Column(
        "policy_id",
        Integer,
        ForeignKey("shift_policies.id", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column("late", Boolean, nullable=False, server_default="false"),
    Column("early_out", Boolean, nullable=False, server_default="false"),
    Column("short_hours", Boolean, nullable=False, server_default="false"),
    Column("absent", Boolean, nullable=False, server_default="false"),
    Column("overtime_minutes", Integer, nullable=False, server_default="0"),
    Column(
        "computed_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    # P11: filled when an approved leave covers the date. Nullable
    # — null on regular working days. The API joins to ``leave_types``
    # to surface the human-readable name.
    Column(
        "leave_type_id",
        Integer,
        ForeignKey("leave_types.id", ondelete="SET NULL"),
        nullable=True,
    ),
    UniqueConstraint(
        "tenant_id", "employee_id", "date", name="uq_attendance_records_tenant_emp_date"
    ),
    Index(
        "ix_attendance_records_tenant_date",
        "tenant_id",
        "date",
    ),
)


# --- Engines ----------------------------------------------------------------


def make_engine() -> Engine:
    """App-runtime engine.

    ``pool_pre_ping`` catches Postgres restarts (common in dev with
    ``docker compose down``) and recycles dead connections rather than
    letting them fail a request. The checkout event installed below
    sets ``search_path`` for every borrowed connection.
    """

    settings = get_settings()
    eng = create_engine(settings.database_url, pool_pre_ping=True, future=True)
    _attach_search_path_listener(eng)
    return eng


def make_admin_engine() -> Engine:
    """Admin engine used by migrations and ``scripts/seed_admin.py``.

    Not for request-path use. The admin role bypasses the append-only
    constraint on ``audit_log`` and should never service user traffic.
    The same checkout event listener applies — admin queries also rely
    on a resolved tenant schema (single mode → ``main``; multi mode →
    explicit ``tenant_context``).
    """

    settings = get_settings()
    eng = create_engine(settings.admin_database_url, pool_pre_ping=True, future=True)
    _attach_search_path_listener(eng)
    return eng


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
