"""Add ``actor_label`` to ``audit_log`` for non-user actors (P28-followup).

The pilot's ``audit_log`` carried ``actor_user_id`` (nullable) for
human actors. Non-human actors — scheduled jobs, retention sweeps,
the pre-Omran reset+seed script — write rows with
``actor_user_id=NULL``. Without a label, an auditor reading the row
months later can't tell which subsystem created it.

``actor_label`` is a short free-text tag (e.g. ``system_seed``,
``retention_sweep``, ``notification_worker``) the writer sets when
no human is in scope. NULL when ``actor_user_id`` is set — keeps
the column from competing with the FK as the authoritative actor.

Schema-agnostic: ``audit_log`` lives per-tenant, so the migration
runs cleanly under each tenant schema via the orchestrator.

Revision ID: 0025_audit_log_actor_label
Revises: 0024_employees_status_deleted
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0025_audit_log_actor_label"
down_revision: Union[str, Sequence[str], None] = "0024_employees_status_deleted"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "audit_log",
        sa.Column("actor_label", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("audit_log", "actor_label")
