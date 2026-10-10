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
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/client";
import {
  ConfirmModal,
  FormField,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
} from "../settings/settingsUi";
import { Icon } from "../shell/Icon";
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
import { SkeletonPanel } from "../components/Skeleton";

interface Props {
  branding: BrandingResponse;
  /** Logo URL for the GET endpoint that serves this tenant's logo. */
  logoUrl: string;
  onPatch: (input: {
    primary_color_key?: BrandingPaletteKey;
    font_key?: BrandingFontKey;
    display_name?: string;
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
  const { t } = useTranslation();
  const options = useBrandingOptions();
  const queryClient = useQueryClient();
  const [primaryKey, setPrimaryKey] = useState<BrandingPaletteKey>(
    branding.primary_color_key,
  );
  const [fontKey, setFontKey] = useState<BrandingFontKey>(branding.font_key);
  const [displayName, setDisplayName] = useState<string>(
    branding.display_name ?? "",
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoCacheBust, setLogoCacheBust] = useState<number>(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Reset local state if the persisted branding changes (e.g. after
  // a successful save the parent re-renders with fresh data).
  useEffect(() => {
    setPrimaryKey(branding.primary_color_key);
    setFontKey(branding.font_key);
    setDisplayName(branding.display_name ?? "");
  }, [branding.primary_color_key, branding.font_key, branding.display_name]);

  if (options.isLoading) {
    return (
      <div className="st-stack">
        <SkeletonPanel lines={2} />
        <SkeletonPanel lines={4} />
      </div>
    );
  }
  if (options.error || !options.data) {
    return (
      <LoadErrorPanel
        title={t("branding.loadFailedOptions")}
        onRetry={() => void options.refetch()}
      />
    );
  }

  const palette = options.data.palette;
  const fonts = options.data.fonts;
  const selectedPalette =
    palette.find((p) => p.key === primaryKey) ?? palette[0]!;
  const selectedFont = fonts.find((f) => f.key === fontKey) ?? fonts[0]!;

  const trimmedDisplayName = displayName.trim();
  const persistedDisplayName = branding.display_name ?? "";
  const displayNameDirty = trimmedDisplayName !== persistedDisplayName.trim();
  const dirty =
    primaryKey !== branding.primary_color_key ||
    fontKey !== branding.font_key ||
    displayNameDirty;

  const onSave = async () => {
    if (displayNameDirty && !trimmedDisplayName) {
      setServerError(t("branding.errDisplayNameEmpty"));
      return;
    }
    setServerError(null);
    setBusy(true);
    try {
      const patch: {
        primary_color_key?: BrandingPaletteKey;
        font_key?: BrandingFontKey;
        display_name?: string;
      } = {};
      if (primaryKey !== branding.primary_color_key)
        patch.primary_color_key = primaryKey;
      if (fontKey !== branding.font_key) patch.font_key = fontKey;
      if (displayNameDirty) patch.display_name = trimmedDisplayName;
      await onPatch(patch);
      // The display name flows through ``/api/auth/me`` into the
      // sidebar brand row — invalidate the me query so the rename
      // shows up without a page reload.
      if (displayNameDirty) {
        await queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setServerError(
          typeof body?.detail === "string"
            ? body.detail
            : t("branding.errSaveStatus", { status: err.status }),
        );
      } else {
        setServerError(t("branding.errSave"));
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
      setLogoError(t("branding.errLogoTooLarge"));
      return;
    }
    setLogoBusy(true);
    try {
      await onLogoUpload(file);
      setLogoCacheBust((n) => n + 1);
      // Sidebar reads has_brand_logo + brand_logo_version from
      // /api/auth/me — invalidate so the brand row swaps to the new
      // upload without a reload.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setLogoError(
          typeof body?.detail === "string"
            ? body.detail
            : t("branding.errUploadStatus", { status: err.status }),
        );
      } else {
        setLogoError(t("branding.errUpload"));
      }
    } finally {
      setLogoBusy(false);
    }
  };

  const onRemoveLogo = async () => {
    setConfirmRemove(false);
    setLogoError(null);
    setLogoBusy(true);
    try {
      await onLogoDelete();
      setLogoCacheBust((n) => n + 1);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setLogoError(
          typeof body?.detail === "string"
            ? body.detail
            : t("branding.errRemoveStatus", { status: err.status }),
        );
      } else {
        setLogoError(t("branding.errRemove"));
      }
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <div className="st-stack">
      {/* --- Identity + appearance: one save action for the three fields --- */}
      <SettingsCard
        icon={<Icon name="sparkles" size={17} />}
        title={t("settingsUi.branding.appearanceTitle", { defaultValue: "Workspace identity" })}
        description={t("settingsUi.branding.appearanceDesc", {
          defaultValue: "Name, accent colour and typeface. Changes apply after you save.",
        })}
        footerNote={
          dirty
            ? t("settingsUi.branding.unsaved", { defaultValue: "You have unsaved changes." })
            : t("settingsUi.branding.allSaved", { defaultValue: "Everything is saved." })
        }
        footer={
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={!dirty || busy}
          >
            <Icon name="check" size={12} />
            {busy ? t("branding.saving") : t("branding.saveChanges")}
          </button>
        }
      >
        <div className="st-stack">
          <FormField
            label={t("branding.section.displayName")}
            help={t("branding.displayNameHint")}
            htmlFor="branding-display-name"
          >
            <input
              id="branding-display-name"
              type="text"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("branding.displayNamePlaceholder")}
              maxLength={200}
              aria-label={t("branding.section.displayName")}
              style={{ maxWidth: 420 }}
            />
          </FormField>

          <div>
            <p className="st-section-title">{t("branding.section.primaryColour")}</p>
            <p className="field-help" style={{ marginBottom: 10 }}>
              {t("settingsUi.branding.colourDesc", {
                defaultValue: "Used for buttons, links, highlights and the active menu item.",
              })}
            </p>
            <div className="st-inline" role="group" aria-label={t("branding.section.primaryColour")} style={{ gap: 12 }}>
              {palette.map((p) => (
                <Swatch
                  key={p.key}
                  entry={p}
                  selected={primaryKey === p.key}
                  onSelect={() => setPrimaryKey(p.key)}
                />
              ))}
            </div>
          </div>

          <div>
            <p className="st-section-title">{t("branding.section.font")}</p>
            <p className="field-help" style={{ marginBottom: 10 }}>
              {t("settingsUi.branding.fontDesc", {
                defaultValue: "The typeface used across the whole workspace.",
              })}
            </p>
            <div
              role="group"
              aria-label={t("branding.section.font")}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                gap: 8,
              }}
            >
              {fonts.map((f) => (
                <FontOption
                  key={f.key}
                  entry={f}
                  selected={fontKey === f.key}
                  onSelect={() => setFontKey(f.key)}
                />
              ))}
            </div>
          </div>

          <div>
            <p className="st-section-title">{t("branding.section.livePreview")}</p>
            <p className="field-help" style={{ marginBottom: 10 }}>
              {t("settingsUi.branding.previewDesc", {
                defaultValue: "How your choices look before you save them.",
              })}
            </p>
            <Preview palette={selectedPalette} font={selectedFont} />
          </div>

          {serverError && <InlineAlert tone="danger">{serverError}</InlineAlert>}
        </div>
      </SettingsCard>

      {/* --- Logo: uploads apply immediately, no Save needed --- */}
      <SettingsCard
        icon={<Icon name="upload" size={17} />}
        title={t("branding.section.logo")}
        description={t("settingsUi.branding.logoDesc", {
          defaultValue: "Shown at the top of the sidebar and on PDF reports.",
        })}
      >
        <div className="st-inline" style={{ alignItems: "flex-start", gap: 16 }}>
          <div
            style={{
              width: 96,
              height: 96,
              flex: "0 0 96px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              background: "var(--bg-sunken)",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            {branding.has_logo ? (
              <img
                src={`${logoUrl}?v=${logoCacheBust}`}
                alt={t("branding.logoAlt")}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <span className="text-xs text-dim">{t("branding.noLogo")}</span>
            )}
          </div>
          <div className="field" style={{ flex: "1 1 240px" }}>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/svg+xml,.png,.svg"
              hidden
              onChange={onLogoChange}
            />
            <div className="st-inline">
              <button
                type="button"
                className="btn"
                onClick={onPickLogo}
                disabled={logoBusy}
              >
                <Icon name="upload" size={12} />
                {branding.has_logo ? t("branding.replaceLogo") : t("branding.uploadLogo")}
              </button>
              {branding.has_logo && (
                <button
                  type="button"
                  className="btn btn-ghost st-danger"
                  onClick={() => setConfirmRemove(true)}
                  disabled={logoBusy}
                >
                  <Icon name="trash" size={12} />
                  {t("branding.remove")}
                </button>
              )}
            </div>
            <span className="field-help">{t("branding.logoHint")}</span>
            {logoError && <InlineAlert tone="danger">{logoError}</InlineAlert>}
          </div>
        </div>
      </SettingsCard>

      {/*
        applyToDocument: when true, push the in-progress preview to the
        document so the Admin sees their actual shell change live as
        they pick a swatch. Done in an effect so it runs after render
        and only when applyToDocument is requested.
      */}
      {confirmRemove && (
        <ConfirmModal
          titleId="branding-remove-logo-title"
          title={t("settingsUi.forms.branding.removeLogoTitle", { defaultValue: "Remove logo" })}
          subtitle={t("settingsUi.forms.branding.removeLogoSub", {
            defaultValue: "The workspace falls back to the default Maugood mark.",
          })}
          confirmLabel={t("branding.remove")}
          busy={logoBusy}
          onConfirm={() => void onRemoveLogo()}
          onClose={() => setConfirmRemove(false)}
        >
          <p className="st-confirm-text">{t("branding.confirmRemove")}</p>
        </ConfirmModal>
      )}
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

function Swatch({
  entry,
  selected,
  onSelect,
}: {
  entry: BrandingPaletteEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  // Per-colour label — the curated keys are stable identifiers, so each
  // gets its own translation key under branding.colors.<key>; fall
  // through to the raw key if the locale doesn't define one.
  const colorKey = `branding.colors.${entry.key}`;
  const translated = t(colorKey);
  const label = translated === colorKey ? entry.key : translated;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-pressed={selected}
      className="btn btn-ghost"
      style={{
        width: 64,
        height: "auto",
        flexDirection: "column",
        gap: 6,
        padding: "8px 4px",
      }}
    >
      {/* The swatch colour itself is data from the curated palette. */}
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          background: entry.accent,
          borderRadius: 999,
          boxShadow: selected
            ? `0 0 0 2px var(--bg-elev), 0 0 0 4px ${entry.accent}`
            : "0 0 0 1px var(--border)",
          transition: "box-shadow var(--dur-fast) ease",
        }}
      />
      <span
        className="text-xs"
        style={{
          color: selected ? "var(--text)" : "var(--text-secondary)",
          textTransform: "capitalize",
          fontWeight: selected ? 600 : 500,
        }}
      >
        {label}
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
  const { t } = useTranslation();
  // The font NAMES are proper nouns (Inter, Lato, Plus Jakarta Sans) and
  // stay the same in any language. Only the sample-text below is
  // translated.
  const label =
    entry.key === "plus-jakarta-sans"
      ? "Plus Jakarta Sans"
      : entry.key.charAt(0).toUpperCase() + entry.key.slice(1);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`radio-card${selected ? " active" : ""}`}
      style={{ textAlign: "start", flexDirection: "column", gap: 2, fontFamily: entry.stack }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
      <span className="text-xs text-dim">{t("branding.fontSample")}</span>
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
  const { t } = useTranslation();
  return (
    <div
      className="st-fact"
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, fontFamily: font.stack }}
    >
      <div className="st-inline" style={{ gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            background: palette.accent,
            borderRadius: 999,
          }}
        />
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          {t("branding.preview.tenantDashboard")}
        </h3>
        <span
          className="pill"
          style={{
            background: palette.accent_soft,
            color: palette.accent_text,
            borderColor: palette.accent_border,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {t("branding.preview.live")}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        {t("branding.preview.body")}
      </p>
      <div className="st-inline">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="btn"
          style={{
            background: palette.accent,
            color: "white",
            borderColor: palette.accent,
            cursor: "default",
            fontFamily: font.stack,
          }}
        >
          {t("branding.preview.primaryAction")}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="btn"
          style={{
            color: palette.accent_text,
            borderColor: palette.accent_border,
            cursor: "default",
            fontFamily: font.stack,
          }}
        >
          {t("branding.preview.secondary")}
        </button>
      </div>
    </div>
  );
}
