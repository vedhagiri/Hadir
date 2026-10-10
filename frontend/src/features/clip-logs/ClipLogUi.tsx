// Small presentational pieces shared by the Clip Logs list, grid and
// drawer: thumbnail tile, status chips, static stat tile and the
// time formatter.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import type { PersonClipOut } from "../person-clips/types";
import { hasVideo, isPlayable } from "./clipLogUtil";
import type { Mode } from "./clipLogUtil";

/** Clip times render in the viewer's local zone (the date filters use
 *  local day bounds too); 12h/24h follows the tenant setting. */
/** Mode icons drawn locally (the shared icon set has no "saved video"
 *  or "activity log" glyph): Saved clips = play-in-frame (a video you
 *  can watch), Logs only = clock-with-history (a timestamped record). */
export function ModeIcon({ mode, size = 16 }: { mode: Mode; size?: number }) {
  return (
    <svg
      className="clg-mode-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {mode === "save_clips" ? (
        <>
          <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
          <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3.5 2" />
        </>
      )}
    </svg>
  );
}

export function useClipTimeFmt(): (iso: string | Date) => string {
  const { timeFormat } = useTenantDateTime();
  return (v) =>
    new Date(v).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: timeFormat === "12h",
    });
}

/** Poster image for a saved clip (``/thumbnail`` — the first frame),
 *  falling back to a camera icon tile when there is none. */
export function ClipThumb({ clip, size = "row" }: { clip: PersonClipOut; size?: "row" | "card" | "player" }) {
  const [err, setErr] = useState(false);
  const status = clip.recording_status;
  useEffect(() => setErr(false), [status]);
  const src = isPlayable(clip) && !err ? `/api/person-clips/${clip.id}/thumbnail` : null;
  return (
    <span className={`clg-thumb clg-thumb-${size}`} aria-hidden>
      {src ? (
        <img src={src} alt="" loading="lazy" onError={() => setErr(true)} />
      ) : (
        <span className="clg-thumb-ph">
          <ModeIcon mode={hasVideo(clip) ? "save_clips" : "logs_only"} size={size === "row" ? 18 : 28} />
        </span>
      )}
    </span>
  );
}

type Tone = "success" | "warning" | "danger" | "info" | "accent" | "neutral";

export interface Chip {
  key: string;
  tone: Tone;
  label: string;
  title?: string;
}

/** Status chips derived only from fields the list API returns. */
export function useClipChips(): (clip: PersonClipOut) => Chip[] {
  const { t } = useTranslation();
  return (clip) => {
    const chips: Chip[] = [];
    const video = hasVideo(clip);
    if (clip.recording_status === "recording") {
      chips.push({ key: "rec", tone: "danger", label: t("clipLogs.chip.recording", { defaultValue: "Recording" }) });
    } else if (clip.recording_status === "finalizing") {
      chips.push({ key: "enc", tone: "warning", label: t("clipLogs.chip.encoding", { defaultValue: "Encoding" }) });
    }
    const processed = clip.processed_use_cases ?? [];
    const processing = clip.processing_use_cases ?? [];
    const pending = clip.pending_use_cases ?? [];
    if (processing.length > 0) {
      chips.push({ key: "proc", tone: "info", label: t("clipLogs.chip.processing", { defaultValue: "Processing" }) });
    } else if (pending.length > 0) {
      chips.push({ key: "queued", tone: "neutral", label: t("clipLogs.chip.queued", { defaultValue: "Queued" }) });
    } else if (processed.length > 0) {
      chips.push({
        key: "done",
        tone: "success",
        label: t("clipLogs.chip.processed", {
          defaultValue: "Processed · {{ucs}}",
          ucs: processed.map((u) => u.toUpperCase()).join(", "),
        }),
      });
    } else if (video && clip.recording_status === "completed") {
      chips.push({ key: "none", tone: "neutral", label: t("clipLogs.chip.notProcessed", { defaultValue: "Not processed" }) });
    }
    const names = clip.matched_employee_names ?? [];
    if (names.length > 0) {
      chips.push({
        key: "match",
        tone: "accent",
        label: t("clipLogs.chip.matched", { defaultValue: "{{n}} matched", n: names.length }),
        title: names.join(", "),
      });
    }
    const n = clip.person_count ?? 0;
    if (!video && n > 0) {
      chips.push({
        key: "people",
        tone: n >= 2 ? "warning" : "neutral",
        label: t("clipLogs.chip.people", { defaultValue: "{{count}} people", count: n }),
      });
    }
    return chips;
  };
}

export function Chips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <span className="clg-chips">
      {chips.map((c) => (
        <span key={c.key} className={`pill pill-${c.tone}`} title={c.title}>
          {c.label}
        </span>
      ))}
    </span>
  );
}

/** Read-only stat tile (same look as the shared StatCard, but the value
 *  may be text — "1h 12m" — and it is not a filter, so not a button). */
export function StaticStat({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: "info" | "success" | "warning" | "neutral" | "danger";
  icon: IconName | ReactNode;
  label: string;
  value: ReactNode;
  sub: string;
}) {
  return (
    <div className={`mg-stat tone-${tone} clg-stat`}>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon" aria-hidden>
          {typeof icon === "string" ? <Icon name={icon as IconName} size={20} /> : icon}
        </span>
      </span>
      <span className="mg-stat-value">{value}</span>
      <span className="mg-stat-sub">{sub}</span>
    </div>
  );
}
