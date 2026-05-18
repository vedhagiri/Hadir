// Brand chip rendered next to each camera in lists and in the
// Add/Edit drawer. The component first tries to render the brand's
// real logo image from ``frontend/public/brand-logos/{slug}.{ext}``
// (trying SVG → PNG → WEBP → JPG in that order), and falls back to a
// coloured-initial chip for known brands when no file exists, or a
// neutral generic-camera icon for unknown / Others / null.
//
// Logo files are intentionally NOT committed for trademark reasons —
// drop the operator-supplied SVG/PNG/WEBP/JPG into
// ``frontend/public/brand-logos/`` using a lowercase slug as the
// filename (``hikvision.png``, ``cp-plus.webp``, ``dahua.jpg``, …).
// The component picks them up on the next page load.

import { useEffect, useState } from "react";

import { Icon } from "../../shell/Icon";

interface BrandStyle {
  bg: string;
  fg: string;
  initial: string;
}

// Brand-recognisable corporate colours used by the fallback chip when
// no image file is present yet. Initials chosen for unambiguous
// visual recognition at the size we render the chip.
const BRAND_STYLES: Record<string, BrandStyle> = {
  samsung: { bg: "#1428A0", fg: "#FFFFFF", initial: "S" },
  hikvision: { bg: "#C8102E", fg: "#FFFFFF", initial: "H" },
  dahua: { bg: "#003C71", fg: "#FFFFFF", initial: "D" },
  "cp plus": { bg: "#F37021", fg: "#FFFFFF", initial: "CP" },
  cpplus: { bg: "#F37021", fg: "#FFFFFF", initial: "CP" },
  imou: { bg: "#00B0FF", fg: "#FFFFFF", initial: "I" },
  axis: { bg: "#1A1A1A", fg: "#FFFFFF", initial: "A" },
  panasonic: { bg: "#0061AA", fg: "#FFFFFF", initial: "P" },
};

interface Props {
  brand: string | null | undefined;
  size?: number;
  /** When true, places the brand name next to the chip. */
  showLabel?: boolean;
}

function slugFor(brand: string): string {
  return brand
    .trim()
    .toLowerCase()
    .replace(/[\s/_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// Ext chain — onError walks forward through this list, then to the
// letter-chip fallback. Order matters: SVG first (cheapest decode),
// raster formats afterwards.
const EXT_CHAIN = ["svg", "png", "webp", "jpg", "jpeg"] as const;
type ExtIndex = number; // index into EXT_CHAIN; out-of-range = fallback

export function BrandLogo({ brand, size = 24, showLabel = false }: Props) {
  const trimmed = (brand ?? "").trim();
  const key = trimmed.toLowerCase();
  const style = BRAND_STYLES[key];
  const slug = trimmed ? slugFor(trimmed) : null;

  // Walk through extensions on each onError. State is keyed on slug
  // so swapping brands in the drawer resets the attempt cycle.
  const [extIndex, setExtIndex] = useState<ExtIndex>(0);
  useEffect(() => {
    setExtIndex(0);
  }, [slug]);

  const renderShell = (child: React.ReactNode, ariaLabel: string) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: showLabel ? 8 : 0,
      }}
    >
      <span
        aria-label={ariaLabel}
        title={ariaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: size,
          minWidth: size,
          maxWidth: size * 3,
          flexShrink: 0,
        }}
      >
        {child}
      </span>
      {showLabel && (
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {trimmed || "Generic"}
        </span>
      )}
    </span>
  );

  // 1) Try the real brand image first — walks SVG → PNG → WEBP →
  //    JPG via onError; falls through to the chip when none exist.
  if (slug && extIndex < EXT_CHAIN.length) {
    const ext = EXT_CHAIN[extIndex];
    return renderShell(
      <img
        key={`${slug}-${ext}`}
        src={`/brand-logos/${slug}.${ext}`}
        alt={`${trimmed} logo`}
        onError={() => setExtIndex((i) => i + 1)}
        style={{
          display: "block",
          height: size,
          width: "auto",
          maxWidth: size * 3,
          objectFit: "contain",
        }}
      />,
      `Brand: ${trimmed}`,
    );
  }

  // 2) Coloured-initial chip when the brand is known but no logo
  //    file is on disk.
  if (style) {
    const fontSize =
      style.initial.length === 1
        ? Math.round(size * 0.52)
        : Math.round(size * 0.42);
    return renderShell(
      <span
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
          fontFamily: "var(--font-display, system-ui)",
          lineHeight: 1,
        }}
      >
        {style.initial}
      </span>,
      `Brand: ${trimmed}`,
    );
  }

  // 3) "Others" / null / unknown brand — neutral generic-camera icon.
  return renderShell(
    <span
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
      }}
    >
      <Icon name="camera" size={Math.round(size * 0.55)} />
    </span>,
    trimmed ? `Brand: ${trimmed}` : "Generic camera",
  );
}
