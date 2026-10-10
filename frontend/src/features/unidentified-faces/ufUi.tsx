// Shared helpers for the Unidentified Faces feature: crop URLs, date
// presets, tenant-local day grouping, density preference, the face
// image tile, employee chip and quality / pose labels.
//
// Styling lives in unidentified-faces.css (prefix ``unid-``).

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import type { MappingSource } from "./types";

export const cropUrl = (id: number) => `/api/detection-events/${id}/crop`;

/**
 * Migration 0068: every date render goes through the tenant's timezone +
 * date/time format. Components call ``const fmtDate = useFmtDate();``.
 */
export function useFmtDate(): (iso: string) => string {
  const dt = useTenantDateTime();
  return (iso: string) => dt.formatDateTime(iso);
}

// ── Date range presets ──────────────────────────────────────────────────
// The API takes YYYY-MM-DD bounds (start-of-day / end-of-day UTC, see
// hooks.ts), so the presets work on the same UTC calendar the original
// "today" default used.

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type RangePreset = "today" | "yesterday" | "7d" | "30d" | "custom";

export function presetRange(p: Exclude<RangePreset, "custom">): { start: string; end: string } {
  const today = todayIso();
  switch (p) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDaysIso(today, -1);
      return { start: y, end: y };
    }
    case "7d":
      return { start: addDaysIso(today, -6), end: today };
    case "30d":
      return { start: addDaysIso(today, -29), end: today };
  }
}

export function matchPreset(start: string | null, end: string | null): RangePreset {
  for (const p of ["today", "yesterday", "7d", "30d"] as const) {
    const r = presetRange(p);
    if (r.start === start && r.end === end) return p;
  }
  return "custom";
}

// ── Tenant-local day grouping ───────────────────────────────────────────

export interface DayGroup<T> {
  key: string; // YYYY-MM-DD in tenant tz
  label: string; // "Today", "Yesterday", "Fri 9 Oct"
  items: T[];
}

export function useDayGrouper() {
  const dt = useTenantDateTime();
  const { t, i18n } = useTranslation();
  const tz = dt.timezone;
  const keyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let labelFmt: Intl.DateTimeFormat;
  try {
    labelFmt = new Intl.DateTimeFormat(i18n.language || "en", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  } catch {
    labelFmt = new Intl.DateTimeFormat("en", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  }
  const todayKey = keyFmt.format(new Date());
  const yesterdayKey = keyFmt.format(new Date(Date.now() - 86_400_000));

  return function group<T>(items: T[], getIso: (item: T) => string): DayGroup<T>[] {
    const out: DayGroup<T>[] = [];
    const byKey = new Map<string, DayGroup<T>>();
    for (const item of items) {
      const d = new Date(getIso(item));
      const key = Number.isNaN(d.getTime()) ? "unknown" : keyFmt.format(d);
      let g = byKey.get(key);
      if (!g) {
        const label =
          key === todayKey
            ? (t("unidentifiedFaces.dayToday", { defaultValue: "Today" }) as string)
            : key === yesterdayKey
              ? (t("unidentifiedFaces.dayYesterday", { defaultValue: "Yesterday" }) as string)
              : key === "unknown"
                ? "—"
                : labelFmt.format(d);
        g = { key, label, items: [] };
        byKey.set(key, g);
        out.push(g);
      }
      g.items.push(item);
    }
    return out;
  };
}

// ── Grid density (remembered per browser) ───────────────────────────────

export type Density = "comfortable" | "compact";
const DENSITY_KEY = "maugood.unidentifiedFaces.density";

export function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  });
  const set = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* private mode — keep in memory only */
    }
  };
  return [density, set];
}

// ── Face image ──────────────────────────────────────────────────────────

/** Square crop with a neutral fallback when the crop is missing / fails. */
export function FaceImg({
  id,
  hasCrop = true,
  alt = "",
  eager = false,
}: {
  id: number;
  hasCrop?: boolean;
  alt?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!hasCrop || failed) {
    return (
      <span className="unid-img-fallback" aria-hidden>
        <Icon name="user" size={28} />
      </span>
    );
  }
  return (
    <img
      src={cropUrl(id)}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// ── Employee chip ───────────────────────────────────────────────────────

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function EmployeeChip({
  id,
  name,
  code,
  size = "md",
}: {
  id: number;
  name: string | null;
  code?: string | null;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  const label = name ?? (t("unidentifiedFaces.employeeN", { defaultValue: "Employee #{{id}}", id }) as string);
  return (
    <Link
      to={`/employees/${id}`}
      className={`unid-emp-chip unid-emp-chip-${size}`}
      title={t("unidentifiedFaces.openProfile", { defaultValue: "Open {{name}}'s profile", name: label }) as string}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="unid-avatar" aria-hidden>
        {initials(name)}
      </span>
      <span className="unid-emp-chip-text">
        <span className="unid-emp-chip-name">{label}</span>
        {code && <span className="unid-emp-chip-code mono">{code}</span>}
      </span>
    </Link>
  );
}

// ── Mapping source chip ─────────────────────────────────────────────────

export function MappingSourceChip({ source }: { source: MappingSource | null | undefined }) {
  const { t } = useTranslation();
  if (!source) return null;
  const meta: Record<MappingSource, { cls: string; key: string; fallback: string }> = {
    manual_reference: { cls: "pill-info", key: "unidentifiedFaces.sourceReference", fallback: "Reference" },
    manual_attendance: { cls: "pill-success", key: "unidentifiedFaces.sourceAttendance", fallback: "Attendance" },
    auto: { cls: "pill-neutral", key: "unidentifiedFaces.sourceAuto", fallback: "Auto" },
  };
  const m = meta[source];
  return <span className={`pill ${m.cls} unid-mini-pill`}>{t(m.key, m.fallback) as string}</span>;
}

// ── Quality / pose labels ───────────────────────────────────────────────

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

export function qualityTone(q: string): Tone {
  return q === "high" ? "success" : q === "medium" ? "warning" : q === "low" ? "neutral" : "neutral";
}

export function poseTone(p: string): Tone {
  return p === "front" ? "info" : p === "side" ? "accent" : p === "partial" ? "warning" : "neutral";
}

export function similarityTone(pct: number): Tone {
  return pct >= 80 ? "success" : pct >= 65 ? "warning" : "danger";
}

export function useFaceLabels() {
  const { t } = useTranslation();
  return {
    quality: (q: string): string =>
      q === "high"
        ? t("unidentifiedFaces.qualHigh", "High quality")
        : q === "medium"
          ? t("unidentifiedFaces.qualMed", "Medium quality")
          : q === "low"
            ? t("unidentifiedFaces.qualLow", "Low quality")
            : t("unidentifiedFaces.qualUnknown", "Quality unknown"),
    pose: (p: string): string =>
      p === "front"
        ? t("unidentifiedFaces.poseFront", "Front face")
        : p === "side"
          ? t("unidentifiedFaces.poseSide", "Side face")
          : p === "partial"
            ? t("unidentifiedFaces.posePartial", "Partial face")
            : t("unidentifiedFaces.poseUnknown", "Pose unknown"),
  };
}

/** Small dot + label pill used for quality / pose / similarity. */
export function TonePill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`unid-tone-pill tone-${tone}`} title={title}>
      <span className="unid-tone-dot" aria-hidden />
      {children}
    </span>
  );
}

/** One labelled fact row in a side panel. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="unid-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
