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
import { Icon } from "../shell/Icon";
import { SettingRow, SettingsCard, SettingsPage } from "./settingsUi";

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
    <SettingsPage
      title={t("settings.tabs.display") as string}
      subtitle={t("display.pageSub") as string}
    >
      <SettingsCard
        icon={<Icon name={theme === "dark" ? "moon" : "sun"} size={17} />}
        title={t("settingsUi.display.cardTitle", { defaultValue: "Appearance" })}
        description={t("settingsUi.display.cardDesc", {
          defaultValue: "These preferences are saved to your account and follow you to any browser.",
        })}
      >
        <SettingRow
          label={t("display.themeLabel") as string}
          help={t("display.themeDescription") as string}
        >
          <Segmented
            label={t("display.themeLabel") as string}
            options={THEMES.map((v) => ({
              value: v,
              label: t(`display.theme.${v}`) as string,
            }))}
            value={theme}
            onPick={(v) => void setTheme(v as Theme)}
          />
        </SettingRow>
        <SettingRow
          last
          label={t("display.densityLabel") as string}
          help={t("display.densityDescription") as string}
        >
          <Segmented
            label={t("display.densityLabel") as string}
            options={DENSITIES.map((v) => ({
              value: v,
              label: t(`display.density.${v}`) as string,
            }))}
            value={density}
            onPick={(v) => void setDensity(v as Density)}
          />
        </SettingRow>
      </SettingsCard>
    </SettingsPage>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onPick,
}: SegmentedProps<T>) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`seg-btn${active ? " active" : ""}`}
            onClick={() => onPick(opt.value)}
            aria-pressed={active}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
