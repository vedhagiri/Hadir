// Shared building blocks for list pages (Cameras, Devices): clickable
// status stat cards, the search field, the custom filter dropdown, the
// reset button and the empty-state panel. One module so every list
// page looks and behaves the same.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../shell/Icon";

export const FIELD_H = 40;

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

export const STAT_TONE = {
  info: { bg: "var(--info-soft)", fg: "var(--info-text)" },
  success: { bg: "var(--success-soft)", fg: "var(--success-text)" },
  warning: { bg: "var(--warning-soft)", fg: "var(--warning-text)" },
  danger: { bg: "var(--danger-soft)", fg: "var(--danger-text)" },
  neutral: { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" },
} as const;

export type StatTone = keyof typeof STAT_TONE;

/** Clickable status summary card — doubles as the status filter. */
export function StatCard({
  tone,
  icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  tone: StatTone;
  /** SVG children drawn in a 24×24 stroke icon. */
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  const c = STAT_TONE[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="card"
      style={{
        appearance: "none",
        font: "inherit",
        textAlign: "start",
        cursor: "pointer",
        padding: 8,
        border: active ? `1.5px solid ${c.fg}` : "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: 14,
          borderRadius: 10,
          background: `color-mix(in oklab, ${c.bg} 70%, var(--bg-elev))`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 56,
            height: 56,
            flex: "0 0 56px",
            borderRadius: "50%",
            background: c.bg,
            color: c.fg,
            display: "grid",
            placeItems: "center",
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: tone === "info" || tone === "neutral" ? "var(--text)" : c.fg }}>
            {label}
          </span>
          <span className="mono" style={{ display: "block", fontSize: 26, fontWeight: 700, lineHeight: 1.2, color: "var(--text)" }}>
            {value}
          </span>
          <span style={{ display: "block", fontSize: 12.5, color: "var(--text-secondary)" }}>{sub}</span>
        </span>
        <span
          aria-hidden
          style={{
            alignSelf: "flex-start",
            width: 22,
            height: 22,
            borderRadius: "50%",
            border: `1.5px solid ${c.fg}`,
            color: c.fg,
            display: "grid",
            placeItems: "center",
            opacity: 0.8,
          }}
        >
          <Icon name="chevronRight" size={11} />
        </span>
      </div>
    </button>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: search + filters + reset
// ---------------------------------------------------------------------------

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 12, marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  clearLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  clearLabel: string;
}) {
  return (
    <label
      style={{
        flex: "1 1 340px",
        minWidth: 220,
        height: FIELD_H,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-elev)",
        cursor: "text",
      }}
    >
      <span aria-hidden style={{ color: "var(--text-tertiary)", display: "inline-flex" }}>
        <Icon name="search" size={15} />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          border: "none",
          outline: "none",
          background: "transparent",
          color: "var(--text)",
          fontSize: 13.5,
          fontFamily: "inherit",
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          title={clearLabel}
          style={{
            appearance: "none",
            border: "none",
            background: "var(--bg-sunken)",
            color: "var(--text-secondary)",
            width: 22,
            height: 22,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </label>
  );
}

export function ResetButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!active}
      style={{
        appearance: "none",
        height: FIELD_H,
        padding: "0 14px",
        marginInlineStart: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-elev)",
        color: active ? "var(--text)" : "var(--text-tertiary)",
        fontSize: 13,
        fontWeight: 500,
        fontFamily: "inherit",
        cursor: active ? "pointer" : "default",
        opacity: active ? 1 : 0.7,
      }}
    >
      <Icon name="refresh" size={13} />
      {label}
    </button>
  );
}

/** Filter dropdown: a button trigger ("Status: All status") that opens
 *  a styled menu. Replaces the native <select>, whose open list is
 *  drawn by the OS and can't match the app. Keyboard: Enter/Space/↓
 *  open, ↑/↓ move, Enter selects, Esc closes and returns focus. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const active = value !== "";
  const current = options.find(([v]) => v === value)?.[1] ?? options[0]?.[1] ?? "";

  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, options.findIndex(([v]) => v === value)));
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[hi];
      if (opt) choose(opt[0]);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }} onKeyDown={onKey}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current}`}
        onClick={() => setOpen((o) => !o)}
        style={{
          appearance: "none",
          height: FIELD_H,
          minWidth: 176,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "0 12px",
          border: `1px solid ${open || active ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 10,
          background: active ? "var(--accent-soft)" : "var(--bg-elev)",
          boxShadow: open ? "0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent)" : "none",
          color: "var(--text)",
          fontFamily: "inherit",
          fontSize: 13,
          cursor: "pointer",
          textAlign: "start",
        }}
      >
        <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{label}:</span>
        <span style={{ fontWeight: 600, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{current}</span>
        <span
          aria-hidden
          style={{ display: "inline-flex", color: "var(--text-secondary)", transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms ease" }}
        >
          <Icon name="chevronDown" size={13} />
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={label}
          style={{
            position: "absolute",
            top: FIELD_H + 6,
            insetInlineStart: 0,
            minWidth: "100%",
            maxHeight: 280,
            overflowY: "auto",
            margin: 0,
            padding: 6,
            listStyle: "none",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.14)",
            zIndex: 50,
          }}
        >
          {options.map(([v, l], idx) => {
            const selected = v === value;
            return (
              <li
                key={v || "_all"}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setHi(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: selected ? 600 : 500,
                  color: selected ? "var(--accent-text, var(--accent))" : "var(--text)",
                  background: idx === hi ? "var(--bg-sunken)" : "transparent",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ flex: 1 }}>{l}</span>
                <span aria-hidden style={{ width: 14, display: "inline-flex", color: "var(--accent)" }}>
                  {selected && <Icon name="check" size={14} />}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function EmptyPanel({
  tone = "neutral",
  icon,
  title,
  body,
  actions,
}: {
  tone?: StatTone | "accent";
  icon: ReactNode;
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  const c = tone === "accent" ? { bg: "var(--accent-soft)", fg: "var(--accent)" } : STAT_TONE[tone];
  return (
    <div style={{ padding: "56px 24px 52px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          background: c.bg,
          color: c.fg,
          display: "grid",
          placeItems: "center",
          marginBottom: 6,
          boxShadow: `0 0 0 8px color-mix(in oklab, ${c.bg} 45%, transparent)`,
        }}
      >
        {icon}
      </span>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)" }}>{title}</h3>
      <p style={{ margin: 0, maxWidth: 460, fontSize: 13.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>{body}</p>
      {actions && <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", justifyContent: "center" }}>{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List / grid view toggle (remembered per page in localStorage)
// ---------------------------------------------------------------------------

export type ViewMode = "list" | "grid";

export function useViewMode(storageKey: string): [ViewMode, (v: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(storageKey) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const set = (v: ViewMode) => {
    setMode(v);
    try {
      localStorage.setItem(storageKey, v);
    } catch {
      /* private mode — keep in memory only */
    }
  };
  return [mode, set];
}

export function ViewToggle({
  value,
  onChange,
  listLabel,
  gridLabel,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  listLabel: string;
  gridLabel: string;
}) {
  const btn = (mode: ViewMode, label: string, icon: ReactNode) => {
    const on = value === mode;
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        title={label}
        onClick={() => onChange(mode)}
        style={{
          appearance: "none",
          width: 36,
          height: FIELD_H - 8,
          display: "grid",
          placeItems: "center",
          border: "none",
          borderRadius: 7,
          background: on ? "var(--bg-elev)" : "transparent",
          color: on ? "var(--accent)" : "var(--text-tertiary)",
          boxShadow: on ? "0 1px 3px rgba(15, 23, 42, 0.12)" : "none",
          cursor: "pointer",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {icon}
        </svg>
      </button>
    );
  };
  return (
    <div
      role="group"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 3,
        height: FIELD_H,
        borderRadius: 10,
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
      }}
    >
      {btn("list", listLabel, <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />)}
      {btn("grid", gridLabel, <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>)}
    </div>
  );
}

/** Responsive card grid for the grid view. */
export function CardGrid({ children, minWidth = 300 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(${minWidth}px, 100%), 1fr))`, gap: 16 }}>
      {children}
    </div>
  );
}

/** One labelled fact row inside a grid card. */
export function CardFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 12.5, minHeight: 22 }}>
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 500, textAlign: "end", minWidth: 0 }}>{children}</span>
    </div>
  );
}

export const gridCardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--bg-elev)",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
} as const;

// ---------------------------------------------------------------------------
// Kebab (⋮) menu for grid cards
// ---------------------------------------------------------------------------

export interface KebabItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export function KebabMenu({ items, label }: { items: KebabItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        style={{
          appearance: "none",
          width: 30,
          height: 30,
          display: "grid",
          placeItems: "center",
          border: "none",
          borderRadius: 8,
          background: open ? "var(--bg-sunken)" : "transparent",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <Icon name="moreVertical" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: 34,
            insetInlineEnd: 0,
            minWidth: 180,
            padding: 6,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.14)",
            zIndex: 40,
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              style={{
                appearance: "none",
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: it.danger ? "var(--danger-text)" : "var(--text)",
                fontSize: 13,
                fontFamily: "inherit",
                cursor: "pointer",
                textAlign: "start",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-sunken)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Facts row with a leading icon (used in the camera card's info box). */
export function IconFact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, minHeight: 26 }}>
      <span aria-hidden style={{ color: "var(--text-tertiary)", display: "inline-flex", width: 16 }}>{icon}</span>
      <span style={{ color: "var(--text-secondary)", flex: 1 }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, textAlign: "end" }}>{children}</span>
    </div>
  );
}

export function pct(n: number, total: number): number {
  return total ? Math.round((100 * n) / total) : 0;
}
