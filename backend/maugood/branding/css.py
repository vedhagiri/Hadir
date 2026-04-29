"""Per-tenant CSS override generation + cache.

For a given branding row, returns the small CSS block that overrides
``--accent``, ``--accent-hover``, ``--accent-soft``,
``--accent-border``, ``--accent-text``, and the ``body`` font-family.
The block is embedded into the SPA at startup via a ``<style>`` tag
appended to ``document.head`` (see
``frontend/src/branding/BrandingProvider.tsx``).

In-process cache keyed on the tuple ``(tenant_id, primary_color_key,
font_key)``. Invalidated explicitly on every PATCH / logo change —
not on a TTL. Per-process scale (one Uvicorn worker per host) is
fine for the pilot tenant count; scaling out is a v1.0+M3 problem.
"""

from __future__ import annotations

import threading
from typing import Optional

from maugood.branding.constants import (
    BRAND_PALETTE,
    DEFAULT_FONT_KEY,
    DEFAULT_PRIMARY_COLOR_KEY,
    FONT_OPTIONS,
)
from maugood.branding.repository import BrandingRow

_lock = threading.Lock()
_cache: dict[tuple[int, str, str], str] = {}


def _generate(branding: BrandingRow) -> str:
    """Return the CSS body. No caching — pure function."""

    palette_key = (
        branding.primary_color_key
        if branding.primary_color_key in BRAND_PALETTE
        else DEFAULT_PRIMARY_COLOR_KEY
    )
    font_key = (
        branding.font_key if branding.font_key in FONT_OPTIONS else DEFAULT_FONT_KEY
    )
    palette = BRAND_PALETTE[palette_key]
    font_stack = FONT_OPTIONS[font_key]

    # ``:root`` overrides the design-system defaults set in
    # ``styles.css``. Specificity matches (both are :root), the cascade
    # wins on order — our <style> mounts after the static stylesheets.
    return (
        f":root {{\n"
        f"  --accent: {palette['accent']};\n"
        f"  --accent-hover: {palette['accent_hover']};\n"
        f"  --accent-soft: {palette['accent_soft']};\n"
        f"  --accent-border: {palette['accent_border']};\n"
        f"  --accent-text: {palette['accent_text']};\n"
        f"}}\n"
        f"body {{\n"
        f"  font-family: {font_stack};\n"
        f"}}\n"
    )


def render_css(branding: BrandingRow) -> str:
    """Return the cached CSS for this branding row, generating on miss."""

    key = (branding.tenant_id, branding.primary_color_key, branding.font_key)
    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached
        css = _generate(branding)
        _cache[key] = css
        return css


def invalidate_tenant(tenant_id: int) -> None:
    """Drop every cache entry for ``tenant_id`` (called after PATCH)."""

    with _lock:
        for key in [k for k in _cache if k[0] == tenant_id]:
            _cache.pop(key, None)


def clear_cache() -> None:
    """Test-only utility to drop the entire cache."""

    with _lock:
        _cache.clear()
