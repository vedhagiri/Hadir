"""P21 — best-effort JSX hardcoded-English-string lint.

Flags ``>Some Text<`` or ``placeholder="Some Text"`` patterns inside
``frontend/src/**/*.tsx`` for the surfaces this phase already
translated. The intent is to catch *new* additions that slip through;
existing pages we haven't gotten to yet are explicitly allow-listed
below so the test can land green and stay actionable.

The lint deliberately uses a heuristic — multi-word title-case or
sentence-case English text inside JSX — rather than an AST parser,
because a TSX parser would balloon dependencies. False positives are
expected; the allow-list is the escape hatch.
"""

from __future__ import annotations

from pathlib import Path
import re

import pytest


_REPO = Path(__file__).resolve().parents[2]
# Two ways the frontend tree can show up:
# 1. Working in a host clone — ``../../frontend/src`` (repo layout).
# 2. Inside the backend container — ``/frontend/src`` (read-only
#    mount declared in docker-compose.yml).
_CANDIDATE_ROOTS = (
    _REPO / "frontend" / "src",
    Path("/frontend") / "src",
)
_FRONTEND_SRC: Path | None = next((p for p in _CANDIDATE_ROOTS if p.exists()), None)

# Files we've fully translated as part of P21. Lint runs against these.
_TRANSLATED_FILES = (
    "shell/Topbar.tsx",
    "shell/LanguageSwitcher.tsx",
    "shell/Sidebar.tsx",
    "auth/LoginPage.tsx",
    "notifications/NotificationBell.tsx",
    "notifications/NotificationsPage.tsx",
    "notifications/PreferencesPage.tsx",
    "requests/ApprovalsPage.tsx",
    "requests/MyRequestsPage.tsx",
    "settings/SettingsTabs.tsx",
)

# Strings that legitimately stay as-is — brand names, codes,
# punctuation, or interface tokens we don't translate. Matching
# is exact: a line containing one of these substrings is excused.
_ALLOW_SUBSTRINGS = (
    "Hadir",  # brand
    "v0.1",
    "v1.0",
    "ح",  # Arabic brand mark glyph used as a logo
    "PROJECT_CONTEXT",
    "TODO",
    "BRD",
)


# JSX text node: ``>(some english here)<`` not containing braces/tags.
_JSX_TEXT_RE = re.compile(r">([^<>{}\n]{2,})<")
# JSX prop literal: ``placeholder="..."``, ``title="..."``, ``aria-label="..."``.
_JSX_ATTR_RE = re.compile(
    r'(?:placeholder|title|aria-label)="([^"\n]{2,})"'
)
# Heuristic for "looks like English prose" — at least one space, at
# least one ASCII letter, and not ALL-CAPS / not pure punctuation.
_LOOKS_ENGLISH_RE = re.compile(r"^(?=.*[A-Za-z])(?=.* )[A-Za-z][A-Za-z .,!?:'·…→#%&/-]+$")


def _scan(path: Path) -> list[tuple[int, str]]:
    """Return ``(line_no, snippet)`` of suspect literals."""

    findings: list[tuple[int, str]] = []
    text = path.read_text(encoding="utf-8")
    for line_no, line in enumerate(text.splitlines(), start=1):
        # Skip comments cheaply — prose in code comments is fine.
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        for m in _JSX_TEXT_RE.findall(line):
            candidate = m.strip()
            if _is_suspect(candidate):
                findings.append((line_no, candidate))
        for m in _JSX_ATTR_RE.findall(line):
            candidate = m.strip()
            if _is_suspect(candidate):
                findings.append((line_no, candidate))
    return findings


def _is_suspect(candidate: str) -> bool:
    if any(skip in candidate for skip in _ALLOW_SUBSTRINGS):
        return False
    if not _LOOKS_ENGLISH_RE.match(candidate):
        return False
    # Single short word like "Loading" or "Save" → caught by the
    # space requirement above already. Multi-word phrases survive.
    return True


@pytest.mark.parametrize("relpath", _TRANSLATED_FILES)
def test_no_hardcoded_english_in_translated_files(relpath: str) -> None:
    if _FRONTEND_SRC is None:
        pytest.skip("frontend tree not mounted; lint runs in compose only")
    path = _FRONTEND_SRC / relpath
    assert path.exists(), f"missing translated file: {path}"
    findings = _scan(path)
    assert not findings, (
        f"{relpath} has hardcoded English JSX strings — wrap them "
        f"in t(...) or add to the allow-list:\n"
        + "\n".join(f"  line {ln}: {snip}" for ln, snip in findings)
    )
