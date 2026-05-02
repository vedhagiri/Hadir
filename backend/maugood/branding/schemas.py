"""Pydantic schemas for the branding API."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from maugood.branding.constants import ALLOWED_FONT_KEYS, ALLOWED_PRIMARY_COLOR_KEYS


class BrandingResponse(BaseModel):
    """What the GET endpoint returns to the frontend."""

    tenant_id: int
    primary_color_key: str
    font_key: str
    has_logo: bool
    updated_at: str
    # Display name lives in ``public.tenants.name`` rather than
    # ``tenant_branding`` (it predates the branding feature) but the
    # branding form is the natural surface for editing it, so we
    # surface it here. Empty string until the operator's setup wizard
    # or branding form fills it in — the sidebar falls back to the
    # product name in that case.
    display_name: str = ""


class BrandingPatchRequest(BaseModel):
    """Partial update — operator can change colour, font, display
    name, or any combination. ``None`` on a field means "leave as-is";
    an explicit value updates it."""

    primary_color_key: Optional[str] = Field(default=None)
    font_key: Optional[str] = Field(default=None)
    # Free-form corporate display name (max 200 chars to match the
    # super-admin tenant create form). Operators set it through the
    # tenant Branding page; ``None`` leaves the existing value alone.
    display_name: Optional[str] = Field(default=None, max_length=200)

    def validated_color(self) -> Optional[str]:
        if self.primary_color_key is None:
            return None
        key = self.primary_color_key.strip()
        if key not in ALLOWED_PRIMARY_COLOR_KEYS:
            raise ValueError(
                f"primary_color_key must be one of {sorted(ALLOWED_PRIMARY_COLOR_KEYS)}"
            )
        return key

    def validated_font(self) -> Optional[str]:
        if self.font_key is None:
            return None
        key = self.font_key.strip()
        if key not in ALLOWED_FONT_KEYS:
            raise ValueError(
                f"font_key must be one of {sorted(ALLOWED_FONT_KEYS)}"
            )
        return key

    def validated_display_name(self) -> Optional[str]:
        """``None`` → no change. Empty string after stripping → reject
        (we never want a blank display name; the operator can clear
        their own customisation by leaving the field alone instead)."""

        if self.display_name is None:
            return None
        stripped = self.display_name.strip()
        if not stripped:
            raise ValueError("display_name cannot be empty")
        return stripped
