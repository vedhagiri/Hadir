"""Tenant slug helpers — friendly identifier ↔ Postgres schema name.

The ``slug`` column on ``public.tenants`` is what API payloads expose
to operators (``mts_demo``); the ``schema_name`` column is the internal
Postgres identifier the engine routes connections at
(``tenant_mts_demo``). The two are linked by a one-way derivation —
provisioning takes a slug and computes a schema name; nothing in the
codebase ever does the reverse.

Slug regex (matches the migration 0026 CHECK constraint exactly):
``^[a-z][a-z0-9_-]{1,39}$``. Lowercase letters / digits / hyphens /
underscores; must start with a letter; total length 2-40. ``citext``
storage means the lookup is case-insensitive at the DB layer.

Postgres schema names cannot contain unquoted hyphens, so the
derivation rewrites hyphens in slugs to underscores
(``acme-corp`` → ``tenant_acme_corp``).
"""

from __future__ import annotations

import re

# Lowercase letters/digits/hyphens/underscores; must start with a
# letter; total length 2-40 (matches migration 0026's CHECK).
SLUG_RE = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")


def schema_name_for_slug(slug: str) -> str:
    """Derive the Postgres schema name a tenant with ``slug`` lives in.

    Pilot's ``main`` schema is left as-is — that row pre-dates the
    ``tenant_<slug>`` convention and renaming it would require a
    schema rename + every per-tenant migration to be re-stamped.

    For every other slug, prepend ``tenant_`` and replace any hyphens
    with underscores so the result is a bare Postgres identifier
    (no quoting required at SQL build sites).
    """

    if not SLUG_RE.match(slug):
        raise ValueError(
            f"invalid slug {slug!r}: must match {SLUG_RE.pattern}"
        )
    if slug == "main":
        return "main"
    return "tenant_" + slug.replace("-", "_")
