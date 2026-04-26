"""Allow ``employees.status='deleted'`` for the PDPL flow (v1.0 P25).

The pilot status enum was ``active|inactive`` (soft delete only).
P25 adds the PDPL delete-on-request flow, which redacts PII and
flips the status to ``deleted`` — a third terminal state that's
visible in admin lists but distinct from ``inactive`` (the
employee left voluntarily, no PII redaction needed).

Schema-agnostic: ``employees`` lives per-tenant, so the
migration runs cleanly under each tenant schema via the
orchestrator.

Revision ID: 0024_employees_status_deleted
Revises: 0023_users_theme_density
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0024_employees_status_deleted"
down_revision: Union[str, Sequence[str], None] = "0023_users_theme_density"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_employees_status", "employees", type_="check"
    )
    op.create_check_constraint(
        "ck_employees_status",
        "employees",
        "status IN ('active','inactive','deleted')",
    )


def downgrade() -> None:
    # Refuse to flip back to a 2-value CHECK if any rows already
    # use the ``deleted`` state — pre-emptively rejecting the
    # downgrade is the right call (downgrading would silently
    # break the CHECK and make those rows unreadable).
    op.execute(
        "DO $$ BEGIN "
        "IF EXISTS (SELECT 1 FROM employees WHERE status = 'deleted') THEN "
        "RAISE EXCEPTION 'Cannot downgrade: employees.status=''deleted'' rows exist'; "
        "END IF; END $$;"
    )
    op.drop_constraint(
        "ck_employees_status", "employees", type_="check"
    )
    op.create_check_constraint(
        "ck_employees_status",
        "employees",
        "status IN ('active','inactive')",
    )
