"""Device push ingest — token registry, nullable pull fields, event dedup.

Flips device registration from *pull* (Maugood dials the terminal, needing
IP + port + credentials) to *push* (the terminal posts events to a URL we
generate). See ``docs/design/device-push-ingest-plan.md``.

**Deliberate `public` reference — the reason this migration is on the
lint whitelist.** The ingest endpoint is anonymous: a terminal posts with
no session cookie and no tenant hint, so we must map its token to a tenant
*before* any schema can be selected. That lookup cannot live in a
per-tenant schema. ``public.device_push_tokens`` is therefore a global
routing table holding only ``token → (tenant, device)`` — no attendance
data of any kind. Creation is guarded with ``IF NOT EXISTS`` because the
orchestrator runs every migration once per tenant schema.

Changes:

* ``public.device_push_tokens`` — global token → tenant/device registry.
* ``attendance_devices``       — push token columns; ``host`` / ``port`` /
  ``credentials_encrypted`` / ``serial_number`` relaxed to NULL (a push
  device has none of them until its first event).
* ``device_attendance_events`` — ``dedup_key`` replaces the serial-only
  uniqueness, because a terminal's ``serialNo`` counter restarts at zero
  after a factory reset and would otherwise silently swallow new events.
* ``device_users``             — discovery bookkeeping, since push devices
  never expose a user list to sync.

Revision ID: 0096_device_push_tokens
Revises: 0095_device_users_events
Create Date: 2026-08-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0096_device_push_tokens"
down_revision: Union[str, None] = "0095_device_users_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Global token registry (public). Idempotent: this migration runs
    # once per tenant schema but the table is shared.
    # ------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.device_push_tokens (
            token_hash    TEXT PRIMARY KEY,
            tenant_id     INTEGER NOT NULL REFERENCES public.tenants(id)
                          ON DELETE CASCADE,
            tenant_schema TEXT NOT NULL,
            device_id     INTEGER NOT NULL,
            revoked_at    TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_device_push_tokens_tenant_device
            ON public.device_push_tokens (tenant_id, device_id)
        """
    )
    op.execute("ALTER TABLE public.device_push_tokens OWNER TO maugood_admin")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_push_tokens "
        "TO maugood_app"
    )

    # ------------------------------------------------------------------
    # attendance_devices — push columns + relax the pull-only fields.
    # ------------------------------------------------------------------
    op.add_column(
        "attendance_devices",
        sa.Column("push_token_hash", sa.Text(), nullable=True),
    )
    op.add_column(
        "attendance_devices",
        sa.Column("push_token_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "attendance_devices",
        sa.Column(
            "connection_mode",
            sa.Text(),
            nullable=False,
            server_default="push",
        ),
    )
    op.add_column(
        "attendance_devices",
        sa.Column("reported_device_name", sa.Text(), nullable=True),
    )
    op.add_column(
        "attendance_devices",
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "attendance_devices",
        sa.Column(
            "clock_suspect",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_unique_constraint(
        "uq_attendance_devices_push_token",
        "attendance_devices",
        ["push_token_hash"],
    )
    op.create_check_constraint(
        "ck_attendance_devices_connection_mode",
        "attendance_devices",
        "connection_mode IN ('push', 'pull', 'both')",
    )

    # Anything registered before this migration was, by definition, a
    # pull device — keep it behaving exactly as it did.
    op.execute("UPDATE attendance_devices SET connection_mode = 'pull'")

    # A push device has no address and no credentials, and does not
    # reveal its serial until the first event arrives.
    op.alter_column("attendance_devices", "host", nullable=True)
    op.alter_column("attendance_devices", "port", nullable=True)
    op.alter_column("attendance_devices", "credentials_encrypted", nullable=True)
    op.alter_column("attendance_devices", "serial_number", nullable=True)

    # ------------------------------------------------------------------
    # device_attendance_events — dedup that survives a counter reset.
    # ------------------------------------------------------------------
    op.add_column(
        "device_attendance_events",
        sa.Column("dedup_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "device_attendance_events",
        sa.Column("person_name", sa.Text(), nullable=True),
    )
    op.add_column(
        "device_attendance_events",
        sa.Column(
            "clock_suspect",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(
        """
        UPDATE device_attendance_events
           SET dedup_key = encode(
                 sha256(
                   (device_id::text || '|' || event_serial || '|'
                    || occurred_at::text)::bytea
                 ), 'hex')
         WHERE dedup_key IS NULL
        """
    )
    op.alter_column("device_attendance_events", "dedup_key", nullable=False)
    op.drop_constraint(
        "uq_device_events_tenant_device_serial",
        "device_attendance_events",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_device_events_tenant_dedup",
        "device_attendance_events",
        ["tenant_id", "dedup_key"],
    )

    # ------------------------------------------------------------------
    # device_users — discovered-from-events bookkeeping.
    # ------------------------------------------------------------------
    op.add_column(
        "device_users",
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "device_users",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "device_users",
        sa.Column(
            "taps_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
    )
    op.add_column(
        "device_users",
        sa.Column("source", sa.Text(), nullable=False, server_default="sync"),
    )
    op.create_check_constraint(
        "ck_device_users_source",
        "device_users",
        "source IN ('sync', 'events')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_device_users_source", "device_users", type_="check")
    op.drop_column("device_users", "source")
    op.drop_column("device_users", "taps_count")
    op.drop_column("device_users", "last_seen_at")
    op.drop_column("device_users", "first_seen_at")

    op.drop_constraint(
        "uq_device_events_tenant_dedup", "device_attendance_events", type_="unique"
    )
    op.create_unique_constraint(
        "uq_device_events_tenant_device_serial",
        "device_attendance_events",
        ["tenant_id", "device_id", "event_serial"],
    )
    op.drop_column("device_attendance_events", "clock_suspect")
    op.drop_column("device_attendance_events", "person_name")
    op.drop_column("device_attendance_events", "dedup_key")

    op.alter_column("attendance_devices", "serial_number", nullable=False)
    op.alter_column("attendance_devices", "credentials_encrypted", nullable=False)
    op.alter_column("attendance_devices", "port", nullable=False)
    op.alter_column("attendance_devices", "host", nullable=False)
    op.drop_constraint(
        "ck_attendance_devices_connection_mode",
        "attendance_devices",
        type_="check",
    )
    op.drop_constraint(
        "uq_attendance_devices_push_token", "attendance_devices", type_="unique"
    )
    op.drop_column("attendance_devices", "clock_suspect")
    op.drop_column("attendance_devices", "last_event_at")
    op.drop_column("attendance_devices", "reported_device_name")
    op.drop_column("attendance_devices", "connection_mode")
    op.drop_column("attendance_devices", "push_token_encrypted")
    op.drop_column("attendance_devices", "push_token_hash")

    # public.device_push_tokens is global; dropping it from a per-tenant
    # downgrade would take every other tenant's routing with it.
