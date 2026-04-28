"""``cameras.camera_code`` (running number) + ``cameras.zone`` columns.

Operator ask: every camera should have a stable human-readable code
(CAM-001, CAM-002, …) generated on add, and a zone tag (Entry / Exit
/ Lobby / Parking / Office / Outdoor / Other) so the list page can
group + filter visually. Both are tenant-scoped.

* ``camera_code`` is auto-assigned on create as ``CAM-{N:03d}`` where
  ``N`` is the next available sequence within the tenant. Existing
  rows get backfilled in this migration using their ``id`` as the
  seed (so an old camera_id=2 becomes ``CAM-002``). Operator can
  edit the code later via PATCH; uniqueness is enforced per-tenant.
* ``zone`` is nullable; the form's predefined choices are
  presentation-only — no DB CHECK so a future tenant can extend the
  list without a migration.

Schema-agnostic: ``cameras`` lives per tenant, so the migration runs
under each tenant schema via the orchestrator.

Revision ID: 0034_cameras_code_zone
Revises: 0033_cameras_detection_enabled
Create Date: 2026-04-28
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


revision: str = "0034_cameras_code_zone"
down_revision: Union[str, Sequence[str], None] = "0033_cameras_detection_enabled"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


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

    # Idempotent — once both columns exist, every per-tenant pass is
    # a no-op. We may have to run this migration repeatedly per tenant
    # in multi-mode, so the partial state guard matters.
    if not _has_column(bind, "cameras", "camera_code"):
        # Nullable on the DB side — the API path always populates the
        # column via repository.create_camera (auto-generates CAM-NNN
        # when the operator doesn't supply one), but the column stays
        # nullable so test helpers + ad-hoc SQL inserts don't have to
        # know about it. Postgres treats NULLs as distinct for unique
        # constraints, so multiple null rows coexist.
        op.add_column(
            "cameras",
            sa.Column("camera_code", sa.Text(), nullable=True),
        )
        # Backfill existing rows so the API list view shows a code.
        bind.execute(
            text(
                "UPDATE cameras "
                "SET camera_code = 'CAM-' || lpad(id::text, 3, '0') "
                "WHERE camera_code IS NULL"
            )
        )
        op.create_unique_constraint(
            "uq_cameras_tenant_code",
            "cameras",
            ["tenant_id", "camera_code"],
        )

    if not _has_column(bind, "cameras", "zone"):
        op.add_column(
            "cameras",
            sa.Column("zone", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "cameras", "zone"):
        op.drop_column("cameras", "zone")
    if _has_column(bind, "cameras", "camera_code"):
        op.drop_constraint(
            "uq_cameras_tenant_code", "cameras", type_="unique"
        )
        op.drop_column("cameras", "camera_code")
