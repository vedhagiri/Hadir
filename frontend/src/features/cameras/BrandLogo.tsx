// Brand chip rendered next to each camera in lists. The Add/Edit
// drawer offers a curated dropdown (BRAND_OPTIONS in types.ts) and
// stores the chosen value as a free-form string on cameras.brand.
//
// We use SVG-based brand chips with each vendor's signature accent
// colour rather than embedding their actual trademarked logos —
// that avoids any IP question while still giving the operator a
// distinct visual cue per brand. "Others" / null falls back to a
// generic camera icon in a neutral colour.

import { Icon } from "../../shell/Icon";

interface BrandStyle {
  bg: string;
  fg: string;
  initial: string;
}

// Brand-recognisable corporate colours. Pulled from each vendor's
// public brand guidelines. Initials chosen for unambiguous visual
// recognition at the size we render the chip.
const BRAND_STYLES: Record<string, BrandStyle> = {
  samsung: { bg: "#1428A0", fg: "#FFFFFF", initial: "S" },
  hikvision: { bg: "#C8102E", fg: "#FFFFFF", initial: "H" },
  dahua: { bg: "#003C71", fg: "#FFFFFF", initial: "D" },
  "cp plus": { bg: "#F37021", fg: "#FFFFFF", initial: "CP" },
  cpplus: { bg: "#F37021", fg: "#FFFFFF", initial: "CP" },
  axis: { bg: "#1A1A1A", fg: "#FFFFFF", initial: "A" },
  panasonic: { bg: "#0061AA", fg: "#FFFFFF", initial: "P" },
};

interface Props {
  brand: string | null | undefined;
  size?: number;
  /** When true, places the brand name next to the chip. */
  showLabel?: boolean;
}

export function BrandLogo({ brand, size = 24, showLabel = false }: Props) {
  const key = (brand ?? "").trim().toLowerCase();
  const style = BRAND_STYLES[key];

  if (!style) {
    // "Others" / null / unknown brand — generic camera icon in a
    // neutral chip. Same dimensions as the branded chip so list
    // alignment stays consistent.
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: showLabel ? 8 : 0,
        }}
      >
        <span
          aria-label={brand ? `Brand: ${brand}` : "Generic camera"}
          title={brand ? `Brand: ${brand}` : "Generic camera"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: size,
            height: size,
            borderRadius: 4,
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          <Icon name="camera" size={Math.round(size * 0.55)} />
        </span>
        {showLabel && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {brand ?? "Generic"}
          </span>
        )}
      </span>
    );
  }

  // Tighter font for two-letter initials so "CP" doesn't overflow.
  const fontSize =
    style.initial.length === 1
      ? Math.round(size * 0.52)
      : Math.round(size * 0.42);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: showLabel ? 8 : 0,
      }}
    >
      <span
        aria-label={`Brand: ${brand}`}
        title={`Brand: ${brand}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: 4,
          background: style.bg,
          color: style.fg,
          fontWeight: 700,
          fontSize,
          letterSpacing: style.initial.length === 1 ? 0 : "-0.02em",
          flexShrink: 0,
          fontFamily: "var(--font-display, system-ui)",
          lineHeight: 1,
        }}
      >
        {style.initial}
      </span>
      {showLabel && (
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {brand}
        </span>
      )}
    </span>
  );
}
