// P22 — topbar dropdown that combines theme + density.
//
// One button (a sun/moon icon depending on the active theme) opens
// a small popover with two segmented controls: Theme
// (System/Light/Dark) and Density (Compact/Comfortable). Each
// selection persists locally + on the server via setTheme /
// setDensity from src/theme. The dropdown is keyboard-accessible
// — Esc closes, Tab cycles through the buttons, the trigger gets
// focus back when the popover closes.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { Icon } from "./Icon";

function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

function useDensity(): Density {
  return useSyncExternalStore(subscribe, getDensity, getDensity);
}

export function DisplaySwitcher() {
  const { t } = useTranslation();
  const theme = useTheme();
  const density = useDensity();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape; restore focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const triggerIcon = theme === "dark" ? "moon" : "sun";

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm"
        aria-label={t("display.button")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ minWidth: 36 }}
      >
        <Icon name={triggerIcon} size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("display.button")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            zIndex: 30,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-lg)",
            padding: 12,
            minWidth: 240,
          }}
        >
          <Section
            label={t("display.themeLabel")}
            options={THEMES.map((v) => ({
              value: v,
              label: t(`display.theme.${v}`),
            }))}
            value={theme}
            onPick={(v) => void setTheme(v as Theme)}
          />
          <div style={{ height: 10 }} />
          <Section
            label={t("display.densityLabel")}
            options={DENSITIES.map((v) => ({
              value: v,
              label: t(`display.density.${v}`),
            }))}
            value={density}
            onPick={(v) => void setDensity(v as Density)}
          />
        </div>
      )}
    </div>
  );
}

interface SectionProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}

function Section<T extends string>({
  label,
  options,
  value,
  onPick,
}: SectionProps<T>) {
  return (
    <div role="group" aria-label={label}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${options.length}, 1fr)`,
          gap: 4,
          background: "var(--bg-sunken)",
          padding: 3,
          borderRadius: "var(--radius-sm)",
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
                padding: "5px 8px",
                fontSize: 12.5,
                borderRadius: 4,
                background: active ? "var(--bg-elev)" : "transparent",
                color: active ? "var(--text)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 500,
                border: active ? "1px solid var(--border)" : "1px solid transparent",
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
