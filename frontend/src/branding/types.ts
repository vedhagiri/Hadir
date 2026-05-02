// Wire types for the branding API. Mirrors the Pydantic responses in
// ``maugood/branding/router.py`` and ``maugood/branding/schemas.py``.

export type BrandingPaletteKey =
  | "teal"
  | "navy"
  | "slate"
  | "forest"
  | "plum"
  | "clay"
  | "rose"
  | "amber";

export type BrandingFontKey = "inter" | "lato" | "plus-jakarta-sans";

export interface BrandingResponse {
  tenant_id: number;
  primary_color_key: BrandingPaletteKey;
  font_key: BrandingFontKey;
  has_logo: boolean;
  updated_at: string;
  // Free-form corporate display name (``public.tenants.name``).
  // Empty string when the operator hasn't set one yet — the sidebar
  // brand row falls back to "Maugood" in that case.
  display_name: string;
}

export interface BrandingPatchInput {
  primary_color_key?: BrandingPaletteKey;
  font_key?: BrandingFontKey;
  // ``undefined`` = leave the current name alone. A non-empty string
  // updates ``public.tenants.name``; the server rejects empty input.
  display_name?: string;
}

export interface BrandingPaletteEntry {
  key: BrandingPaletteKey;
  accent: string;
  accent_hover: string;
  accent_soft: string;
  accent_border: string;
  accent_text: string;
}

export interface BrandingFontEntry {
  key: BrandingFontKey;
  stack: string;
}

export interface BrandingOptions {
  palette: BrandingPaletteEntry[];
  fonts: BrandingFontEntry[];
}
