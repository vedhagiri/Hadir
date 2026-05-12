"""SQLAlchemy engine, session factory, and schema metadata.

Pilot used a single Postgres schema (``main``) baked into the metadata.
v1.0 P1 generalises this: ``MetaData()`` carries no schema, every Table
is unqualified, and the active schema is selected per-connection via
``SET search_path``. A SQLAlchemy ``checkout`` event reads the
``_tenant_schema_var`` ContextVar and applies it to each pooled
connection at borrow time.

Behaviour by ``MAUGOOD_TENANT_MODE``:

* ``single`` — pilot mode. If no tenant context is set, the checkout
  defaults the search_path to ``main`` so existing pilot code paths
  (seed_admin, capture workers, scheduler, tests) keep working.
* ``multi`` — v1.0 mode. Refuses to issue queries unless a tenant
  context is set explicitly. This is the **fail-closed** red line:
  a code path that reaches the DB without resolving a tenant raises
  before any SQL leaves the process.

SQLAlchemy Core (not the ORM) — same reasoning as in pilot.

Two engines:

* ``make_engine()`` — connects as ``maugood_app`` (request path).
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
    Numeric,
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

from maugood.config import get_settings

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
    "maugood_tenant_schema", default=None
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
        "(MAUGOOD_TENANT_MODE=multi). Wrap the code path in "
        "maugood.db.tenant_context(schema=...) or attach the request "
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
# ``TenantScope`` dependency (``maugood.tenants.scope``) to thread the value
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
    # User-facing identifier. This is what API payloads call
    # ``tenant_slug`` and what credentials.txt + the frontend tenant
    # picker show operators. Stored as ``citext`` so the lookup is
    # case-insensitive without ``LOWER()`` on every call site (mirrors
    # ``users.email``). Format constrained by migration 0026 to
    # ``^[a-z][a-z0-9_-]{1,39}$``. Provisioning derives ``schema_name``
    # from this — never the other way round.
    Column("slug", CITEXT, nullable=False, unique=True),
    # Postgres schema this tenant's data lives in. Internal routing
    # only — read out of the row after a slug match and fed to
    # ``SET search_path``. Pilot tenant uses ``main`` for backward
    # compat; v1.0 provisioning creates ``tenant_<slug>`` schemas
    # (with hyphens in the slug rewritten to underscores so the
    # schema name remains a bare Postgres identifier). Constrained
    # server-side via the regex in migration 0007 to match
    # ``_TENANT_SCHEMA_RE`` above.
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
# ``maugood/branding/constants.py`` — there is no free-form hex entry and
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
    # P28.5c: system-wide detection + tracker config. Per-camera
    # ``capture_config`` (P28.5b) carries ``max_event_duration_sec``
    # too — per-camera value OVERRIDES the tenant default for shared
    # keys (documented in backend/CLAUDE.md § "Capture configuration
    # precedence").
    Column(
        "detection_config",
        JSONB,
        nullable=False,
        server_default=(
            '{"mode": "insightface", '
            '"det_size": 320, '
            '"min_det_score": 0.5, '
            '"min_face_pixels": 3600, '
            '"yolo_conf": 0.35, '
            '"show_body_boxes": false}'
        ),
    ),
    Column(
        "tracker_config",
        JSONB,
        nullable=False,
        server_default=(
            '{"iou_threshold": 0.3, '
            '"timeout_sec": 2.0, '
            '"max_duration_sec": 60.0}'
        ),
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


request_reason_categories = Table(
    "request_reason_categories",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("request_type", Text, nullable=False),
    Column("code", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("display_order", Integer, nullable=False, server_default="0"),
    Column("active", Boolean, nullable=False, server_default="true"),
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
        "request_type",
        "code",
        name="uq_request_reason_categories_tenant_type_code",
    ),
    CheckConstraint(
        "request_type IN ('exception','leave')",
        name="ck_request_reason_categories_request_type",
    ),
)


# --- ERP file-drop export (P19) -------------------------------------------
# Per-tenant config for the scheduled ERP file-drop. ``output_path`` is
# constrained server-side to live under ``/data/erp/{tenant_id}/...``;
# the runner refuses any path that escapes via ``..``.

erp_export_config = Table(
    "erp_export_config",
    metadata,
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("enabled", Boolean, nullable=False, server_default="false"),
    Column("format", Text, nullable=False, server_default="csv"),
    Column("output_path", Text, nullable=False, server_default=""),
    Column("schedule_cron", Text, nullable=False, server_default=""),
    Column("window_days", Integer, nullable=False, server_default="1"),
    Column("last_run_at", DateTime(timezone=True), nullable=True),
    Column("last_run_status", Text, nullable=True),
    Column("last_run_path", Text, nullable=True),
    Column("last_run_error", Text, nullable=True),
    Column("next_run_at", DateTime(timezone=True), nullable=True),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "format IN ('csv','json')", name="ck_erp_export_config_format"
    ),
)


# --- Email config + scheduled reports (P18) -------------------------------
# ``email_config`` carries the tenant's outbound email credentials
# (Fernet-encrypted at rest); ``report_schedules`` is the operator's
# recurring-report definition, ``report_runs`` is one row per execution.

email_config = Table(
    "email_config",
    metadata,
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("provider", Text, nullable=False, server_default="smtp"),
    Column("smtp_host", Text, nullable=False, server_default=""),
    Column("smtp_port", Integer, nullable=False, server_default="587"),
    Column("smtp_username", Text, nullable=False, server_default=""),
    Column("smtp_password_encrypted", Text, nullable=True),
    Column("smtp_use_tls", Boolean, nullable=False, server_default="true"),
    Column("graph_tenant_id", Text, nullable=False, server_default=""),
    Column("graph_client_id", Text, nullable=False, server_default=""),
    Column("graph_client_secret_encrypted", Text, nullable=True),
    Column("from_address", Text, nullable=False, server_default=""),
    Column("from_name", Text, nullable=False, server_default=""),
    Column("enabled", Boolean, nullable=False, server_default="false"),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "provider IN ('smtp','microsoft_graph')",
        name="ck_email_config_provider",
    ),
)


report_schedules = Table(
    "report_schedules",
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
    Column("report_type", Text, nullable=False, server_default="attendance"),
    Column("format", Text, nullable=False),
    Column("filter_config", JSONB, nullable=False, server_default="{}"),
    Column("recipients", JSONB, nullable=False, server_default="[]"),
    Column("schedule_cron", Text, nullable=False),
    Column("active", Boolean, nullable=False, server_default="true"),
    Column("last_run_at", DateTime(timezone=True), nullable=True),
    Column("last_run_status", Text, nullable=True),
    Column("next_run_at", DateTime(timezone=True), nullable=True),
    Column(
        "created_by_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
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
    CheckConstraint(
        "format IN ('xlsx','pdf')", name="ck_report_schedules_format"
    ),
    CheckConstraint(
        "report_type IN ('attendance')",
        name="ck_report_schedules_report_type",
    ),
    Index(
        "ix_report_schedules_tenant_active_next",
        "tenant_id",
        "active",
        "next_run_at",
    ),
)


report_runs = Table(
    "report_runs",
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
        "schedule_id",
        Integer,
        ForeignKey("report_schedules.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    ),
    Column(
        "started_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Column("finished_at", DateTime(timezone=True), nullable=True),
    Column("status", Text, nullable=False, server_default="running"),
    Column("file_path", Text, nullable=True),
    Column("file_size_bytes", Integer, nullable=True),
    Column("recipients_delivered_to", JSONB, nullable=False, server_default="[]"),
    Column("error_message", Text, nullable=True),
    Column("delivery_mode", Text, nullable=True),
    CheckConstraint(
        "status IN ('running','succeeded','failed')",
        name="ck_report_runs_status",
    ),
    Index(
        "ix_report_runs_tenant_schedule_started",
        "tenant_id",
        "schedule_id",
        "started_at",
    ),
)


# --- Notifications (P20) --------------------------------------------------
# Replaces the P16 ``notifications_queue`` stub. ``notifications`` is the
# real per-tenant queue + history; ``notification_preferences`` carries
# the per-user category × channel toggles. Missing prefs row → both
# in_app + email default to true (resolved in code, not DB).

notifications = Table(
    "notifications",
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
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("category", Text, nullable=False),
    Column("subject", Text, nullable=False),
    Column("body", Text, nullable=False, server_default=""),
    Column("link_url", Text, nullable=True),
    Column("payload", JSONB, nullable=False, server_default="{}"),
    Column("read_at", DateTime(timezone=True), nullable=True),
    Column("email_sent_at", DateTime(timezone=True), nullable=True),
    Column("email_attempts", Integer, nullable=False, server_default="0"),
    Column("email_failed_at", DateTime(timezone=True), nullable=True),
    Column("email_error", Text, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "category IN ("
        "'approval_assigned','approval_decided','overtime_flagged',"
        "'camera_unreachable','report_ready','admin_override'"
        ")",
        name="ck_notifications_category",
    ),
    Index(
        "ix_notifications_tenant_user_unread",
        "tenant_id",
        "user_id",
        "read_at",
    ),
    Index(
        "ix_notifications_tenant_email_pending",
        "tenant_id",
        "email_sent_at",
        "email_failed_at",
    ),
)


notification_preferences = Table(
    "notification_preferences",
    metadata,
    Column(
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        primary_key=True,
    ),
    Column("category", Text, primary_key=True),
    Column("in_app", Boolean, nullable=False, server_default="true"),
    Column("email", Boolean, nullable=False, server_default="true"),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "category IN ("
        "'approval_assigned','approval_decided','overtime_flagged',"
        "'camera_unreachable','report_ready','admin_override'"
        ")",
        name="ck_notification_preferences_category",
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
# with ``MAUGOOD_AUTH_FERNET_KEY`` (separate from the photo/RTSP key —
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


# Append-only at the grant level — ``maugood_app`` has INSERT + SELECT only.
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
    # P21: per-user UI language. NULL = "follow browser"; only the
    # two codes Maugood ships translations for ('en', 'ar') are
    # acceptable — DB CHECK is the load-bearing guard.
    Column("preferred_language", Text, nullable=True),
    # P22: theme + density. NULL on theme = "follow system"; NULL on
    # density = "comfortable" (the design's default). DB CHECK locks
    # the enums.
    Column("preferred_theme", Text, nullable=True),
    Column("preferred_density", Text, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint("tenant_id", "email", name="uq_users_tenant_email"),
    CheckConstraint(
        "preferred_language IS NULL OR preferred_language IN ('en','ar')",
        name="ck_users_preferred_language",
    ),
    CheckConstraint(
        "preferred_theme IS NULL OR preferred_theme IN ('system','light','dark')",
        name="ck_users_preferred_theme",
    ),
    CheckConstraint(
        "preferred_density IS NULL OR preferred_density IN ('compact','comfortable')",
        name="ck_users_preferred_density",
    ),
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


divisions = Table(
    "divisions",
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
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint("tenant_id", "code", name="uq_divisions_tenant_code"),
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
    # P29 (#3): top-tier hierarchy. Nullable so existing tenants
    # without divisions keep working until backfilled.
    Column(
        "division_id",
        Integer,
        ForeignKey("divisions.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    ),
    UniqueConstraint("tenant_id", "code", name="uq_departments_tenant_code"),
)


sections = Table(
    "sections",
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
        "department_id",
        Integer,
        ForeignKey("departments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("code", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    UniqueConstraint(
        "tenant_id",
        "department_id",
        "code",
        name="uq_sections_tenant_dept_code",
    ),
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


# P29 (#3): manager-to-division and manager-to-section mirrors of
# user_departments. The scope helper unions all three so a manager
# assigned at any tier sees the right slice.
user_divisions = Table(
    "user_divisions",
    metadata,
    Column(
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "division_id",
        Integer,
        ForeignKey("divisions.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tenant_id",
        Integer,
        ForeignKey("public.tenants.id", ondelete="RESTRICT"),
        primary_key=True,
    ),
)


user_sections = Table(
    "user_sections",
    metadata,
    Column(
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "section_id",
        Integer,
        ForeignKey("sections.id", ondelete="CASCADE"),
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


# audit_log is append-only at the database grant level — ``maugood_app`` has
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
    # P28-followup: short tag for non-human actors (system_seed,
    # retention_sweep, notification_worker, …). NULL when
    # ``actor_user_id`` is set so the FK stays the source of
    # truth for human actions.
    Column("actor_label", Text, nullable=True),
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
    # P29 (#3): finest-grained tier of the org hierarchy. Optional —
    # not every tenant uses sections. Section visibility joins through
    # ``user_sections`` in the manager scope helper.
    Column(
        "section_id",
        Integer,
        ForeignKey("sections.id", ondelete="RESTRICT"),
        nullable=True,
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
    # P28.7: extended fields for lifecycle + HR org chart.
    # ``reports_to_user_id`` is a separate concept from
    # ``manager_assignments`` (which drives approval scope) — this one
    # is the HR org chart for the Edit drawer's "Reports to" picker.
    Column("designation", Text, nullable=True),
    Column("phone", Text, nullable=True),
    Column(
        "reports_to_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("joining_date", Date, nullable=True),
    Column("relieving_date", Date, nullable=True),
    Column("deactivated_at", DateTime(timezone=True), nullable=True),
    Column("deactivation_reason", Text, nullable=True),
    UniqueConstraint("tenant_id", "employee_code", name="uq_employees_tenant_code"),
    CheckConstraint(
        "status IN ('active','inactive','deleted')",
        name="ck_employees_status",
    ),
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
    # Migration 0036: explicit provenance — who put the photo in the
    # system. Null on legacy rows that pre-date the column → the
    # Employee self-delete path treats those as "not mine" and
    # refuses; only Admin/HR can wipe them.
    Column(
        "uploaded_by_user_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    # Migration 0036: approval gate. Admin/HR uploads auto-approve;
    # Employee self-uploads land as 'pending' and need an Admin/HR
    # action via the approval queue. The matcher cache filters on
    # this column so a pending photo doesn't enrol until approved.
    Column(
        "approval_status",
        Text,
        nullable=False,
        server_default="approved",
    ),
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
    CheckConstraint(
        "approval_status IN ('approved', 'pending', 'rejected')",
        name="ck_employee_photos_approval_status",
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
    # Migration 0034 — running human-readable code (CAM-001, CAM-002,
    # …). Auto-assigned on create as the next sequence within the
    # tenant; operator can rename later. Unique per tenant.
    Column("camera_code", Text, nullable=True),
    # Migration 0034 — zone tag (Entry / Exit / Lobby / Parking /
    # Office / Outdoor / Other). Free text on the DB side; the form
    # offers a curated list.
    Column("zone", Text, nullable=True),
    # Fernet-encrypted text token. The plain URL (with credentials) lives
    # NOWHERE else — not in logs, API responses, audit rows, or error
    # messages. Decrypt happens only when a request needs to hit the
    # camera (preview now; capture pipeline in P8).
    Column("rtsp_url_encrypted", Text, nullable=False),
    # P28.5b: split the pilot's single ``enabled`` flag into two
    # independent operational levers. ``worker_enabled`` controls
    # whether the backend reads frames + records detection events;
    # ``display_enabled`` controls whether Live Capture surfaces the
    # camera. Existing rows backfilled by migration 0027 from the old
    # ``enabled`` column.
    Column("worker_enabled", Boolean, nullable=False, server_default="true"),
    Column("display_enabled", Boolean, nullable=False, server_default="true"),
    # Migration 0033 — third operational lever: when False, the worker
    # keeps reading frames + driving live preview but the analyzer
    # thread skips the expensive detect call and no detection_events
    # rows are produced. Default true preserves prior "worker on = full
    # pipeline" behaviour. See docs/phases/cameras-detection-toggle.md.
    Column(
        "detection_enabled", Boolean, nullable=False, server_default="true"
    ),
    # P28.5b: per-camera capture knob bag. Defaults match the
    # prototype's tested constants. Schema is open by design — the
    # set of knobs evolves between phases without a migration. The
    # API + audit log carry the full JSONB.
    Column(
        "capture_config",
        JSONB,
        nullable=False,
        server_default=(
            # ``min_face_quality_to_save`` is a deprecated no-op kept
            # for back-compat with migration 0027's JSONB shape.
            # See docs/phases/fix-detector-mode-preflight.md Layer 2.
            '{"max_faces_per_event": 10, '
            '"max_event_duration_sec": 60, '
            '"min_face_quality_to_save": 0.0, '
            '"save_full_frames": false}'
        ),
    ),
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
    # P28.8: camera metadata. Auto-detected (read once on the
    # worker's first successful RTSP read; never edited via the
    # API). Detected_at is the timestamp of the latest detection
    # so the UI can render "5 days ago" hints.
    Column("detected_resolution_w", Integer, nullable=True),
    Column("detected_resolution_h", Integer, nullable=True),
    Column("detected_fps", Numeric(5, 2), nullable=True),
    Column("detected_codec", Text, nullable=True),
    Column("detected_at", DateTime(timezone=True), nullable=True),
    # P28.8: manual fields. Admin fills via the cameras edit drawer.
    Column("brand", Text, nullable=True),
    Column("model", Text, nullable=True),
    Column("mount_location", Text, nullable=True),
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
    # P28.5b orphan-row hardening: face_crop_path is nullable so the
    # cleanup script can clear pointers for rows whose file was lost.
    # The detection itself (bbox, track, employee_id, confidence) is
    # still real and historically meaningful — only the crop image is
    # gone. UI surfaces NULL as "Crop unavailable".
    Column("face_crop_path", Text, nullable=True),
    # Set when the cleanup script (or a future automatic sweep)
    # detected that ``face_crop_path`` pointed at a missing file and
    # cleared it. NULL on healthy rows.
    Column("orphaned_at", DateTime(timezone=True), nullable=True),
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
    # P28.7: when the matcher hits an *inactive* employee
    # ``former_employee_match`` is set to true and ``employee_id``
    # stays NULL — so attendance queries (which filter on
    # ``employee_id IS NOT NULL``) automatically exclude former
    # employees, while the Camera Logs / Former-employees-seen
    # report can join via ``former_match_employee_id``.
    Column(
        "former_employee_match",
        Boolean,
        nullable=False,
        server_default="false",
    ),
    Column(
        "former_match_employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="SET NULL"),
        nullable=True,
    ),
    # Per-row snapshot of which detector + recognition models produced
    # this event and which package versions were running. JSONB so v1.x
    # can extend without another migration. NULL on rows that pre-date
    # migration 0032. See ``maugood/detection/metadata.py``.
    Column("detection_metadata", JSONB, nullable=True),
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


# --- Delete requests (P28.7) -----------------------------------------------
# Per-tenant queue of HR-approved hard-delete requests for employees.
# Separate from ``requests`` (P13 attendance/leave exceptions) — different
# state machine, different actor rules, different consequences.
#
# State machine:
#   pending          → Admin filed it; HR has not decided
#   approved         → HR (or HR self-file) approved → hard-delete fired
#   rejected         → HR rejected (terminal)
#   admin_override   → another Admin overrode + approved → hard-delete fired
#   cancelled        → submitter withdrew (terminal)
#
# Partial unique index ``uq_delete_requests_pending_per_employee`` lives in
# the migration (Postgres-only) — at most ONE pending row per employee.
delete_requests = Table(
    "delete_requests",
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
        "requested_by",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("reason", Text, nullable=False),
    Column("status", Text, nullable=False, server_default="pending"),
    Column(
        "hr_decided_by",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("hr_decided_at", DateTime(timezone=True), nullable=True),
    Column("hr_comment", Text, nullable=True),
    Column(
        "admin_override_by",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("admin_override_at", DateTime(timezone=True), nullable=True),
    Column("admin_override_comment", Text, nullable=True),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "status IN ('pending','approved','rejected','admin_override','cancelled')",
        name="ck_delete_requests_status",
    ),
)


# --- Person clips (P37) -----------------------------------------------------
# One row per short video clip saved when the capture pipeline identifies a
# person. Clips are Fernet-encrypted at rest under
# ``/data/clips/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.avi``.

person_clips = Table(
    "person_clips",
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
        "employee_id",
        Integer,
        ForeignKey("employees.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    ),
    Column("track_id", Text, nullable=True),
    Column(
        "detection_event_id",
        Integer,
        ForeignKey("detection_events.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("clip_start", DateTime(timezone=True), nullable=False),
    Column("clip_end", DateTime(timezone=True), nullable=False),
    Column("duration_seconds", Float, nullable=False, server_default="0"),
    Column("file_path", Text, nullable=True),
    Column("filesize_bytes", Integer, nullable=False, server_default="0"),
    Column("frame_count", Integer, nullable=False, server_default="0"),
    Column("person_count", Integer, nullable=False, server_default="0"),
    Column(
        "face_crops_status",
        Text,
        nullable=False,
        server_default="pending",
    ),
    Column(
        "matched_employees",
        JSONB,
        nullable=False,
        server_default="[]",
    ),
    Column(
        "matched_status",
        Text,
        nullable=False,
        server_default="pending",
    ),
    Column(
        "person_start",
        DateTime(timezone=True),
        nullable=True,
    ),
    Column(
        "person_end",
        DateTime(timezone=True),
        nullable=True,
    ),
    Column(
        "face_matching_duration_ms",
        Integer,
        nullable=True,
    ),
    Column(
        "face_matching_progress",
        Integer,
        nullable=False,
        server_default="0",
    ),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Index(
        "ix_person_clips_tenant_camera_created",
        "tenant_id",
        "camera_id",
        "created_at",
    ),
    Index(
        "ix_person_clips_tenant_employee_created",
        "tenant_id",
        "employee_id",
        "created_at",
    ),
)


# One row per face crop extracted from a person clip video. Crops are
# Fernet-encrypted at rest under ``/face_crops/camera_{id}/event_{ts}/face_{xxx}.jpg``.
# Extracted asynchronously after the clip is finalized.
face_crops = Table(
    "face_crops",
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
        "person_clip_id",
        Integer,
        ForeignKey("person_clips.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("event_timestamp", Text, nullable=False),
    Column("face_index", Integer, nullable=False, server_default="1"),
    Column("file_path", Text, nullable=True),
    Column("quality_score", Float, nullable=False, server_default="0"),
    Column("sharpness", Float, nullable=False, server_default="0"),
    Column("detection_score", Float, nullable=False, server_default="0"),
    Column("width", Integer, nullable=False, server_default="0"),
    Column("height", Integer, nullable=False, server_default="0"),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    Index("ix_face_crops_tenant_camera_created", "tenant_id", "camera_id", "created_at"),
    Index("ix_face_crops_tenant_clip", "tenant_id", "person_clip_id"),
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
