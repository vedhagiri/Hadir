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


def get_settings() -> Settings:
    """Return a fresh Settings instance.

    Kept as a function (not a module-level singleton) so tests can override
    environment variables and re-instantiate without import-time caching.
    """

    return Settings()
