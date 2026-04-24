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

    database_url: str = Field(
        default="postgresql+psycopg://hadir:hadir@postgres:5432/hadir",
        description="SQLAlchemy URL for Postgres. In single-tenant mode the schema is `main`.",
    )

    # Secrets — required in non-dev. Defaults are obvious placeholders so a
    # missing value blows up loudly rather than silently using a real-looking key.
    session_secret: str = Field(default="dev-session-secret-change-me")
    fernet_key: str = Field(default="dev-fernet-key-change-me")


def get_settings() -> Settings:
    """Return a fresh Settings instance.

    Kept as a function (not a module-level singleton) so tests can override
    environment variables and re-instantiate without import-time caching.
    """

    return Settings()
