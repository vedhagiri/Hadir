"""Add automatic daily clip cleanup settings to tenant_settings.

Distinct from the two existing clip-reclamation knobs:

* ``clip_retention_days`` (0069) — age-based sweep (older than N days).
* ``auto_delete_clip_after_processing`` (0083) — drop the video once
  every enabled use-case has finished with it.

This one is a **calendar-day** cleanup: when enabled, at a configured
local time each day the raw video of every clip created *before today*
(i.e. the day that just ended, plus any older residue) is deleted —
regardless of whether it was processed. Helps bound disk during
long-running deployments and testing.

Columns:
* ``clip_daily_cleanup_enabled``    BOOL  NOT NULL DEFAULT false
* ``clip_daily_cleanup_time``       TEXT  NOT NULL DEFAULT '00:00'  (HH:MM, 24h)
* ``clip_daily_cleanup_last_run_on`` DATE NULL  (bookkeeping: fire once/day)

Revision ID: 0090_clip_daily_cleanup
Revises:     0089_queue_clear_history
Create Date: 2026-07-01
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0090_clip_daily_cleanup"
down_revision: Union[str, Sequence[str], None] = "0089_queue_clear_history"
branch_labels = None
depends_on = None

_TIME_CHECK = "ck_tenant_settings_clip_daily_cleanup_time"
_TIME_CHECK_SQL = (
    "clip_daily_cleanup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'"
)


def _has_column(bind, table: str, column: str) -> bool:
    return (
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = :t AND column_name = :c "
                "AND table_schema = current_schema()"
            ),
            {"t": table, "c": column},
        ).first()
        is not None
    )


def _has_constraint(bind, name: str) -> bool:
    return (
        bind.execute(
            sa.text(
                "SELECT 1 FROM pg_constraint c "
                "JOIN pg_namespace n ON n.oid = c.connamespace "
                "WHERE c.conname = :n AND n.nspname = current_schema()"
            ),
            {"n": name},
        ).first()
        is not None
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "tenant_settings", "clip_daily_cleanup_enabled"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "clip_daily_cleanup_enabled",
                sa.Boolean,
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
    if not _has_column(bind, "tenant_settings", "clip_daily_cleanup_time"):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "clip_daily_cleanup_time",
                sa.Text,
                nullable=False,
                server_default="00:00",
            ),
        )
    if not _has_column(
        bind, "tenant_settings", "clip_daily_cleanup_last_run_on"
    ):
        op.add_column(
            "tenant_settings",
            sa.Column(
                "clip_daily_cleanup_last_run_on",
                sa.Date,
                nullable=True,
            ),
        )
    if not _has_constraint(bind, _TIME_CHECK):
        op.create_check_constraint(
            _TIME_CHECK, "tenant_settings", _TIME_CHECK_SQL
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_constraint(bind, _TIME_CHECK):
        op.drop_constraint(_TIME_CHECK, "tenant_settings", type_="check")
    for col in (
        "clip_daily_cleanup_last_run_on",
        "clip_daily_cleanup_time",
        "clip_daily_cleanup_enabled",
    ):
        if _has_column(bind, "tenant_settings", col):
            op.drop_column("tenant_settings", col)
