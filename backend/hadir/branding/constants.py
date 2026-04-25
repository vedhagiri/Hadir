"""Curated branding palette + font list (v1.0 P4).

These two maps are the **only** allowed inputs for tenant branding.
Both lists are mirrored in two other places that must change in
lock-step:

1. The Postgres CHECK constraints in migration 0010 (and the
   matching ``CheckConstraint`` on ``hadir.db.tenant_branding``).
2. The frontend swatch / font picker in
   ``frontend/src/branding/BrandingForm.tsx``.

Each palette entry is an OKLCH triple — modern browsers support
``oklch()`` natively and OKLCH is what the design CSS already uses
(``frontend/src/styles/styles.css`` declares the default teal as
``oklch(0.52 0.09 195)``). All eight options were tuned for
contrast in both light and dark mode.
"""

from __future__ import annotations

from typing import TypedDict


class PaletteEntry(TypedDict):
    """The five CSS variables we override per tenant for a given key."""

    accent: str  # base accent (chip, link, button bg)
    accent_hover: str  # hover state
    accent_soft: str  # background tint (badges, soft pills)
    accent_border: str  # outlines / dividers
    accent_text: str  # foreground when accent is the background


# Curated palette — eight OKLCH options. Lightness L and chroma C are
# kept consistent across families so the visual weight is comparable;
# only hue H varies. Each value tested in both light and dark mode.
BRAND_PALETTE: dict[str, PaletteEntry] = {
    "teal": {
        "accent": "oklch(0.52 0.09 195)",
        "accent_hover": "oklch(0.46 0.09 195)",
        "accent_soft": "oklch(0.96 0.02 195)",
        "accent_border": "oklch(0.85 0.05 195)",
        "accent_text": "oklch(0.38 0.09 195)",
    },
    "navy": {
        "accent": "oklch(0.42 0.09 250)",
        "accent_hover": "oklch(0.36 0.09 250)",
        "accent_soft": "oklch(0.96 0.02 250)",
        "accent_border": "oklch(0.85 0.05 250)",
        "accent_text": "oklch(0.32 0.09 250)",
    },
    "slate": {
        "accent": "oklch(0.48 0.04 240)",
        "accent_hover": "oklch(0.42 0.04 240)",
        "accent_soft": "oklch(0.96 0.01 240)",
        "accent_border": "oklch(0.85 0.02 240)",
        "accent_text": "oklch(0.36 0.04 240)",
    },
    "forest": {
        "accent": "oklch(0.48 0.10 150)",
        "accent_hover": "oklch(0.42 0.10 150)",
        "accent_soft": "oklch(0.96 0.02 150)",
        "accent_border": "oklch(0.85 0.05 150)",
        "accent_text": "oklch(0.36 0.10 150)",
    },
    "plum": {
        "accent": "oklch(0.48 0.10 320)",
        "accent_hover": "oklch(0.42 0.10 320)",
        "accent_soft": "oklch(0.96 0.02 320)",
        "accent_border": "oklch(0.85 0.05 320)",
        "accent_text": "oklch(0.36 0.10 320)",
    },
    "clay": {
        "accent": "oklch(0.55 0.10 50)",
        "accent_hover": "oklch(0.48 0.10 50)",
        "accent_soft": "oklch(0.96 0.03 50)",
        "accent_border": "oklch(0.85 0.05 50)",
        "accent_text": "oklch(0.40 0.10 50)",
    },
    "rose": {
        "accent": "oklch(0.55 0.13 12)",
        "accent_hover": "oklch(0.48 0.13 12)",
        "accent_soft": "oklch(0.96 0.03 12)",
        "accent_border": "oklch(0.85 0.05 12)",
        "accent_text": "oklch(0.40 0.13 12)",
    },
    "amber": {
        "accent": "oklch(0.62 0.13 70)",
        "accent_hover": "oklch(0.56 0.13 70)",
        "accent_soft": "oklch(0.96 0.04 70)",
        "accent_border": "oklch(0.85 0.06 70)",
        "accent_text": "oklch(0.42 0.13 65)",
    },
}

DEFAULT_PRIMARY_COLOR_KEY = "teal"


# Three curated families. The key is what we store; the value is the
# CSS ``font-family`` stack to apply. ``index.html`` preloads each via
# Google Fonts <link> tags. No runtime font upload — BRD red line.
FONT_OPTIONS: dict[str, str] = {
    "inter": "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
    "lato": "'Lato', ui-sans-serif, system-ui, -apple-system, sans-serif",
    "plus-jakarta-sans": (
        "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif"
    ),
}

DEFAULT_FONT_KEY = "inter"


# Convenience for validation.
ALLOWED_PRIMARY_COLOR_KEYS = frozenset(BRAND_PALETTE.keys())
ALLOWED_FONT_KEYS = frozenset(FONT_OPTIONS.keys())
