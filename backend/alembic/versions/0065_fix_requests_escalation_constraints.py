"""Fix requests CHECK constraints to include 'escalation' type.

Migration 0063 updated the constraints on existing schemas via explicit
ALTER TABLE statements, but newly provisioned tenants were created via
``metadata.create_all`` which read the old constraint text directly from
db.py (before db.py was patched). This migration idempotently re-applies
the correct widened constraints so all schemas converge to the same shape.

Revision ID: 0065_fix_requests_escalation
Revises:     0064_esc_cats_extra
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0065_fix_requests_escalation"
down_revision: str = "0064_esc_cats_extra"
branch_labels = None
depends_on = None


def _get_schema() -> str:
    config = op.get_context().config
    return config.get_main_option("schema") or "main"


def upgrade() -> None:
    schema = _get_schema()

    # Drop and re-add both constraints idempotently.
    # IF EXISTS on DROP means this is safe even if a schema was already
    # corrected (e.g. via the live DB patch applied alongside this migration).

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "DROP CONSTRAINT IF EXISTS ck_requests_type"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "ADD CONSTRAINT ck_requests_type "
            "CHECK (type IN ('exception','leave','escalation'))"
        )
    )

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "DROP CONSTRAINT IF EXISTS ck_requests_leave_type_consistency"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "ADD CONSTRAINT ck_requests_leave_type_consistency CHECK ("
            "(type = 'leave' AND leave_type_id IS NOT NULL) "
            "OR (type IN ('exception','escalation') AND leave_type_id IS NULL)"
            ")"
        )
    )


def downgrade() -> None:
    schema = _get_schema()

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "DROP CONSTRAINT IF EXISTS ck_requests_type"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "ADD CONSTRAINT ck_requests_type "
            "CHECK (type IN ('exception','leave'))"
        )
    )

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "DROP CONSTRAINT IF EXISTS ck_requests_leave_type_consistency"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.requests "
            "ADD CONSTRAINT ck_requests_leave_type_consistency CHECK ("
            "(type = 'leave' AND leave_type_id IS NOT NULL) "
            "OR (type = 'exception' AND leave_type_id IS NULL)"
            ")"
        )
    )
