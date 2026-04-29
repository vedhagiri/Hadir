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


class BrandingPatchRequest(BaseModel):
    """Partial update — operator can change colour, font, or both."""

    primary_color_key: Optional[str] = Field(default=None)
    font_key: Optional[str] = Field(default=None)

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
