// Wire types for the branding API. Mirrors the Pydantic responses in
// ``hadir/branding/router.py`` and ``hadir/branding/schemas.py``.

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
}

export interface BrandingPatchInput {
  primary_color_key?: BrandingPaletteKey;
  font_key?: BrandingFontKey;
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
