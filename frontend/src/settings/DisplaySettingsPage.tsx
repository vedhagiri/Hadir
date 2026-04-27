// Settings → Display tab. Theme + density controls — moved off the
// topbar (P22 originally shipped these as a popover) into the
// Settings hub so they live alongside the rest of the per-user
// preferences (notifications, language is in the user menu).

import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  DENSITIES,
  THEMES,
  getDensity,
  getTheme,
  setDensity,
  setTheme,
  subscribe,
  type Density,
  type Theme,
} from "../theme";
import { SettingsTabs } from "./SettingsTabs";

function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

function useDensity(): Density {
  return useSyncExternalStore(subscribe, getDensity, getDensity);
}

export function DisplaySettingsPage() {
  const { t } = useTranslation();
  const theme = useTheme();
  const density = useDensity();

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("settings.tabs.display") as string}
          </h1>
          <p className="page-sub">
            {t("display.pageSub") as string}
          </p>
        </div>
      </div>

      <SettingsTabs />

      <div className="card" style={{ padding: 20, maxWidth: 560 }}>
        <Section
          label={t("display.themeLabel") as string}
          description={t("display.themeDescription") as string}
          options={THEMES.map((v) => ({
            value: v,
            label: t(`display.theme.${v}`) as string,
          }))}
          value={theme}
          onPick={(v) => void setTheme(v as Theme)}
        />
        <div
          style={{
            height: 1,
            background: "var(--border)",
            margin: "20px 0",
          }}
        />
        <Section
          label={t("display.densityLabel") as string}
          description={t("display.densityDescription") as string}
          options={DENSITIES.map((v) => ({
            value: v,
            label: t(`display.density.${v}`) as string,
          }))}
          value={density}
          onPick={(v) => void setDensity(v as Density)}
        />
      </div>
    </>
  );
}

interface SectionProps<T extends string> {
  label: string;
  description: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}

function Section<T extends string>({
  label,
  description,
  options,
  value,
  onPick,
}: SectionProps<T>) {
  return (
    <div role="group" aria-label={label}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="text-xs text-dim"
        style={{ marginBottom: 10, lineHeight: 1.5 }}
      >
        {description}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${options.length}, 1fr)`,
          gap: 4,
          background: "var(--bg-sunken)",
          padding: 4,
          borderRadius: "var(--radius-sm)",
          maxWidth: 360,
        }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPick(opt.value)}
              aria-pressed={active}
              style={{
                padding: "8px 10px",
                fontSize: 13,
                borderRadius: 4,
                background: active ? "var(--bg-elev)" : "transparent",
                color: active ? "var(--text)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 500,
                border: active
                  ? "1px solid var(--border)"
                  : "1px solid transparent",
                boxShadow: active ? "var(--shadow-sm)" : "none",
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
