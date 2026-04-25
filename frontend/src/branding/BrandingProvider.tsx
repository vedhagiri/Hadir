// Mounts inside the authenticated shell and applies the tenant's
// branding to the document. We hold a single ``<style id="…">`` tag
// in ``document.head`` and rewrite its text content whenever
// ``useMyBranding`` returns fresh data.
//
// Keeping the override out of React's render tree means the rest of
// the SPA can keep using plain CSS — the design system reads
// ``--accent`` etc., we just override the value.

import { useEffect } from "react";

import { useBrandingOptions, useMyBranding } from "./hooks";
import type { BrandingFontEntry, BrandingPaletteEntry } from "./types";

const STYLE_TAG_ID = "hadir-branding-overrides";

function buildCss(
  palette: BrandingPaletteEntry,
  font: BrandingFontEntry,
): string {
  return [
    ":root {",
    `  --accent: ${palette.accent};`,
    `  --accent-hover: ${palette.accent_hover};`,
    `  --accent-soft: ${palette.accent_soft};`,
    `  --accent-border: ${palette.accent_border};`,
    `  --accent-text: ${palette.accent_text};`,
    "}",
    "body {",
    `  font-family: ${font.stack};`,
    "}",
  ].join("\n");
}

function ensureStyleTag(): HTMLStyleElement {
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = STYLE_TAG_ID;
    // Append last so it wins the cascade against the design CSS.
    document.head.appendChild(tag);
  }
  return tag;
}

/**
 * Mounted once near the root of the authenticated tenant shell. Reads
 * the caller's branding + the curated options map, then writes the
 * <style> block. Re-runs whenever the branding mutation cache updates.
 */
export function BrandingProvider() {
  const branding = useMyBranding();
  const options = useBrandingOptions();

  useEffect(() => {
    if (!branding.data || !options.data) return;
    const palette = options.data.palette.find(
      (p) => p.key === branding.data!.primary_color_key,
    );
    const font = options.data.fonts.find(
      (f) => f.key === branding.data!.font_key,
    );
    if (!palette || !font) return;
    ensureStyleTag().textContent = buildCss(palette, font);
  }, [branding.data, options.data]);

  return null;
}

/**
 * Test-only escape hatch for components that want to preview a
 * specific palette/font combination without going through the API.
 */
export function applyPreview(
  palette: BrandingPaletteEntry,
  font: BrandingFontEntry,
) {
  ensureStyleTag().textContent = buildCss(palette, font);
}
