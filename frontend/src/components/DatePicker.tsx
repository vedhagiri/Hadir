// Themed date picker — replaces native <input type="date"> on surfaces
// that need a larger, theme-aware popover. Disables future dates by
// default; honours an optional ``min`` lower bound so a "to" picker
// can't drop below its paired "from" date.
//
// Navigation modes (new in this revision):
//   day   — standard day grid with ‹/› month arrows (default)
//   month — 4×3 month grid for the current view-year; ‹/› moves by year
//   year  — 4×3 year grid showing a decade; ‹/› moves by 10 years
//
// Clicking the "Month Year" label in day-view jumps to year-view so
// operators can reach a date 5–10 years away in two clicks instead of
// 60+ arrow presses.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../shell/Icon";

interface DatePickerProps {
  value: string; // ISO YYYY-MM-DD
  onChange: (next: string) => void;
  /** Lower bound (inclusive). ISO YYYY-MM-DD. */
  min?: string;
  /** Upper bound (inclusive). ISO YYYY-MM-DD. Pass ``todayIso()`` on
   *  past-only surfaces (attendance, reports). Omitted means no upper
   *  bound — required for forward-looking inputs (leave requests,
   *  holidays, joining dates). */
  max?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Mirrors the small-input style used across forms. */
  triggerStyle?: CSSProperties;
  /** Disables the trigger button. */
  disabled?: boolean;
}

type ViewMode = "day" | "month" | "year";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return isoOf(new Date());
}

function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return dt;
}

function formatDisplay(iso: string): string {
  const d = parseIso(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

const WEEKDAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Shared base for year/month grid cells.
const GRID_CELL_BASE: CSSProperties = {
  border: "1px solid transparent",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 80ms ease",
  fontFamily: "var(--font-sans)",
  padding: "9px 4px",
};

export function DatePicker({
  value,
  onChange,
  min,
  max,
  ariaLabel,
  placeholder,
  triggerStyle,
  disabled,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const seed = parseIso(value) ?? (max ? parseIso(max) : null) ?? new Date();
    const d = seed instanceof Date ? seed : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();

  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
    flipUp: boolean;
  } | null>(null);

  // Keep the visible month aligned with ``value`` when it changes from
  // the outside (preset chips, paired picker snap).
  useEffect(() => {
    const d = parseIso(value);
    if (!d) return;
    setView({ year: d.getFullYear(), month: d.getMonth() });
  }, [value]);

  // Always start on the day grid when the popover opens.
  useEffect(() => {
    if (open) setViewMode("day");
  }, [open]);

  // Compute the popup's viewport coordinates whenever it opens, and
  // re-compute on scroll / resize so it tracks the trigger.
  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const recompute = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const POPOVER_H = 420;
      const POPOVER_W = 340;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const spaceBelow = vh - rect.bottom;
      const flipUp = spaceBelow < POPOVER_H + 12 && rect.top > POPOVER_H + 12;
      const top = flipUp ? rect.top - POPOVER_H - 6 : rect.bottom + 6;
      let left = rect.left;
      if (left + POPOVER_W > vw - 8) {
        left = Math.max(8, vw - POPOVER_W - 8);
      }
      setPopoverPos({ top, left, flipUp });
    };
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  // Click-outside + Esc to close.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Day cells for the current view month (6 × 7 grid, Monday-anchored).
  const cells = useMemo(() => {
    const firstOfMonth = new Date(view.year, view.month, 1);
    const dayOfWeek = (firstOfMonth.getDay() + 6) % 7; // 0 = Mon
    const gridStart = new Date(view.year, view.month, 1 - dayOfWeek);
    const out: { iso: string; date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      out.push({
        iso: isoOf(d),
        date: d,
        inMonth: d.getMonth() === view.month,
      });
    }
    return out;
  }, [view.year, view.month]);

  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );

  const todayStr = todayIso();

  // Decade helpers: show 12 cells (decade-1 … decade+10) so fringe
  // years at both ends are reachable without an extra arrow press.
  const decadeBase = Math.floor(view.year / 10) * 10;
  const yearGridStart = decadeBase - 1;
  const yearGridYears = Array.from(
    { length: 12 },
    (_, i) => yearGridStart + i,
  );

  function shiftMonth(delta: number) {
    setView((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function pick(iso: string) {
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function isDisabled(iso: string): boolean {
    if (max && iso > max) return true;
    if (min && iso < min) return true;
    return false;
  }

  function isYearDisabled(y: number): boolean {
    if (max) {
      const p = parseIso(max);
      if (p && y > p.getFullYear()) return true;
    }
    if (min) {
      const p = parseIso(min);
      if (p && y < p.getFullYear()) return true;
    }
    return false;
  }

  function isMonthDisabled(m: number): boolean {
    const y = view.year;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const firstIso = `${y}-${pad(m + 1)}-01`;
    const lastIso = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
    if (max && firstIso > max) return true;
    if (min && lastIso < min) return true;
    return false;
  }

  // Selected date parsed once, used in both month and day views.
  const selectedDate = parseIso(value);

  // ─────────────────────────────────────────────────────────────────────────
  // Shared nav header (‹  [label]  ›) used across all three views.
  // ─────────────────────────────────────────────────────────────────────────
  function NavHeader({
    onPrev,
    onNext,
    onLabelClick,
    prevAriaLabel,
    nextAriaLabel,
    labelAriaLabel,
    nextDisabled = false,
    children,
  }: {
    onPrev: () => void;
    onNext: () => void;
    onLabelClick?: () => void;
    prevAriaLabel: string;
    nextAriaLabel: string;
    labelAriaLabel?: string;
    nextDisabled?: boolean;
    children: React.ReactNode;
  }) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={onPrev}
          aria-label={prevAriaLabel}
          style={{ padding: "4px 8px" }}
        >
          ‹
        </button>
        {onLabelClick ? (
          <button
            type="button"
            onClick={onLabelClick}
            aria-label={labelAriaLabel}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 10px",
              borderRadius: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              letterSpacing: "0.01em",
            }}
          >
            {children}
            <span style={{ fontSize: 10, opacity: 0.55, lineHeight: 1 }}>
              ▾
            </span>
          </button>
        ) : (
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text)",
              letterSpacing: "0.01em",
            }}
          >
            {children}
          </div>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={onNext}
          aria-label={nextAriaLabel}
          style={{ padding: "4px 8px" }}
          disabled={nextDisabled}
        >
          ›
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label={ariaLabel ?? "Select date"}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          padding: "6px 10px",
          fontSize: 12.5,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-elev)",
          color: value ? "var(--text)" : "var(--text-tertiary)",
          fontFamily: "var(--font-sans)",
          outline: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minWidth: 150,
          ...triggerStyle,
        }}
      >
        <Icon name="calendar" size={13} />
        <span style={{ flex: 1, textAlign: "start" }}>
          {value ? formatDisplay(value) : placeholder ?? "Pick a date"}
        </span>
      </button>

      {open &&
        popoverPos &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-label={ariaLabel ?? "Date picker"}
            style={{
              position: "fixed",
              top: popoverPos.top,
              left: popoverPos.left,
              zIndex: 1000,
              width: 340,
              padding: 14,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md, 10px)",
              boxShadow:
                "0 10px 30px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
            }}
          >
            {/* ── Year grid ──────────────────────────────────────────── */}
            {viewMode === "year" && (
              <>
                <NavHeader
                  onPrev={() => setView((v) => ({ ...v, year: v.year - 10 }))}
                  onNext={() => setView((v) => ({ ...v, year: v.year + 10 }))}
                  prevAriaLabel="Previous decade"
                  nextAriaLabel="Next decade"
                >
                  {yearGridStart + 1} – {yearGridStart + 10}
                </NavHeader>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                  }}
                >
                  {yearGridYears.map((y) => {
                    const inDecade = y >= decadeBase && y < decadeBase + 10;
                    const isSelected =
                      selectedDate !== null &&
                      y === selectedDate.getFullYear();
                    const dis = isYearDisabled(y);
                    return (
                      <button
                        key={y}
                        type="button"
                        disabled={dis}
                        onClick={() => {
                          setView((v) => ({ ...v, year: y }));
                          setViewMode("month");
                        }}
                        style={{
                          ...GRID_CELL_BASE,
                          background: isSelected
                            ? "var(--accent)"
                            : inDecade
                              ? "var(--bg-sunken)"
                              : "transparent",
                          color: isSelected
                            ? "white"
                            : dis
                              ? "var(--text-tertiary)"
                              : inDecade
                                ? "var(--text)"
                                : "var(--text-tertiary)",
                          fontWeight: isSelected ? 700 : inDecade ? 500 : 400,
                          border: inDecade && !isSelected
                            ? "1px solid var(--border)"
                            : "1px solid transparent",
                          opacity: dis ? 0.4 : 1,
                          cursor: dis ? "not-allowed" : "pointer",
                        }}
                      >
                        {y}
                      </button>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}

            {/* ── Month grid ─────────────────────────────────────────── */}
            {viewMode === "month" && (
              <>
                <NavHeader
                  onPrev={() => setView((v) => ({ ...v, year: v.year - 1 }))}
                  onNext={() => setView((v) => ({ ...v, year: v.year + 1 }))}
                  prevAriaLabel="Previous year"
                  nextAriaLabel="Next year"
                  onLabelClick={() => setViewMode("year")}
                  labelAriaLabel="Select year"
                >
                  {view.year}
                </NavHeader>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                  }}
                >
                  {MONTH_SHORT.map((name, m) => {
                    const isSelected =
                      selectedDate !== null &&
                      m === selectedDate.getMonth() &&
                      view.year === selectedDate.getFullYear();
                    const dis = isMonthDisabled(m);
                    const now = new Date();
                    const isCurrent =
                      now.getMonth() === m &&
                      now.getFullYear() === view.year;
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={dis}
                        onClick={() => {
                          setView((v) => ({ ...v, month: m }));
                          setViewMode("day");
                        }}
                        style={{
                          ...GRID_CELL_BASE,
                          background: isSelected
                            ? "var(--accent)"
                            : "var(--bg-sunken)",
                          color: isSelected
                            ? "white"
                            : dis
                              ? "var(--text-tertiary)"
                              : "var(--text)",
                          border:
                            isCurrent && !isSelected
                              ? "1.5px solid var(--accent)"
                              : "1px solid transparent",
                          opacity: dis ? 0.4 : 1,
                          cursor: dis ? "not-allowed" : "pointer",
                        }}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setViewMode("year")}
                  >
                    ← Years
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}

            {/* ── Day grid ───────────────────────────────────────────── */}
            {viewMode === "day" && (
              <>
                <NavHeader
                  onPrev={() => shiftMonth(-1)}
                  onNext={() => shiftMonth(1)}
                  prevAriaLabel="Previous month"
                  nextAriaLabel="Next month"
                  onLabelClick={() => setViewMode("year")}
                  labelAriaLabel="Select year and month"
                  nextDisabled={(() => {
                    if (!max) return false;
                    const next = new Date(view.year, view.month + 1, 1);
                    return isoOf(next) > max;
                  })()}
                >
                  {monthLabel}
                </NavHeader>

                {/* Weekday header */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, 1fr)",
                    gap: 4,
                    marginBottom: 6,
                  }}
                >
                  {WEEKDAY_HEADERS.map((h) => (
                    <div
                      key={h}
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--text-tertiary)",
                        textAlign: "center",
                        padding: "4px 0",
                        fontWeight: 600,
                      }}
                    >
                      {h}
                    </div>
                  ))}
                </div>

                {/* Day grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, 1fr)",
                    gap: 4,
                  }}
                >
                  {cells.map(({ iso, date, inMonth }) => {
                    const dayDisabled = isDisabled(iso);
                    const isSelected = iso === value;
                    const isToday = iso === todayStr;
                    const dayNum = date.getDate();
                    return (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => !dayDisabled && pick(iso)}
                        disabled={dayDisabled}
                        aria-label={iso}
                        aria-pressed={isSelected}
                        style={{
                          aspectRatio: "1 / 1",
                          border: isToday
                            ? "1.5px solid var(--accent)"
                            : "1px solid transparent",
                          borderRadius: 8,
                          background: isSelected
                            ? "var(--accent)"
                            : dayDisabled
                              ? "transparent"
                              : "var(--bg-sunken)",
                          color: isSelected
                            ? "white"
                            : !inMonth
                              ? "var(--text-quaternary, var(--text-tertiary))"
                              : dayDisabled
                                ? "var(--text-tertiary)"
                                : "var(--text)",
                          fontSize: 13,
                          fontWeight: isSelected ? 600 : isToday ? 600 : 500,
                          cursor: dayDisabled ? "not-allowed" : "pointer",
                          opacity: !inMonth && !isSelected ? 0.4 : 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition:
                            "background 80ms ease, transform 80ms ease",
                          fontFamily: "var(--font-sans)",
                        }}
                        onMouseEnter={(e) => {
                          if (dayDisabled || isSelected) return;
                          e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (dayDisabled || isSelected) return;
                          e.currentTarget.style.background =
                            "var(--bg-sunken)";
                        }}
                      >
                        {dayNum}
                      </button>
                    );
                  })}
                </div>

                {/* Footer shortcuts */}
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const t = todayIso();
                      if (!isDisabled(t)) pick(t);
                    }}
                    disabled={isDisabled(todayIso())}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
