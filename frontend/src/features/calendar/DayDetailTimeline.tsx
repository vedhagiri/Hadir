// One timeline for the Day detail panel: the policy's shift window
// shaded behind the presence intervals and detection dots, first / last
// detection labelled, auto-zoom with a Full-day toggle. Replaces the old
// "Day timeline" ribbon + "Policy applied → shift window" strip.
// Clicking a dot asks the parent to scroll to + flash that face crop.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { formatMinutes } from "../attendance/timeFormat";
import { useTenantDateTime } from "../../util/datetime";
import { toMinutes, type WindowBand } from "./dayDetailModel";
import type { EvidenceCrop, TimelineInterval } from "./types";

interface Hover {
  key: string;
  label: string;
  sub?: string;
  confidence?: number | null;
  pct: number;
  action?: boolean;
}

const DAY = 1440;

function hhmm(mins: number): string {
  const m = Math.max(0, Math.min(DAY, Math.round(mins)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function DayDetailTimeline({
  intervals,
  evidence,
  inTime,
  outTime,
  totalMinutes,
  bands,
  windowLabel,
  onEventActivate,
}: {
  intervals: TimelineInterval[];
  evidence: EvidenceCrop[];
  inTime: string | null;
  outTime: string | null;
  totalMinutes: number | null;
  bands: WindowBand[];
  /** e.g. "Shift 16:00 – 02:03"; shown in the legend. */
  windowLabel: string | null;
  onEventActivate?: (detectionEventId: number) => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [fullDay, setFullDay] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  const inM = toMinutes(inTime);
  const outM = toMinutes(outTime);

  const activity: number[] = [
    inM,
    outM,
    ...evidence.map((e) => toMinutes(e.captured_at)),
    ...intervals.flatMap((iv) => [toMinutes(iv.start), toMinutes(iv.end)]),
  ].filter((m): m is number => m != null);
  // The shift window is part of the story — keep its visible edges in
  // the auto-zoomed range (an overnight window contributes its start
  // and the day's end).
  const windowEdges = bands.flatMap((b) =>
    b.start === 0 ? [] : b.end === DAY ? [b.start] : [b.start, b.end],
  );
  const range = [...activity, ...windowEdges];
  const canZoom = range.length > 0;

  let viewStart = 0;
  let viewEnd = DAY;
  if (!fullDay && canZoom) {
    viewStart = Math.max(0, Math.floor((Math.min(...range) - 60) / 60) * 60);
    viewEnd = Math.min(DAY, Math.ceil((Math.max(...range) + 60) / 60) * 60);
    if (viewEnd - viewStart < 240) {
      viewEnd = Math.min(DAY, viewStart + 240);
      viewStart = Math.max(0, viewEnd - 240);
    }
  }
  const span = viewEnd - viewStart;
  const pct = (m: number) => (100 * (Math.max(viewStart, Math.min(viewEnd, m)) - viewStart)) / span;
  const inView = (m: number) => m >= viewStart && m <= viewEnd;

  const step = span <= 360 ? 1 : span <= 720 ? 2 : span <= 1080 ? 3 : 4;
  const hours = Array.from({ length: 25 }, (_, h) => h).filter((h) => inView(h * 60));
  const zoomed = !fullDay && canZoom && (viewStart > 0 || viewEnd < DAY);

  const confTone = (c: number | null | undefined) =>
    c == null ? "unknown" : c >= 0.75 ? "high" : c >= 0.5 ? "mid" : "low";

  const showFirst = inM != null && inView(inM);
  const showLast = outM != null && outM !== inM && inView(outM);

  return (
    <div className="dd-tl">
      <div className="dd-tl-top">
        <span className="dd-tl-range mono">
          {hhmm(viewStart)} – {hhmm(viewEnd)}
          {zoomed && (
            <span className="dd-tl-zoom">
              {t("calendar.autoZoom", { defaultValue: "auto-zoom" }) as string}
            </span>
          )}
        </span>
        {canZoom && (
          <button
            type="button"
            className="dd-tl-toggle"
            aria-pressed={fullDay}
            onClick={() => setFullDay((v) => !v)}
          >
            {fullDay
              ? (t("calendar.zoomToActivity", { defaultValue: "Zoom to activity" }) as string)
              : (t("calendar.fullDay", { defaultValue: "Full day" }) as string)}
          </button>
        )}
      </div>

      {/* Labels for first / last detection, anchored so they never
          collide: "In" grows to the start side, "Out" to the end side. */}
      <div className="dd-tl-marks" aria-hidden>
        {showFirst && (
          <span
            className={`dd-tl-mark is-in${pct(inM!) < 14 ? " is-flip" : ""}`}
            style={{ insetInlineStart: `${pct(inM!)}%` }}
          >
            {t("dayDetail.in", { defaultValue: "In" }) as string}{" "}
            <b className="mono">{dt.formatLocalTime(inTime)}</b>
          </span>
        )}
        {showLast && (
          <span
            className={`dd-tl-mark is-out${pct(outM!) > 86 ? " is-flip" : ""}`}
            style={{ insetInlineStart: `${pct(outM!)}%` }}
          >
            {t("dayDetail.out", { defaultValue: "Out" }) as string}{" "}
            <b className="mono">{dt.formatLocalTime(outTime)}</b>
          </span>
        )}
      </div>

      <div
        className="dd-tl-track"
        role="figure"
        aria-label={t("calendar.dayTimelineAria", { defaultValue: "Day timeline — detection events and presence windows" }) as string}
        onMouseLeave={() => setHover(null)}
      >
        {hours.map((h) => (
          <span
            key={`g${h}`}
            aria-hidden
            className={`dd-tl-grid${h % step === 0 ? " is-major" : ""}`}
            style={{ insetInlineStart: `${pct(h * 60)}%` }}
          />
        ))}

        {bands.map((b, i) => {
          if (b.end <= viewStart || b.start >= viewEnd) return null;
          const l = pct(b.start);
          const w = pct(b.end) - l;
          return (
            <span
              key={`b${i}`}
              aria-hidden
              className={`dd-tl-window is-${b.kind}`}
              style={{ insetInlineStart: `${l}%`, width: `${w}%` }}
            />
          );
        })}

        {intervals.map((iv, i) => {
          const s = toMinutes(iv.start);
          const e = toMinutes(iv.end);
          if (s == null || e == null) return null;
          const end = Math.max(s + 1, e);
          if (end <= viewStart || s >= viewEnd) return null;
          const l = pct(s);
          const w = Math.max(0.6, pct(end) - l);
          const key = `iv${i}`;
          return (
            <span
              key={key}
              role="img"
              className={`dd-tl-presence${hover?.key === key ? " is-hover" : ""}`}
              style={{ insetInlineStart: `${l}%`, width: `${w}%` }}
              aria-label={`${t("calendar.presentBlock", { defaultValue: "Present" }) as string} ${iv.start} – ${iv.end}`}
              onMouseEnter={() =>
                setHover({ key, label: `${iv.start.slice(0, 5)} – ${iv.end.slice(0, 5)}`, sub: t("calendar.presentBlock", { defaultValue: "Present" }) as string, pct: l + w / 2 })
              }
            />
          );
        })}

        {showFirst && <span aria-hidden className="dd-tl-pin is-in" style={{ insetInlineStart: `${pct(inM!)}%` }} />}
        {showLast && <span aria-hidden className="dd-tl-pin is-out" style={{ insetInlineStart: `${pct(outM!)}%` }} />}

        {evidence.map((ev) => {
          const m = toMinutes(ev.captured_at);
          if (m == null || !inView(m)) return null;
          const l = pct(m);
          const key = `ev${ev.detection_event_id}`;
          const info: Hover = {
            key,
            label: dt.formatLocalTime(ev.captured_at),
            sub: ev.camera_code,
            confidence: ev.confidence ?? null,
            pct: l,
            action: !!onEventActivate,
          };
          return (
            <button
              key={key}
              type="button"
              className={`dd-tl-dot conf-${confTone(ev.confidence)}${hover?.key === key ? " is-hover" : ""}`}
              style={{ insetInlineStart: `${l}%` }}
              onClick={() => onEventActivate?.(ev.detection_event_id)}
              onMouseEnter={() => setHover(info)}
              onFocus={() => setHover(info)}
              onBlur={() => setHover(null)}
              aria-label={`${t("calendar.detectionAt", { defaultValue: "Detection at" }) as string} ${ev.captured_at.slice(0, 5)} · ${ev.camera_code}`}
            />
          );
        })}

        {hover && (
          <div
            role="tooltip"
            className="dd-tl-tip"
            style={{ insetInlineStart: `${Math.min(Math.max(hover.pct, 10), 90)}%` }}
          >
            <div className="dd-tl-tip-title">{hover.label}</div>
            {hover.sub && <div className="dd-tl-tip-sub">{hover.sub}</div>}
            {hover.confidence != null && (
              <div className="dd-tl-tip-sub">
                {t("calendar.matchConfidence", { defaultValue: "Match confidence" }) as string}{" "}
                <b>{(hover.confidence * 100).toFixed(0)}%</b>
              </div>
            )}
            {hover.action && (
              <div className="dd-tl-tip-hint">
                {t("calendar.clickForCrop", { defaultValue: "↓ Click to highlight face crop" }) as string}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dd-tl-hours" aria-hidden>
        {hours
          .filter((h) => h % step === 0)
          .map((h) => (
            <span key={`h${h}`} style={{ insetInlineStart: `${pct(h * 60)}%` }}>
              {String(h % 24).padStart(2, "0")}:00
            </span>
          ))}
      </div>

      <div className="dd-tl-legend">
        {bands.length > 0 && (
          <span className="dd-tl-key">
            <i aria-hidden className="k-window" />
            {windowLabel ?? (t("calendar.shiftWindowLabel", { defaultValue: "Shift window" }) as string)}
          </span>
        )}
        {intervals.length > 0 && (
          <span className="dd-tl-key">
            <i aria-hidden className="k-presence" />
            {t("calendar.legend.present", { defaultValue: "Present window" }) as string}
          </span>
        )}
        {evidence.length > 0 && (
          <span className="dd-tl-key">
            <i aria-hidden className="k-dot" />
            {t("calendar.legend.detection", { defaultValue: "Face detected" }) as string}
            {onEventActivate && (
              <span className="dd-tl-key-hint">
                · {t("dayDetail.clickDot", { defaultValue: "click a dot to find its crop" }) as string}
              </span>
            )}
          </span>
        )}
        {totalMinutes != null && totalMinutes > 0 && (
          <span className="dd-tl-span">
            {t("dayDetail.presentSpan", { defaultValue: "Present span" }) as string}{" "}
            <b className="mono">{formatMinutes(totalMinutes)}</b>
          </span>
        )}
      </div>
    </div>
  );
}
