"""Super-Admin role + console (v1.0 P3).

Adds three globally-visible tables in ``public``. They sit alongside
``public.tenants`` (the only other global table, P2) and never appear
in any tenant schema:

* ``public.mts_staff`` — Muscat Tech Solutions staff users. The
  authentication source for the Super-Admin console. Independent of
  the per-tenant ``users`` table (these are *operators*, not tenant
  users) and absent from the tenant role enum.
* ``public.super_admin_sessions`` — server-side sessions for MTS
  staff. Independent of ``user_sessions`` (which lives per-tenant)
  because a Super-Admin session has no home tenant — it can target
  any tenant via the impersonation hook.
* ``public.super_admin_audit`` — append-only log of every Super-Admin
  action. Tenant-context actions also write a row to the tenant's
  own ``audit_log`` (see ``hadir.auth.audit``) — this duplication is
  deliberate so tenants can see they were accessed without needing
  cross-tenant read access to the operator log.

This migration is global (operates on ``public``). It runs idempotently
(``CREATE TABLE IF NOT EXISTS`` everywhere) so the orchestrator's loop
through tenant schemas is a true no-op for tenants 2..N once it has
applied the revision against ``main``. The migration-lint whitelist
includes 0009 because hardcoding ``public`` here is intrinsic to the
operation, not an authoring shortcut.

Revision ID: 0009_super_admin
Revises: 0008_tenants_to_public
Create Date: 2026-04-25
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0009_super_admin"
down_revision: Union[str, Sequence[str], None] = "0008_tenants_to_public"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Tenant status column ----------------------------------------------
    # The Super-Admin "tenants list" surface (P3) shows status alongside
    # name/slug/admin count/employee count. ``active`` is the default;
    # ``suspended`` is set by the Super-Admin "Suspend tenant" action and
    # by ops-level interventions. Login and request middleware refuse to
    # serve a suspended tenant in P3.
    op.execute(
        """
        ALTER TABLE public.tenants
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
        """
    )
    # The CHECK constraint is added separately because PG doesn't have
    # ``ADD CONSTRAINT IF NOT EXISTS``. Wrap in a DO block.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.constraint_column_usage
                WHERE constraint_name = 'ck_tenants_status'
                  AND table_schema = 'public'
            ) THEN
                ALTER TABLE public.tenants
                ADD CONSTRAINT ck_tenants_status
                CHECK (status IN ('active','suspended'));
            END IF;
        END
        $$
        """
    )

    # --- Tables -------------------------------------------------------------
    # mts_staff: independent of the per-tenant ``users`` table. Email is
    # CITEXT so the login lookup matches case-insensitively.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mts_staff (
            id SERIAL PRIMARY KEY,
            email CITEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            full_name TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    # super_admin_sessions: opaque random TEXT id, sliding expiry, ``data``
    # JSONB carries ``impersonated_tenant_id`` when an "Access as" is
    # active. Mirrors the shape of the per-tenant ``user_sessions`` table
    # so the request-path code feels familiar.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.super_admin_sessions (
            id VARCHAR(128) PRIMARY KEY,
            mts_staff_id INTEGER NOT NULL
                REFERENCES public.mts_staff(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_super_admin_sessions_staff
            ON public.super_admin_sessions (mts_staff_id)
        """
    )

    # super_admin_audit: append-only at the grant level (see GRANTS below).
    # ``tenant_id`` is nullable for actions that don't target a specific
    # tenant (e.g. ``super_admin.login.success``).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.super_admin_audit (
            id SERIAL PRIMARY KEY,
            super_admin_user_id INTEGER NOT NULL
                REFERENCES public.mts_staff(id) ON DELETE RESTRICT,
            tenant_id INTEGER
                REFERENCES public.tenants(id) ON DELETE SET NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            before JSONB,
            after JSONB,
            ip TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_super_admin_audit_tenant
            ON public.super_admin_audit (tenant_id, created_at)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_super_admin_audit_actor
            ON public.super_admin_audit (super_admin_user_id, created_at)
        """
    )

    # --- Ownership + grants -------------------------------------------------
    # GRANT statements are idempotent in Postgres so re-running them across
    # tenant iterations is safe.
    op.execute("ALTER TABLE public.mts_staff OWNER TO hadir_admin")
    op.execute("ALTER TABLE public.super_admin_sessions OWNER TO hadir_admin")
    op.execute("ALTER TABLE public.super_admin_audit OWNER TO hadir_admin")

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.mts_staff TO hadir_app"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.super_admin_sessions "
        "TO hadir_app"
    )
    # Append-only: no UPDATE, no DELETE, no TRUNCATE for hadir_app.
    op.execute("GRANT SELECT, INSERT ON public.super_admin_audit TO hadir_app")

    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE public.mts_staff_id_seq TO hadir_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE public.super_admin_audit_id_seq TO hadir_app"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS public.super_admin_audit")
    op.execute("DROP TABLE IF EXISTS public.super_admin_sessions")
    op.execute("DROP TABLE IF EXISTS public.mts_staff")
    op.execute(
        "ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS ck_tenants_status"
    )
    op.execute("ALTER TABLE public.tenants DROP COLUMN IF EXISTS status")
