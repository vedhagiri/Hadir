"""Locale resolver + dotted-key translation lookup."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import yaml

logger = logging.getLogger(__name__)


SUPPORTED_LANGUAGES: tuple[str, ...] = ("en", "ar")
DEFAULT_LANGUAGE: str = "en"

_BUNDLE_DIR = Path(__file__).parent
_BUNDLES: dict[str, dict[str, Any]] = {}


def _load_bundle(lang: str) -> dict[str, Any]:
    """Lazy-load a YAML bundle on first lookup; cache for the
    process lifetime."""

    if lang in _BUNDLES:
        return _BUNDLES[lang]
    path = _BUNDLE_DIR / f"{lang}.yaml"
    try:
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        if lang != DEFAULT_LANGUAGE:
            logger.warning(
                "i18n bundle missing: %s — falling back to %s",
                lang,
                DEFAULT_LANGUAGE,
            )
        data = {}
    _BUNDLES[lang] = data
    return data


def _walk(bundle: dict[str, Any], dotted_key: str) -> Optional[str]:
    cur: Any = bundle
    for part in dotted_key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    if isinstance(cur, str):
        return cur
    return None


def t(key: str, lang: Optional[str] = None, **fmt: Any) -> str:
    """Look up ``key`` in the resolved language bundle.

    ``lang`` defaults to the server default. Missing keys return the
    key itself so a missing translation surfaces visibly rather than
    silently falling back to English. ``fmt`` runs through
    ``str.format`` so producers can pass named placeholders.
    """

    chosen = lang if lang in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
    bundle = _load_bundle(chosen)
    text = _walk(bundle, key)
    if text is None and chosen != DEFAULT_LANGUAGE:
        # Fall back to English for the missing key, but only after
        # we've tried the chosen bundle.
        text = _walk(_load_bundle(DEFAULT_LANGUAGE), key)
    if text is None:
        return key
    if fmt:
        try:
            return text.format(**fmt)
        except (KeyError, IndexError, ValueError) as exc:
            logger.warning(
                "i18n format error for key=%s lang=%s: %s", key, chosen, exc
            )
            return text
    return text


def parse_accept_language(header: Optional[str]) -> Optional[str]:
    """Pick the highest-q match from an Accept-Language header that
    we actually support. Returns None when nothing matches.

    We don't honour regional sub-tags ("en-US" → "en"); the BRD only
    asks for two top-level languages.
    """

    if not header:
        return None
    candidates: list[tuple[float, str]] = []
    for chunk in header.split(","):
        bits = chunk.strip().split(";q=")
        tag = bits[0].strip().lower().split("-")[0]
        try:
            q = float(bits[1]) if len(bits) > 1 else 1.0
        except ValueError:
            q = 1.0
        if tag in SUPPORTED_LANGUAGES:
            candidates.append((q, tag))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def resolve_language(
    *,
    user_preference: Optional[str] = None,
    accept_language: Optional[str] = None,
) -> str:
    """User pref > Accept-Language > default. The chain matches the
    P21 prompt's stated detection order."""

    if user_preference and user_preference in SUPPORTED_LANGUAGES:
        return user_preference
    parsed = parse_accept_language(accept_language)
    if parsed is not None:
        return parsed
    return DEFAULT_LANGUAGE
