"""Add 5 more escalation reason categories (display_order 6–10).

Revision ID: 0064_esc_cats_extra
Revises:     0063_esc_requests
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0064_esc_cats_extra"
down_revision: str = "0063_esc_requests"
branch_labels = None
depends_on = None


def _get_schema() -> str:
    config = op.get_context().config
    return config.get_main_option("schema") or "main"


def upgrade() -> None:
    schema = _get_schema()
    bind = op.get_bind()

    tenant_row = bind.execute(
        sa.text(
            "SELECT id FROM public.tenants WHERE schema_name = :schema LIMIT 1"
        ),
        {"schema": schema},
    ).first()
    if tenant_row is None:
        return
    tenant_id = int(tenant_row[0])

    new_categories = [
        ("working_remote",     "I was working remotely / off-site",             6),
        ("system_error",       "Technical / system error on that day",           7),
        ("photo_outdated",     "My reference photo is outdated or missing",      8),
        ("different_area",     "I was in a different area of the building",      9),
        ("supervisor_confirm", "My supervisor can confirm my presence",          10),
    ]

    for code, name, order in new_categories:
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


def downgrade() -> None:
    schema = _get_schema()
    bind = op.get_bind()

    for code in (
        "working_remote",
        "system_error",
        "photo_outdated",
        "different_area",
        "supervisor_confirm",
    ):
        bind.execute(
            sa.text(
                f"DELETE FROM {schema}.request_reason_categories "
                "WHERE request_type = 'escalation' AND code = :code"
            ),
            {"code": code},
        )
