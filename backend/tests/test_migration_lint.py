"""Migration-authoring lint (v1.0 P2).

Going forward (revision 0009 and later), every migration MUST be
schema-agnostic: no hardcoded ``schema="main"`` argument, no string
literal ``main."`` inside SQL, no ``"main".`` qualifier. The
orchestrator runs each migration once per tenant schema, so a
hardcoded schema reference would silently break isolation.

This test scans the migration files and fails the suite if any
forbidden pattern lands in a forward-going migration.

Pre-existing migrations (0001-0008) are whitelisted because they
either pre-date the rule (0001-0007 are pilot legacy, frozen) or are
the boundary migration (0008 explicitly crosses ``main`` and
``public``). Adding to the whitelist requires a deliberate code edit
and review — the goal is for the whitelist to never grow.
"""

from __future__ import annotations

import re
from pathlib import Path

# Migrations exempt from the schema-agnostic rule. Do not extend this
# list lightly; new entries must come with a written justification in
# the migration's docstring (and review approval).
_WHITELIST: frozenset[str] = frozenset(
    {
        "0001_initial.py",
        "0002_employees.py",
        "0003_cameras.py",
        "0004_capture.py",
        "0005_photo_embeddings.py",
        "0006_attendance.py",
        "0007_tenants_schema_name.py",
        "0008_tenants_to_public.py",
        # 0009 creates global tables in the public schema (mts_staff,
        # super_admin_sessions, super_admin_audit) — operating on
        # public is the migration's purpose, not an authoring shortcut.
        "0009_super_admin.py",
        # 0026 adds public.tenants.slug — the user-facing identifier
        # column is part of public.tenants by definition. Idempotency
        # guards make per-tenant re-execution safe.
        "0026_tenants_slug.py",
    }
)

# Patterns that indicate a hardcoded schema reference. Matched
# case-insensitively against the migration source.
_FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # SQLAlchemy op.* schema kwarg
    ("schema='main'", re.compile(r"""schema\s*=\s*['"]main['"]""")),
    ("schema='public'", re.compile(r"""schema\s*=\s*['"]public['"]""")),
    # SCHEMA = "main" module constants from the pilot pattern
    ("SCHEMA = 'main'", re.compile(r"""SCHEMA\s*=\s*['"]main['"]""")),
    ("SCHEMA = 'public'", re.compile(r"""SCHEMA\s*=\s*['"]public['"]""")),
    # SQL string qualifiers
    ('"main".', re.compile(r'"main"\s*\.')),
    ('"public".', re.compile(r'"public"\s*\.')),
    ("main.<table>", re.compile(r"\bmain\.[a-z_]+", re.IGNORECASE)),
    ("public.<table>", re.compile(r"\bpublic\.[a-z_]+", re.IGNORECASE)),
)


def _migration_files() -> list[Path]:
    versions_dir = Path(__file__).resolve().parent.parent / "alembic" / "versions"
    return sorted(versions_dir.glob("*.py"))


def test_migrations_directory_exists() -> None:
    files = _migration_files()
    assert files, "no migration files discovered"


def test_forward_migrations_are_schema_agnostic() -> None:
    """Every migration after the whitelist must avoid hardcoded schemas.

    Any new revision (0009+) lands here. If this fails, fix the
    migration to use unqualified table names + ``op.create_table(...)``
    without the ``schema=`` kwarg. The orchestrator sets ``search_path``
    per schema before invoking the migration — that's how the same
    migration applies to every tenant.
    """

    failures: list[str] = []

    for path in _migration_files():
        if path.name in _WHITELIST:
            continue
        source = path.read_text(encoding="utf-8")
        for label, pattern in _FORBIDDEN_PATTERNS:
            if pattern.search(source):
                failures.append(f"{path.name}: contains forbidden pattern {label!r}")

    assert not failures, (
        "schema-agnostic migration rule violated:\n  " + "\n  ".join(failures)
    )


def test_whitelist_only_contains_known_legacy_migrations() -> None:
    """Whitelist sanity: don't let a new migration sneak in by mistake."""

    files = {p.name for p in _migration_files()}
    unknown = _WHITELIST - files
    assert not unknown, (
        f"migration lint whitelist references missing files: {sorted(unknown)}"
    )
