"""Cameras: split ``enabled`` into ``worker_enabled`` + ``display_enabled``,
add ``capture_config`` JSONB.

P28.5b — pre-Omran knob exposure.

The pilot's single ``cameras.enabled`` flag conflated two different
operational levers:

* "Capture worker" — should the backend be reading frames from this
  camera and recording detection events at all? (CPU + DB load)
* "Live preview" — should the Live Capture viewer surface this
  camera in its UI? (operator visibility, no backend cost)

In production these get toggled independently. An operator wants to
record without showing the feed (privacy review, sensitive area), or
hide the feed during a brief outage without losing recordings. This
migration splits the single column into two and adds the
per-camera capture knob bag.

Per-camera capture knobs (defaults match the prototype's tested
constants from ``prototype-reference/backend/capture.py``):

* ``max_faces_per_event`` (default 10) — cap on saved face crops
  per detection event/track. The single-face-per-event architecture
  in v1.0 P28 enforces this as ≤1 today; multi-face accumulation
  lands in a follow-up phase. The knob is stored, audited, and
  surfaced on the API now so the frontend + audit log are ready
  for the bigger lift.
* ``max_event_duration_sec`` (default 60) — force-close a track
  after N seconds even if still visible. Wired to the IoU tracker.
* ``min_face_quality_to_save`` (default 0.35) — quality threshold
  computed from face area, pose symmetry, and detector confidence
  (prototype's ``quality_score`` formula). Skip saving below this
  threshold. 0.35 is a Suresh-tested value — do not change without
  testing on real walk-past video.
* ``save_full_frames`` (default false) — debug aid. When true,
  alongside the encrypted face crop also save the full annotated
  frame to a sibling path. Increases disk usage roughly N× (where
  N = full frame size / face crop size, typically 4-10×).

Migration shape (data-preserving):

1. Add ``worker_enabled`` BOOL NOT NULL DEFAULT true. Backfill from
   the existing ``enabled`` column so values map 1:1.
2. Drop ``enabled``.
3. Add ``display_enabled`` BOOL NOT NULL DEFAULT true.
4. Add ``capture_config`` JSONB NOT NULL DEFAULT (the four knobs
   above with their default values).

Schema-agnostic — runs once per tenant schema via the orchestrator.
The existing pilot ``main`` schema and every multi-tenant
``tenant_<slug>`` schema get the same shape.

Idempotency: per-tenant alembic passes that re-run this revision
short-circuit when ``worker_enabled`` already exists.

Revision ID: 0027_cameras_capture_split
Revises: 0026_tenants_slug
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


revision: str = "0027_cameras_capture_split"
down_revision: Union[str, Sequence[str], None] = "0026_tenants_slug"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEFAULT_CONFIG_SQL = (
    """'{"max_faces_per_event": 10, """
    """"max_event_duration_sec": 60, """
    """"min_face_quality_to_save": 0.35, """
    """"save_full_frames": false}'::jsonb"""
)


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

    # Idempotency guard — a per-tenant alembic pass that has already
    # run this revision sees ``worker_enabled`` and short-circuits.
    if _has_column(bind, "cameras", "worker_enabled"):
        return

    # 1. Add ``worker_enabled`` nullable so we can backfill from
    #    ``enabled`` before flipping NOT NULL.
    op.add_column(
        "cameras",
        sa.Column("worker_enabled", sa.Boolean(), nullable=True),
    )
    bind.execute(text("UPDATE cameras SET worker_enabled = enabled"))
    op.alter_column(
        "cameras",
        "worker_enabled",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.text("true"),
    )

    # 2. Drop the original ``enabled`` column. Data has been moved
    #    to ``worker_enabled`` in step 1.
    op.drop_column("cameras", "enabled")

    # 3. Add ``display_enabled`` defaulting to true so existing rows
    #    keep showing in Live Capture without operator action.
    op.add_column(
        "cameras",
        sa.Column(
            "display_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )

    # 4. Add ``capture_config`` JSONB with the four knobs at their
    #    prototype-tested default values. NOT NULL so every row has
    #    a config; the server_default covers existing rows on
    #    in-place upgrade.
    op.add_column(
        "cameras",
        sa.Column(
            "capture_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text(_DEFAULT_CONFIG_SQL),
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "cameras", "worker_enabled"):
        return

    op.add_column(
        "cameras",
        sa.Column("enabled", sa.Boolean(), nullable=True),
    )
    bind.execute(text("UPDATE cameras SET enabled = worker_enabled"))
    op.alter_column(
        "cameras",
        "enabled",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.text("true"),
    )

    op.drop_column("cameras", "capture_config")
    op.drop_column("cameras", "display_enabled")
    op.drop_column("cameras", "worker_enabled")
