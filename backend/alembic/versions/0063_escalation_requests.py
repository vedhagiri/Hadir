"""Add escalation request type + attendance locked flag.

* Widens the ``requests.type`` CHECK to include ``'escalation'``.
* Widens the ``request_reason_categories.request_type`` CHECK similarly.
* Relaxes the leave-type consistency CHECK so escalation rows (which
  have no leave_type_id) are accepted.
* Adds two nullable columns to ``attendance_records``:
    - ``locked``  BOOLEAN DEFAULT NULL — when TRUE the attendance
      scheduler skips recomputing the row (escalation-confirmed days
      must not be silently reverted to absent by the next tick).
    - ``escalation_note``  TEXT DEFAULT NULL — stores the confirmed
      reason/comment from the escalation approval for display in the
      Day Detail drawer.
* Seeds default escalation reason categories for the ``main`` schema
  and every tenant that currently exists in ``public.tenants``.

Revision ID: 0063_esc_requests
Revises:     0062_cpr_recovery
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0063_esc_requests"
down_revision: str = "0062_cpr_recovery"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _get_schema() -> str:
    """Return the schema being migrated (set by ``-x schema=…``)."""
    config = op.get_context().config
    return config.get_main_option("schema") or "main"


# ---------------------------------------------------------------------------
# upgrade
# ---------------------------------------------------------------------------

def upgrade() -> None:
    schema = _get_schema()
    bind = op.get_bind()

    # 1. requests.type CHECK ── drop + re-add widened constraint ----------
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

    # 2. requests leave-type consistency CHECK ── drop + re-add -----------
    # Original: leave→requires leave_type_id; exception→must not have it.
    # Escalation: same as exception — no leave_type_id.
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

    # 3. request_reason_categories.request_type CHECK ─────────────────────
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.request_reason_categories "
            "DROP CONSTRAINT IF EXISTS ck_request_reason_categories_request_type"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.request_reason_categories "
            "ADD CONSTRAINT ck_request_reason_categories_request_type "
            "CHECK (request_type IN ('exception','leave','escalation'))"
        )
    )

    # 4. attendance_records — locked flag + escalation_note ───────────────
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.attendance_records "
            "ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT NULL"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.attendance_records "
            "ADD COLUMN IF NOT EXISTS escalation_note TEXT DEFAULT NULL"
        )
    )

    # 5. Seed escalation reason categories (idempotent by code) ───────────
    # Tenants registry lives in public schema (moved in migration 0008).
    tenant_id_row = bind.execute(
        sa.text(
            f"SELECT id FROM public.tenants "
            f"WHERE schema_name = :schema LIMIT 1"
        ),
        {"schema": schema},
    ).first()
    if tenant_id_row is None:
        return
    tenant_id = int(tenant_id_row[0])

    categories = [
        ("camera_missed",    "Camera missed my face",       1),
        ("camera_offline",   "Camera was offline / down",   2),
        ("different_entry",  "I used a different entrance", 3),
        ("not_in_frame",     "I was not in camera frame",   4),
        ("other_escalation", "Other",                       5),
    ]
    for code, name, order in categories:
        exists = bind.execute(
            sa.text(
                f"SELECT id FROM {schema}.request_reason_categories "
                "WHERE tenant_id = :tid AND request_type = 'escalation' "
                "AND code = :code"
            ),
            {"tid": tenant_id, "code": code},
        ).first()
        if exists is None:
            bind.execute(
                sa.text(
                    f"INSERT INTO {schema}.request_reason_categories "
                    "(tenant_id, request_type, code, name, display_order, active) "
                    "VALUES (:tid, 'escalation', :code, :name, :ord, true)"
                ),
                {"tid": tenant_id, "code": code, "name": name, "ord": order},
            )


# ---------------------------------------------------------------------------
# downgrade
# ---------------------------------------------------------------------------

def downgrade() -> None:
    schema = _get_schema()

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.attendance_records "
            "DROP COLUMN IF EXISTS escalation_note"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.attendance_records "
            "DROP COLUMN IF EXISTS locked"
        )
    )

    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.request_reason_categories "
            "DROP CONSTRAINT IF EXISTS ck_request_reason_categories_request_type"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {schema}.request_reason_categories "
            "ADD CONSTRAINT ck_request_reason_categories_request_type "
            "CHECK (request_type IN ('exception','leave'))"
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
