// Themed date picker — replaces native <input type="date"> on surfaces
// that need a larger, theme-aware popover. Disables future dates by
// default; honours an optional ``min`` lower bound so a "to" picker
// can't drop below its paired "from" date.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

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
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const seed = parseIso(value) ?? (max ? parseIso(max) : null) ?? new Date();
    const d = seed instanceof Date ? seed : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();

  // Keep the visible month aligned with ``value`` when it changes from
  // the outside (preset chips, paired picker snap).
  useEffect(() => {
    const d = parseIso(value);
    if (!d) return;
    setView({ year: d.getFullYear(), month: d.getMonth() });
  }, [value]);

  // Click-outside + Esc to close.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  const cells = useMemo(() => {
    // Render a 6 × 7 grid starting Monday so the layout is stable
    // (avoids 5 vs. 6 row height jitter between months).
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

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={ariaLabel ?? "Date picker"}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineStart: 0,
            zIndex: 60,
            width: 340,
            padding: 14,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md, 10px)",
            boxShadow:
              "0 10px 30px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
          }}
        >
          {/* Header: month nav */}
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
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              style={{ padding: "4px 8px" }}
            >
              ‹
            </button>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text)",
                letterSpacing: "0.01em",
              }}
            >
              {monthLabel}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              style={{ padding: "4px 8px" }}
              disabled={(() => {
                if (!max) return false;
                const next = new Date(view.year, view.month + 1, 1);
                return isoOf(next) > max;
              })()}
            >
              ›
            </button>
          </div>

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
              const disabled = isDisabled(iso);
              const isSelected = iso === value;
              const isToday = iso === todayStr;
              const dayNum = date.getDate();
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => !disabled && pick(iso)}
                  disabled={disabled}
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
                      : disabled
                        ? "transparent"
                        : "var(--bg-sunken)",
                    color: isSelected
                      ? "white"
                      : !inMonth
                        ? "var(--text-quaternary, var(--text-tertiary))"
                        : disabled
                          ? "var(--text-tertiary)"
                          : "var(--text)",
                    fontSize: 13,
                    fontWeight: isSelected ? 600 : isToday ? 600 : 500,
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: !inMonth && !isSelected ? 0.4 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 80ms ease, transform 80ms ease",
                    fontFamily: "var(--font-sans)",
                  }}
                  onMouseEnter={(e) => {
                    if (disabled || isSelected) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (disabled || isSelected) return;
                    e.currentTarget.style.background = "var(--bg-sunken)";
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
        </div>
      )}
    </div>
  );
}
