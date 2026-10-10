// Camera Logs presentational helpers: tenant-local date maths, the
// crop thumbnail with its hover preview, person / confidence / track
// cells, the status pill and the ⓘ hint popover. Styling lives in
// ./camera-logs.css (prefix ``cl-log-``).

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { DotPill } from "../attendance/attendanceUi";
import type { DetectionEvent } from "./types";

import "./camera-logs.css";

// ── Tenant-local dates ──────────────────────────────────────────────────

export type RangePreset = "all" | "today" | "yesterday" | "7d" | "custom";

export function tenantDayKey(tz: string, d: Date): string {
  // en-CA renders YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** "+04:00" for the tenant timezone at the given instant. */
function tzOffset(tz: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = part ? /GMT([+-]\d{2}):?(\d{2})?/.exec(part) : null;
    if (m) return `${m[1]}:${m[2] ?? "00"}`;
  } catch {
    /* fall through */
  }
  return "+00:00";
}

/** ISO datetime for a tenant-local day + wall-clock time, so a "Today"
 *  filter means the tenant's day, not UTC's or the browser's. */
export function tenantBound(day: string, time: string, tz: string): string {
  return `${day}T${time}${tzOffset(tz, new Date(`${day}T12:00:00Z`))}`;
}

export function presetDays(p: Exclude<RangePreset, "all" | "custom">, today: string): { from: string; to: string } {
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDaysIso(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDaysIso(today, -6), to: today };
  }
}

/** Groups items by tenant-local day; label is "Today" / "Yesterday" /
 *  "Fri 9 Oct". */
export function useDayGrouping() {
  const dt = useTenantDateTime();
  const { t, i18n } = useTranslation();
  const tz = dt.timezone;
  let labelFmt: Intl.DateTimeFormat;
  try {
    labelFmt = new Intl.DateTimeFormat(i18n.language || "en", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  } catch {
    labelFmt = new Intl.DateTimeFormat("en", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  }
  const todayKey = tenantDayKey(tz, new Date());
  const yesterdayKey = addDaysIso(todayKey, -1);
  return function group<T>(items: T[], iso: (item: T) => string): { key: string; label: string; items: T[] }[] {
    const out: { key: string; label: string; items: T[] }[] = [];
    const byKey = new Map<string, { key: string; label: string; items: T[] }>();
    for (const item of items) {
      const d = new Date(iso(item));
      const key = Number.isNaN(d.getTime()) ? "unknown" : tenantDayKey(tz, d);
      let g = byKey.get(key);
      if (!g) {
        const label =
          key === todayKey
            ? t("cameraLogs.day.today", { defaultValue: "Today" })
            : key === yesterdayKey
              ? t("cameraLogs.day.yesterday", { defaultValue: "Yesterday" })
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

// ── Crop thumbnail + hover preview ──────────────────────────────────────

export const cropUrl = (id: number) => `/api/detection-events/${id}/crop`;

export function CropThumb({ ev, size = "md" }: { ev: DetectionEvent; size?: "md" | "sm" }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [failed, setFailed] = useState(false);

  if (!ev.has_crop || failed) {
    return (
      <span
        className={`cl-log-thumb cl-log-thumb-empty is-${size}`}
        title={t("cameraLogs.cropUnavailable")}
        aria-label={t("cameraLogs.cropUnavailable")}
        role="img"
      >
        <Icon name="eyeOff" size={size === "sm" ? 12 : 15} />
      </span>
    );
  }

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const W = 168;
    const rtl = document.documentElement.dir === "rtl";
    let left = rtl ? r.left - W - 12 : r.right + 12;
    if (left + W > window.innerWidth - 8) left = r.left - W - 12;
    if (left < 8) left = r.right + 12;
    const top = Math.min(Math.max(8, r.top + r.height / 2 - W / 2), window.innerHeight - W - 8);
    setPos({ top, left });
  };

  return (
    <span ref={ref} className={`cl-log-thumb is-${size}`} onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      <img src={cropUrl(ev.id)} alt={t("cameraLogs.cropAlt", { id: ev.id, defaultValue: `Face crop ${ev.id}` })} loading="lazy" onError={() => setFailed(true)} />
      {pos &&
        createPortal(
          <span className="cl-log-preview" style={{ top: pos.top, left: pos.left }} aria-hidden>
            <img src={cropUrl(ev.id)} alt="" />
          </span>,
          document.body,
        )}
    </span>
  );
}

// ── Cells ───────────────────────────────────────────────────────────────

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (a + b).toUpperCase() || "?";
}

export function EventStatusPill({ ev }: { ev: DetectionEvent }) {
  const { t } = useTranslation();
  if (ev.employee_id) return <DotPill tone="success">{t("cameraLogs.pill.identified")}</DotPill>;
  if (ev.former_employee_match) return <DotPill tone="danger">{t("cameraLogs.pill.former")}</DotPill>;
  return <DotPill tone="warning">{t("cameraLogs.pill.unidentified")}</DotPill>;
}

/** Person: avatar initials + name (links to the profile when we have an
 *  employee id). Unknown faces get a dashed "Unknown person" avatar. */
export function PersonCell({ ev, compact = false, linked = true }: { ev: DetectionEvent; compact?: boolean; linked?: boolean }) {
  const { t } = useTranslation();
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (ev.employee_id) {
    const inactive = ev.employee_status === "inactive";
    const name = ev.employee_name ?? t("cameraLogs.empFallback", { id: ev.employee_id });
    return (
      <span className="cl-log-person">
        <span className="cl-log-avatar" aria-hidden>{initials(ev.employee_name)}</span>
        <span className="cl-log-person-text">
          {linked ? (
            <Link to={`/employees/${ev.employee_id}`} onClick={stop} className={`cl-log-person-name${inactive ? " is-archived" : ""}`}>
              {name}
            </Link>
          ) : (
            <span className={`cl-log-person-name${inactive ? " is-archived" : ""}`}>{name}</span>
          )}
          {!compact && (
            <span className="cl-log-person-sub">
              {inactive && <span className="pill pill-neutral cl-log-mini-pill">{t("cameraLogs.archived")}</span>}
              {ev.employee_code && <span className="mono">{ev.employee_code}</span>}
            </span>
          )}
        </span>
      </span>
    );
  }
  if (ev.former_employee_match) {
    const name = ev.former_match_employee_name ?? t("cameraLogs.unknown");
    return (
      <span
        className="cl-log-person"
        title={ev.former_match_employee_name ? t("cameraLogs.formerNamed", { name: ev.former_match_employee_name }) : t("cameraLogs.pill.former")}
      >
        <span className="cl-log-avatar is-former" aria-hidden>{initials(ev.former_match_employee_name)}</span>
        <span className="cl-log-person-text">
          {linked && ev.former_match_employee_id ? (
            <Link to={`/employees/${ev.former_match_employee_id}`} onClick={stop} className="cl-log-person-name is-muted">
              {name}
            </Link>
          ) : (
            <span className="cl-log-person-name is-muted">{name}</span>
          )}
          {!compact && (
            <span className="cl-log-person-sub">
              <span className="mono">{ev.former_match_employee_code ?? "—"}</span>
            </span>
          )}
        </span>
      </span>
    );
  }
  return (
    <span className="cl-log-person">
      <span className="cl-log-avatar is-unknown" aria-hidden>
        <Icon name="user" size={13} />
      </span>
      <span className="cl-log-person-text">
        <span className="cl-log-person-name is-unknown">{t("cameraLogs.unknownPerson", { defaultValue: "Unknown person" })}</span>
      </span>
    </span>
  );
}

// A stored confidence already cleared the match threshold, so low is
// "weaker match", not "wrong" — no red here.
export function confidenceTone(c: number): "success" | "accent" | "warning" {
  if (c >= 0.75) return "success";
  if (c >= 0.45) return "accent";
  return "warning";
}

export function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="cl-log-dim">—</span>;
  const pctVal = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className={`cl-log-conf tone-${confidenceTone(value)}`} title={`${(value * 100).toFixed(1)}%`}>
      <span className="cl-log-conf-track" aria-hidden>
        <span className="cl-log-conf-fill" style={{ width: `${pctVal}%` }} />
      </span>
      <span className="cl-log-conf-val">{pctVal}%</span>
    </span>
  );
}

/** Track id as a short muted chip — tail of the id (the distinctive
 *  part, e.g. "unk-13500"), full id in the tooltip. */
export function TrackChip({ id }: { id: string }) {
  // Clip-reprocess ids look like "clip-3586-emp-2066-in" — the clip
  // number is the useful handle; live-tracker ids fall back to the tail.
  const clip = /^clip-(\d+)-/.exec(id);
  const short = clip ? `clip #${clip[1]}` : id.length > 12 ? `…${id.slice(-10)}` : id;
  return (
    <span className="cl-log-track" title={id}>
      {short}
    </span>
  );
}

// ── ⓘ hint popover ──────────────────────────────────────────────────────

export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span
      ref={wrapRef}
      className="cl-log-hint"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        type="button"
        className="cl-log-hint-btn"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => {
          setPinned((p) => !p);
          setOpen((o) => (pinned ? !o : true));
        }}
      >
        <Icon name="info" size={14} />
      </button>
      {open && (
        <span id={id} role="dialog" aria-label={label} className="cl-log-hint-pop">
          {children}
        </span>
      )}
    </span>
  );
}
