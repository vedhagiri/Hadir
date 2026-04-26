"""Separate ``tenants.slug`` (user-facing) from ``schema_name`` (internal).

The pilot conflated two distinct concepts under
``public.tenants.schema_name``:

1. The Postgres schema name used for ``SET search_path`` — internal
   routing, must satisfy the Postgres identifier rules
   (``^[A-Za-z_][A-Za-z0-9_]{0,62}$``, no hyphens).
2. The opaque tenant identifier the API payload calls ``tenant_slug`` —
   user-facing, what an operator types into the login form or
   credentials.txt.

Login matched the request body's ``tenant_slug`` against
``schema_name``, which forced operators to type the literal Postgres
schema (``tenant_mts_demo``) when the friendly form (``mts_demo``)
would have been more natural. This migration introduces a dedicated
``slug`` column so the two concerns can diverge cleanly: API takes
``slug``; the row's ``schema_name`` is read out post-resolution and
used for the ``SET search_path`` that follows.

Backfill rule (operator-deterministic, fail-loud):

* If ``schema_name`` starts with ``tenant_``: ``slug`` = strip prefix
  (``tenant_mts_demo`` → ``mts_demo``).
* Otherwise: ``slug`` = ``schema_name`` as-is. The pilot's row
  (``schema_name='main'``) lands here — ``main`` is itself a valid
  friendly slug per the new regex.
* If the candidate fails the slug regex, the migration raises and the
  upgrade aborts. Don't silently coerce — operator must intervene.

Slug regex: ``^[a-z][a-z0-9_-]{1,39}$``. Lowercase letters / digits /
hyphens / underscores; must start with a letter; total length 2–40.
Stored as ``citext`` so the lookup (``WHERE slug = 'MTS_Demo'``) is
case-insensitive without needing ``LOWER()`` on every call site —
matches what we already do for ``users.email``.

This migration touches ``public.tenants`` only — global, runs once per
DB cluster. It is idempotent (per-tenant alembic passes that re-execute
this revision against their own ``alembic_version`` see the column
already present and short-circuit). On the lint whitelist for the same
reason 0009 is: operating on ``public`` is the migration's purpose,
not an authoring shortcut.

Revision ID: 0026_tenants_slug
Revises: 0025_audit_log_actor_label
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = "0026_tenants_slug"
down_revision: Union[str, Sequence[str], None] = "0025_audit_log_actor_label"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SLUG_REGEX = r"^[a-z][a-z0-9_-]{1,39}$"


def upgrade() -> None:
    bind = op.get_bind()

    # Idempotency guard: per-tenant alembic passes will hit this same
    # revision against their own version table. Once any pass has added
    # the column, every subsequent pass is a no-op.
    has_col = bind.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "  AND table_name   = 'tenants' "
            "  AND column_name  = 'slug'"
        )
    ).scalar()
    if has_col:
        return

    # 1. Add the column nullable so we can backfill before flipping
    #    NOT NULL. citext keeps the lookup case-insensitive (matches
    #    users.email's pattern).
    bind.execute(text('ALTER TABLE public.tenants ADD COLUMN slug citext'))

    # 2. Backfill — strip a leading ``tenant_`` prefix if present;
    #    otherwise use schema_name verbatim. The Postgres function
    #    ``regexp_replace`` returns the original string when the
    #    pattern doesn't match, which is the behaviour we want for
    #    the pilot row (schema_name='main' → slug='main').
    bind.execute(
        text(
            "UPDATE public.tenants "
            "SET slug = regexp_replace(schema_name, '^tenant_', '')"
        )
    )

    # 3. Validate every backfilled value. Anything that doesn't match
    #    the new regex is operator-fixable (rename the row in
    #    public.tenants before re-running) — fail loudly here so the
    #    operator sees the bad value(s) instead of finding out at
    #    login time.
    bad_rows = bind.execute(
        text(
            "SELECT id, schema_name, slug "
            "FROM public.tenants "
            "WHERE slug !~ :rx"
        ),
        {"rx": _SLUG_REGEX},
    ).all()
    if bad_rows:
        details = ", ".join(
            f"id={r.id} schema_name={r.schema_name!r} candidate={r.slug!r}"
            for r in bad_rows
        )
        raise RuntimeError(
            "0026_tenants_slug: backfill produced invalid slug(s) — "
            "fix public.tenants.schema_name to derive a valid slug "
            "(lowercase letters/digits/hyphens/underscores; start with "
            "a letter; 2-40 chars), then re-run. Offending rows: "
            f"{details}"
        )

    # 4. Lock the column down — NOT NULL + UNIQUE + format CHECK.
    bind.execute(text("ALTER TABLE public.tenants ALTER COLUMN slug SET NOT NULL"))
    bind.execute(
        text("ALTER TABLE public.tenants ADD CONSTRAINT uq_tenants_slug UNIQUE (slug)")
    )
    bind.execute(
        text(
            "ALTER TABLE public.tenants "
            "ADD CONSTRAINT ck_tenants_slug_format "
            f"CHECK (slug ~ '{_SLUG_REGEX}')"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    has_col = bind.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "  AND table_name   = 'tenants' "
            "  AND column_name  = 'slug'"
        )
    ).scalar()
    if not has_col:
        return
    bind.execute(
        text("ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS ck_tenants_slug_format")
    )
    bind.execute(
        text("ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS uq_tenants_slug")
    )
    bind.execute(text("ALTER TABLE public.tenants DROP COLUMN slug"))
