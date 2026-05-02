// Shared branding editor. The same component renders for the tenant
// Admin (caller's tenant) and for the Super-Admin tenant detail
// "Branding" tab (operator targets a specific tenant). The mode is
// controlled by props.
//
// Design intent: live preview of the chosen palette + font alongside
// a sample button / header / paragraph block. The picker is **only**
// the curated palette + curated fonts — there is no free-form hex
// input, no font upload (BRD FR-BRD-002).

import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client";
import {
  useBrandingOptions,
} from "./hooks";
import type {
  BrandingFontEntry,
  BrandingFontKey,
  BrandingPaletteEntry,
  BrandingPaletteKey,
  BrandingResponse,
} from "./types";

interface Props {
  branding: BrandingResponse;
  /** Logo URL for the GET endpoint that serves this tenant's logo. */
  logoUrl: string;
  onPatch: (input: {
    primary_color_key?: BrandingPaletteKey;
    font_key?: BrandingFontKey;
  }) => Promise<BrandingResponse>;
  onLogoUpload: (file: File) => Promise<BrandingResponse>;
  onLogoDelete: () => Promise<void>;
  /**
   * If true, applying changes also triggers an immediate document-wide
   * preview of the new palette/font. The tenant-side form sets this so
   * an Admin sees their shell update on Save without waiting for a
   * reload. The Super-Admin form leaves it false because the operator
   * is editing *another* tenant's branding from inside the console.
   */
  applyToDocument?: boolean;
}

export function BrandingForm({
  branding,
  logoUrl,
  onPatch,
  onLogoUpload,
  onLogoDelete,
  applyToDocument = false,
}: Props) {
  const options = useBrandingOptions();
  const [primaryKey, setPrimaryKey] = useState<BrandingPaletteKey>(
    branding.primary_color_key,
  );
  const [fontKey, setFontKey] = useState<BrandingFontKey>(branding.font_key);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoCacheBust, setLogoCacheBust] = useState<number>(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Reset local state if the persisted branding changes (e.g. after
  // a successful save the parent re-renders with fresh data).
  useEffect(() => {
    setPrimaryKey(branding.primary_color_key);
    setFontKey(branding.font_key);
  }, [branding.primary_color_key, branding.font_key]);

  if (options.isLoading) {
    return <p style={{ color: "var(--text-tertiary)" }}>Loading branding options…</p>;
  }
  if (options.error || !options.data) {
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load branding options. Try reloading the page.
      </p>
    );
  }

  const palette = options.data.palette;
  const fonts = options.data.fonts;
  const selectedPalette =
    palette.find((p) => p.key === primaryKey) ?? palette[0]!;
  const selectedFont = fonts.find((f) => f.key === fontKey) ?? fonts[0]!;

  const dirty =
    primaryKey !== branding.primary_color_key || fontKey !== branding.font_key;

  const onSave = async () => {
    setServerError(null);
    setBusy(true);
    try {
      const patch: { primary_color_key?: BrandingPaletteKey; font_key?: BrandingFontKey } = {};
      if (primaryKey !== branding.primary_color_key)
        patch.primary_color_key = primaryKey;
      if (fontKey !== branding.font_key) patch.font_key = fontKey;
      await onPatch(patch);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setServerError(
          typeof body?.detail === "string"
            ? body.detail
            : `Save failed (${err.status}).`,
        );
      } else {
        setServerError("Save failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onPickLogo = () => fileInput.current?.click();

  const onLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    if (file.size > 2 * 1024 * 1024) {
      setLogoError("Logo must be 2 MB or smaller.");
      return;
    }
    setLogoBusy(true);
    try {
      await onLogoUpload(file);
      setLogoCacheBust((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setLogoError(
          typeof body?.detail === "string"
            ? body.detail
            : `Upload failed (${err.status}).`,
        );
      } else {
        setLogoError("Upload failed.");
      }
    } finally {
      setLogoBusy(false);
    }
  };

  const onRemoveLogo = async () => {
    if (!confirm("Remove the current logo?")) return;
    setLogoError(null);
    setLogoBusy(true);
    try {
      await onLogoDelete();
      setLogoCacheBust((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setLogoError(
          typeof body?.detail === "string"
            ? body.detail
            : `Remove failed (${err.status}).`,
        );
      } else {
        setLogoError("Remove failed.");
      }
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Section title="Primary colour">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {palette.map((p) => (
            <Swatch
              key={p.key}
              entry={p}
              selected={primaryKey === p.key}
              onSelect={() => setPrimaryKey(p.key)}
            />
          ))}
        </div>
      </Section>

      <Section title="Font">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {fonts.map((f) => (
            <FontOption
              key={f.key}
              entry={f}
              selected={fontKey === f.key}
              onSelect={() => setFontKey(f.key)}
            />
          ))}
        </div>
      </Section>

      <Section title="Live preview">
        <Preview palette={selectedPalette} font={selectedFont} />
      </Section>

      <Section title="Logo">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div
            style={{
              width: 96,
              height: 96,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg)",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            {branding.has_logo ? (
              <img
                src={`${logoUrl}?v=${logoCacheBust}`}
                alt="Tenant logo"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
                no logo
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/svg+xml,.png,.svg"
              hidden
              onChange={onLogoChange}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={onPickLogo}
                disabled={logoBusy}
                style={btnPrimary}
              >
                {branding.has_logo ? "Replace logo" : "Upload logo"}
              </button>
              {branding.has_logo && (
                <button
                  type="button"
                  onClick={onRemoveLogo}
                  disabled={logoBusy}
                  style={btnSecondary}
                >
                  Remove
                </button>
              )}
            </div>
            <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
              PNG or SVG, ≤ 2 MB. Large PNGs are auto-resized to fit
              the brand row — upload anything you have.
            </span>
            {logoError && (
              <span style={{ fontSize: 12, color: "var(--danger-text)" }}>
                {logoError}
              </span>
            )}
          </div>
        </div>
      </Section>

      {serverError && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--border)",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {serverError}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || busy}
          style={btnPrimary}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      {/*
        applyToDocument: when true, push the in-progress preview to the
        document so the Admin sees their actual shell change live as
        they pick a swatch. Done in an effect so it runs after render
        and only when applyToDocument is requested.
      */}
      {applyToDocument && (
        <LivePreviewMount palette={selectedPalette} font={selectedFont} />
      )}
    </div>
  );
}

function LivePreviewMount({
  palette,
  font,
}: {
  palette: BrandingPaletteEntry;
  font: BrandingFontEntry;
}) {
  useEffect(() => {
    // Lazy import so the test-only export doesn't bloat the form
    // file's static analysis surface.
    void import("./BrandingProvider").then(({ applyPreview }) => {
      applyPreview(palette, font);
    });
  }, [palette, font]);
  return null;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Swatch({
  entry,
  selected,
  onSelect,
}: {
  entry: BrandingPaletteEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={entry.key}
      aria-pressed={selected}
      style={{
        width: 56,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          background: entry.accent,
          borderRadius: 999,
          border: selected
            ? `2px solid ${entry.accent_text}`
            : "2px solid transparent",
          boxShadow: selected ? "0 0 0 3px var(--bg)" : "none",
          outline: selected
            ? `2px solid ${entry.accent}`
            : "1px solid var(--border)",
        }}
      />
      <span
        style={{
          fontSize: 11,
          color: selected ? "var(--text)" : "var(--text-secondary)",
          textTransform: "capitalize",
          fontWeight: selected ? 600 : 400,
        }}
      >
        {entry.key}
      </span>
    </button>
  );
}

function FontOption({
  entry,
  selected,
  onSelect,
}: {
  entry: BrandingFontEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const label =
    entry.key === "plus-jakarta-sans"
      ? "Plus Jakarta Sans"
      : entry.key.charAt(0).toUpperCase() + entry.key.slice(1);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        background: selected ? "var(--accent-soft)" : "var(--bg-elev)",
        border: selected
          ? "1px solid var(--accent-border)"
          : "1px solid var(--border)",
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontFamily: entry.stack,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
        The quick brown fox jumps over the lazy dog
      </span>
    </button>
  );
}

function Preview({
  palette,
  font,
}: {
  palette: BrandingPaletteEntry;
  font: BrandingFontEntry;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg)",
        fontFamily: font.stack,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 22,
            height: 22,
            background: palette.accent,
            borderRadius: 999,
          }}
        />
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Tenant Dashboard
        </h3>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: palette.accent_soft,
            color: palette.accent_text,
            border: `1px solid ${palette.accent_border}`,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          live
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        This is how the navigation, primary buttons, and accent badges will look
        across the tenant&apos;s workspace.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={{
            background: palette.accent,
            color: "white",
            border: "none",
            padding: "6px 14px",
            borderRadius: "var(--radius-sm)",
            cursor: "default",
            fontWeight: 600,
            fontSize: 13,
            fontFamily: font.stack,
          }}
        >
          Primary action
        </button>
        <button
          type="button"
          style={{
            background: "var(--bg-elev)",
            color: palette.accent_text,
            border: `1px solid ${palette.accent_border}`,
            padding: "6px 14px",
            borderRadius: "var(--radius-sm)",
            cursor: "default",
            fontSize: 13,
            fontFamily: font.stack,
          }}
        >
          Secondary
        </button>
      </div>
    </div>
  );
}

const btnPrimary = {
  background: "var(--accent)",
  color: "white",
  border: "none",
  padding: "8px 14px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
} as const;

const btnSecondary = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "8px 14px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontSize: 13,
} as const;
