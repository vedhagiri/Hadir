// Thin presentation helpers shared by the ops/system pages (System &
// Infra, Pipeline Monitor, Workers, Detection settings, Frame
// diagnostics). Everything here is a thin layer over the shared
// ListPageUi primitives + the design classes restyled by
// theme/modern.css; the only area-specific layout lives in ops.css.

import type { ReactNode } from "react";

import { StatCard, StatGrid, type StatTone } from "../../components/ListPageUi";

import "./ops.css";

export type { StatTone };

// ---------------------------------------------------------------------------
// Metric tile — the shared StatCard. Numeric values delegate to StatCard
// directly; preformatted strings ("0 / 3", "7.6 / 15 GB") render on the
// same ``mg-stat`` shell so the two are visually identical.
// ---------------------------------------------------------------------------

export function MetricTile({
  tone,
  icon,
  label,
  value,
  sub,
  onClick,
  active,
}: {
  tone: StatTone;
  /** SVG children drawn in a 24×24 stroke icon. */
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional — when present the tile becomes a toggle button. */
  onClick?: () => void;
  active?: boolean;
}) {
  if (typeof value === "number" && typeof sub === "string" && onClick) {
    return <StatCard tone={tone} icon={icon} label={label} value={value} sub={sub} active={!!active} onClick={onClick} />;
  }
  const text = typeof value === "string" ? value : typeof value === "number" ? value.toLocaleString() : null;
  const valueClass = `mg-stat-value${text && text.length > 12 ? " is-long" : text && /[^\d\s/·.%,]/.test(text) ? " is-text" : ""}`;
  const inner = (
    <>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon" aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
      </span>
      <span className={valueClass} title={text ?? undefined}>{text ?? value}</span>
      {sub !== undefined && sub !== "" && <span className="mg-stat-sub">{sub}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={!!active} className={`mg-stat ops-tile is-clickable tone-${tone}`}>
        {inner}
      </button>
    );
  }
  return <div className={`mg-stat ops-tile tone-${tone}`}>{inner}</div>;
}

export function MetricGrid({ children }: { children: ReactNode; min?: number }) {
  return <StatGrid>{children}</StatGrid>;
}

/** Stroke-icon paths for metric tiles (24×24 viewBox). */
export const METRIC_ICON = {
  camera: <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></>,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  users: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
  cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
  memory: <><rect x="2" y="7" width="20" height="10" rx="2" /><path d="M6 11v2M10 11v2M14 11v2M18 11v2" /></>,
  disk: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>,
  alert: <><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  x: <><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  queue: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  zap: <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  record: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" fill="currentColor" /></>,
  eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
} as const;

// ---------------------------------------------------------------------------
// Status pill — the design's .pill with a tone + leading dot.
// ---------------------------------------------------------------------------

export type PillTone = "success" | "warning" | "danger" | "info" | "neutral";

export function SoftPill({
  tone,
  children,
  title,
  dot = true,
  mono = false,
}: {
  tone: PillTone;
  children: ReactNode;
  title?: string | undefined;
  dot?: boolean;
  mono?: boolean;
}) {
  return (
    <span title={title} className={`pill pill-${tone}${mono ? " ops-pill-mono" : ""}`}>
      {dot && <span aria-hidden className="pill-dot" />}
      {children}
    </span>
  );
}

/** Small coloured status dot (optionally pulsing). */
export function StatusDot({ tone, pulse = false }: { tone: PillTone; pulse?: boolean }) {
  return <span aria-hidden className={`ops-dot tone-${tone}${pulse ? " is-pulse" : ""}`} />;
}

/** Thin progress bar. ``value`` is a percentage 0-100. */
export function ProgressBar({ value, tone = "info", thin = false, label }: { value: number; tone?: PillTone; thin?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={`ops-progress tone-${tone}${thin ? " is-thin" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <span className="ops-progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact count cells rendered inside a tab panel (not clickable).
// ---------------------------------------------------------------------------

export function CountStrip({ items }: { items: { label: string; value: number | string; tone: PillTone }[] }) {
  return (
    <div className="ops-count-grid">
      {items.map((item) => (
        <div key={item.label} className={`ops-count tone-${item.tone}`}>
          <span className="ops-count-label">{item.label}</span>
          <span className="ops-count-value">{typeof item.value === "number" ? item.value.toLocaleString() : item.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented tab strip (design .seg / .seg-btn).
// ---------------------------------------------------------------------------

export function TabStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="tablist" aria-label={label} className="seg ops-seg">
      {children}
    </div>
  );
}

export function FilledTab({
  active,
  onClick,
  children,
  id,
  controls,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  id?: string;
  controls?: string;
}) {
  return (
    <button type="button" role="tab" id={id} aria-selected={active} aria-controls={controls} onClick={onClick} className={`seg-btn${active ? " active" : ""}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Banner + section label + modal shell body.
// ---------------------------------------------------------------------------

export function Banner({ tone, icon, children, role }: { tone: PillTone; icon?: ReactNode; children: ReactNode; role?: string }) {
  return (
    <div className={`ops-banner tone-${tone}`} role={role}>
      {icon && <span className="ops-banner-icon" aria-hidden>{icon}</span>}
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="ops-section-label">{children}</h3>;
}

/** Centered modal panel body — wrap with ModalShell from DrawerShell.tsx. */
export function ModalPanel({
  title,
  sub,
  ariaLabel,
  headActions,
  wide = false,
  flush = false,
  children,
  footer,
}: {
  title: ReactNode;
  sub?: ReactNode;
  ariaLabel: string;
  headActions?: ReactNode;
  wide?: boolean;
  flush?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="ops-modal-host">
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} className={`modal ops-modal${wide ? " is-wide" : ""}`}>
      <div className="modal-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="modal-title">{title}</h2>
          {sub && <div className="modal-sub">{sub}</div>}
        </div>
        {headActions && <div className="modal-head-actions">{headActions}</div>}
      </div>
      <div className={`modal-body${flush ? " is-flush" : ""}`}>{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings card + labelled row.
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  sub,
  actions,
  children,
  footer,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="card ops-card-flush">
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>
          {sub && <p className="card-sub" style={{ margin: "3px 0 0" }}>{sub}</p>}
        </div>
        {actions && <div className="ops-inline">{actions}</div>}
      </div>
      <div className="ops-card-body" style={{ paddingTop: 0, paddingBottom: 0 }}>{children}</div>
      {footer}
    </section>
  );
}

/** Two-column labelled row: label + help on the start side, control on the end side. */
export function SettingRow({
  label,
  help,
  htmlFor,
  children,
  top = false,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  top?: boolean;
}) {
  return (
    <div className={`ops-setting-row${top ? " is-top" : ""}`}>
      <div>
        <label htmlFor={htmlFor} className="ops-setting-label">{label}</label>
        {help && <span className="ops-setting-hint">{help}</span>}
      </div>
      <div className="ops-setting-control">{children}</div>
    </div>
  );
}
