"""0085 — Per-tenant RTSP reconnect configuration.

Makes the camera reconnect behaviour controllable per-tenant from the
DB (driven by System Settings → RTSP Reconnect in the UI), replacing the
hardcoded exponential backoff in ``maugood/capture/reader.py``.

Adds:

* ``tenant_settings.reconnect_config`` — JSONB, **NOT NULL** with a
  server default of ``{"enabled": true, "interval_seconds": 30}``.
  ``enabled`` toggles whether a disconnected camera is retried at all;
  when ``false`` the worker parks and makes no reconnect attempts.
  ``interval_seconds`` is the fixed delay between attempts when enabled
  (the UI lets the operator enter it as seconds / minutes / hours and
  converts to seconds before saving).

The NOT NULL + server default means every existing ``tenant_settings``
row is backfilled with the default on upgrade, preserving today's
"always reconnect" behaviour (just at a fixed 30 s instead of the old
1→30 s backoff).

No new grant needed — ``maugood_app`` already holds
SELECT/INSERT/UPDATE/DELETE on ``tenant_settings``; this only adds a
column to an existing table.

Schema-agnostic + idempotent: the existence check uses
``information_schema`` against ``current_schema()`` so re-running on a
partially-upgraded tenant is safe; the unqualified table name lets the
column land in whichever schema the alembic search_path points at.

Revision ID: 0085_tenant_settings_reconnect
Revises:     0084_reports_to_employee
Create Date: 2026-06-19
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0085_tenant_settings_reconnect"
down_revision: Union[str, Sequence[str], None] = "0084_reports_to_employee"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEFAULT = '{"enabled": true, "interval_seconds": 30}'


def _has_column(bind, table: str, column: str) -> bool:
    return bool(
        bind.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "  AND table_name   = :t "
                "  AND column_name  = :c"
            ),
            {"t": table, "c": column},
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "tenant_settings", "reconnect_config"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "reconnect_config",
                postgresql.JSONB(),
                nullable=False,
                server_default=text(f"'{_DEFAULT}'::jsonb"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "tenant_settings", "reconnect_config"):
        op.drop_column("tenant_settings", "reconnect_config")
