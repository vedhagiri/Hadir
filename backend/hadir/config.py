"""Pydantic Settings for the Hadir backend.

All configuration is environment-driven. The repository ships a `.env.example`
at the repo root and one per service; copy to `.env` and fill in for local dev.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables.

    All variables are prefixed with `HADIR_` so they don't collide with other
    services running in the same shell or container.
    """

    model_config = SettingsConfigDict(
        env_prefix="HADIR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["dev", "staging", "production"] = "dev"
    tenant_mode: Literal["single", "multi"] = "single"

    # Two connection URLs — the app runs as `hadir_app` (limited grants,
    # insert/select only on audit_log) and migrations/admin scripts run as
    # `hadir_admin` (full owner rights). See backend/CLAUDE.md "Database
    # roles and grants" for the policy this enforces.
    database_url: str = Field(
        default="postgresql+psycopg://hadir_app:hadir_app@postgres:5432/hadir",
        description="App-runtime SQLAlchemy URL. Pilot schema is `main`.",
    )
    admin_database_url: str = Field(
        default="postgresql+psycopg://hadir:hadir@postgres:5432/hadir",
        description="Admin URL used by Alembic and seed scripts. Owner account.",
    )

    # Secrets — required in non-dev. Defaults are obvious placeholders so a
    # missing value blows up loudly rather than silently using a real-looking key.
    session_secret: str = Field(default="dev-session-secret-change-me")
    fernet_key: str = Field(default="dev-fernet-key-change-me")

    # Tenant default for the pilot. Set to 1 because the initial migration
    # seeds tenant id=1 ('Omran'). In multi-tenant mode (v1.0) this default
    # goes away and tenant is derived from the session or request host.
    default_tenant_id: int = 1

    # --- Session cookie + sliding expiry (P3) ------------------------------
    # Idle timeout in minutes. Every authenticated request extends the
    # session's ``expires_at`` by this amount; it never becomes an absolute
    # session lifetime (per PROJECT_CONTEXT the pilot prioritises convenience
    # over belt-and-braces security).
    session_idle_minutes: int = 60
    # Cookie name. Kept stable so an operator can invalidate all pilot
    # sessions by renaming it in config + bouncing the service.
    session_cookie_name: str = "hadir_session"
    # HTTPS is out of scope for the pilot (PROJECT_CONTEXT §8 — deferred);
    # flip this to ``True`` the moment we wire TLS in v1.0.
    session_cookie_secure: bool = False

    # --- Login rate limit (P3) ---------------------------------------------
    # Pilot-grade in-memory counter, keyed by (email, client IP), reset on
    # a 10-minute schedule by APScheduler. Any real deployment should
    # replace this with a distributed store (Redis) before going live.
    login_max_attempts: int = 10
    login_rate_limit_reset_minutes: int = 10

    # --- Face photo storage (P6) -------------------------------------------
    # Root directory for employee reference photos and (P8) capture crops.
    # Files are Fernet-encrypted before they touch disk — see
    # ``hadir.employees.photos``.
    faces_storage_path: str = "/data/faces"

    # --- Face identification (P9) ------------------------------------------
    # Cosine-similarity cutoff. Below this, the matcher refuses to set
    # an ``employee_id`` on the detection event — the threshold is
    # hard, not advisory (pilot-plan red line).
    match_threshold: float = 0.45

    # --- Attendance (P10) --------------------------------------------------
    # IANA timezone used to convert detection timestamps to wall-clock
    # local time for comparison against a shift policy's ``start``/``end``
    # fields. Default matches Omran in Oman.
    local_timezone: str = "Asia/Muscat"
    # Scheduler cadence for recomputing today's attendance_records rows.
    attendance_recompute_minutes: int = 15

    # --- Entra ID OIDC (v1.0 P6) -------------------------------------------
    # Separate Fernet key from ``fernet_key`` (which encrypts photos and
    # RTSP credentials). Auth-scoped. If one is compromised the other
    # still holds — that's the whole point of the split.
    auth_fernet_key: str = Field(default="dev-auth-fernet-key-change-me")
    # Base URL Entra calls back to. The redirect URI we register in
    # Entra is ``{oidc_redirect_base_url}/api/auth/oidc/callback``. In
    # production this must be HTTPS; in dev we accept plain http on
    # localhost.
    oidc_redirect_base_url: str = "http://localhost:8000"
    # State + nonce cookie TTL. Ten minutes is enough for an MFA prompt
    # plus operator hesitation; anything longer widens the replay window.
    oidc_state_ttl_seconds: int = 600
    # Clock-skew tolerance when validating ID-token ``exp`` / ``nbf``.
    oidc_clock_skew_seconds: int = 60

    # --- Request attachments (v1.0 P14) ------------------------------------
    # Max upload size in megabytes. Enforced server-side regardless of
    # what the client claims (the P14 red line). The client is told the
    # same number via ``GET /api/requests/attachment-config`` so it can
    # block bad files before the upload starts.
    request_attachment_max_mb: int = 5
    # Where attachments live on disk. The router writes
    # ``{root}/{tenant_id}/requests/{uuid}.{ext}``. Encrypted at rest
    # via the same Fernet key the photo path uses.
    request_attachment_root: str = "/data/attachments"

    # --- ERP file-drop export (v1.0 P19) ----------------------------------
    # Root directory the runner is allowed to write into. Operator-
    # configured ``output_path`` values are joined onto this root +
    # the tenant id; the resolved absolute path must stay strictly
    # under ``{root}/{tenant_id}/`` (the load-bearing P19 red line).
    erp_export_root: str = "/data/erp"

    # --- Email + scheduled reports (v1.0 P18) -----------------------------
    # Inbox-friendly attachment cap. Files at or below this size go in
    # the email body as attachments; anything larger is replaced with a
    # signed-URL link to the report-runs download endpoint.
    email_attachment_max_mb: int = 10
    # Where the runner writes generated report files. Each tenant gets
    # a subfolder under ``{root}/{tenant_id}/runs/{uuid}.{xlsx|pdf}``.
    report_output_root: str = "/data/reports"
    # HMAC secret + TTL for the signed-URL download endpoint. Default
    # TTL of 7 days mirrors the BRD; ops can rotate the secret without
    # invalidating active sessions because the secret only signs
    # download tokens, not auth cookies.
    report_signed_url_secret: str = Field(
        default="dev-report-signed-url-secret-change-me"
    )
    report_signed_url_ttl_days: int = 7
    # Per-IP token validation rate limit for the signed-URL endpoint.
    # Loose by design — legitimate operators rarely fetch the same
    # report dozens of times in a minute.
    report_signed_url_rate_limit_per_minute: int = 30
    # APScheduler poll cadence for the runner. One minute matches the
    # cron resolution; tighter feels twitchy, wider misses minute-of-
    # the-hour cron expressions.
    report_runner_poll_seconds: int = 60

    # --- Approvals SLA (v1.0 P15) ------------------------------------------
    # Business hours after which a non-terminal request is flagged as
    # breaching SLA. BRD Open Item Q6 — operators tune per tenant; the
    # default mirrors the BRD recommendation (48 business hours).
    # "Business hours" = wall-clock hours on days that aren't tenant
    # weekends (per the P11 tenant_settings.weekend_days).
    request_sla_business_hours: int = 48
    # Length of a single business day in hours. We use this to convert
    # the threshold to a calendar duration when picking the cutoff.
    request_sla_business_day_hours: int = 8


def get_settings() -> Settings:
    """Return a fresh Settings instance.

    Kept as a function (not a module-level singleton) so tests can override
    environment variables and re-instantiate without import-time caching.
    """

    return Settings()
