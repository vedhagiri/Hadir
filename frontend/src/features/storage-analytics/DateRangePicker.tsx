// DateRangePicker — hand-built two-month popover range selector.
//
// No external date library (project red line). Works on ISO YYYY-MM-DD
// strings throughout. Click a start day, then an end day; the range
// commits and the popover closes. Future days (> maxDate) are disabled.
//
// Styling: reuses the design system's .cal-month-grid + .cal-dow for
// structure; day cells are compact buttons styled with design tokens.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";

const POPOVER_W = 300;
const POPOVER_H = 340;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(year: number, month0: number, day: number): string {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

function todayIso(): string {
  const d = new Date();
  return toIso(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoToParts(iso: string): { y: number; m: number } {
  const [y, m] = iso.split("-").map(Number);
  return { y: y ?? new Date().getFullYear(), m: (m ?? 1) - 1 };
}

function fmtShort(iso: string, locale: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

interface Props {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  onChange: (start: string, end: string) => void;
  maxDate?: string; // YYYY-MM-DD, default today
}

export function DateRangePicker({ start, end, onChange, maxDate }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const cap = maxDate ?? todayIso();

  const [open, setOpen] = useState(false);
  const [selStart, setSelStart] = useState<string | null>(start);
  const [selEnd, setSelEnd] = useState<string | null>(end);
  const [view, setView] = useState(() => isoToParts(end || start));
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Position the fixed popover relative to the trigger, flipping above /
  // shifting inward when it would overflow the viewport. Rendered through a
  // portal so an overflow:auto ancestor (e.g. the cleanup modal) can't clip it.
  const computePos = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    let left = r.left;
    if (left + POPOVER_W > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - POPOVER_W - 8);
    }
    let top = r.bottom + 6;
    if (top + POPOVER_H > window.innerHeight - 8) {
      top = Math.max(8, r.top - POPOVER_H - 6);
    }
    setPos({ top, left });
  };

  const toggle = () => {
    if (!open) computePos();
    setOpen((o) => !o);
  };

  // Re-sync from props whenever the popover (re)opens.
  useEffect(() => {
    if (open) {
      setSelStart(start);
      setSelEnd(end);
      setView(isoToParts(end || start));
    }
  }, [open, start, end]);

  // Close on outside click + Esc; reposition on resize; close on scroll
  // (a fixed popover can't track a scrolling trigger).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt)) return;
      if (popoverRef.current?.contains(tgt)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Don't let the Esc bubble to a parent modal's own close handler.
        e.stopPropagation();
        setOpen(false);
      }
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", computePos);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", computePos);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const weekdays = useMemo(() => {
    // Sunday-first narrow weekday labels in the active locale.
    const base = new Date(2023, 0, 1); // a Sunday
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d.toLocaleDateString(locale, { weekday: "narrow" });
    });
  }, [locale]);

  const handleDayClick = (iso: string) => {
    if (selStart === null || selEnd !== null) {
      setSelStart(iso);
      setSelEnd(null);
      return;
    }
    if (iso < selStart) {
      setSelStart(iso);
      return;
    }
    setSelEnd(iso);
    onChange(selStart, iso);
    setOpen(false);
  };

  const label =
    start && end
      ? `${fmtShort(start, locale)} – ${fmtShort(end, locale)}`
      : t("storageAnalytics.pickRange");

  return (
    <div style={{ display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ gap: 6 }}
      >
        <Icon name="database" size={12} style={{ opacity: 0 }} />
        {label}
        <Icon name="chevronDown" size={12} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={t("storageAnalytics.pickRange")}
            className="card"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: POPOVER_W,
              maxWidth: "calc(100vw - 16px)",
              zIndex: 300,
              margin: 0,
              padding: 12,
              boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
            }}
          >
            <MonthGrid
              year={view.y}
              month={view.m}
              weekdays={weekdays}
              selStart={selStart}
              selEnd={selEnd}
              maxDate={cap}
              locale={locale}
              showPrev
              showNext
              onPrev={() =>
                setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))
              }
              onNext={() =>
                setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))
              }
              onDayClick={handleDayClick}
            />
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 8, textAlign: "center" }}>
              {selStart && !selEnd
                ? t("storageAnalytics.pickEnd")
                : t("storageAnalytics.pickStart")}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function MonthGrid({
  year,
  month,
  weekdays,
  selStart,
  selEnd,
  maxDate,
  locale,
  showPrev,
  showNext,
  onPrev,
  onNext,
  onDayClick,
}: {
  year: number;
  month: number;
  weekdays: string[];
  selStart: string | null;
  selEnd: string | null;
  maxDate: string;
  locale: string;
  showPrev: boolean;
  showNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDayClick: (iso: string) => void;
}) {
  const today = todayIso();
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const title = new Date(year, month, 1).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
          minHeight: 26,
        }}
      >
        {showPrev ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onPrev}
            aria-label="Previous month"
            style={{ padding: "2px 6px" }}
          >
            <Icon name="chevronLeft" size={13} />
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</span>
        {showNext ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onNext}
            aria-label="Next month"
            style={{ padding: "2px 6px" }}
          >
            <Icon name="chevronRight" size={13} />
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
      </div>

      <div className="cal-month-grid">
        {weekdays.map((w, i) => (
          <div key={`dow-${i}`} className="cal-dow" style={{ padding: "2px 0" }}>
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e-${i}`} />;
          const iso = toIso(year, month, d);
          const disabled = iso > maxDate;
          const isStart = iso === selStart;
          const isEnd = iso === selEnd;
          const inRange =
            selStart !== null &&
            selEnd !== null &&
            iso > selStart &&
            iso < selEnd;
          const isEndpoint = isStart || isEnd;
          const isToday = iso === today;

          let bg = "transparent";
          let color = "var(--text)";
          if (isEndpoint) {
            bg = "var(--accent)";
            color = "#fff";
          } else if (inRange) {
            bg = "var(--accent-soft)";
          }

          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              onClick={() => onDayClick(iso)}
              aria-label={iso}
              aria-pressed={isEndpoint}
              style={{
                height: 30,
                border: isToday && !isEndpoint ? "1px solid var(--accent)" : "1px solid transparent",
                borderRadius: 6,
                background: bg,
                color: disabled ? "var(--text-quaternary)" : color,
                fontSize: 12,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.4 : 1,
                fontVariantNumeric: "tabular-nums",
                padding: 0,
              }}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
