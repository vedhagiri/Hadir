// Dashboard building blocks. Everything here is a thin layer over the
// shared list-page primitives in components/ListPageUi.tsx (the
// ``mg-stat`` card, EmptyPanel) and the design's ``.card`` / ``.pill``
// classes, plus the small layout helpers in ./dash.css (prefix dsh-).
// Also reused by the Super-Admin console.

import type { ReactNode } from "react";

import { EmptyPanel, StatCard, StatGrid } from "../../components/ListPageUi";
import type { StatTone } from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";

import "./dash.css";

export { StatCard, StatGrid };

export type Tone = StatTone | "accent";

// ---------------------------------------------------------------------------
// Stat tile — the shared ``mg-stat`` card, extended for dashboard use:
// string values ("5/175", "636 GB", "Absent"), navigate-on-click, an
// optional footer (sparkline), and a static (non-interactive) variant.
// ---------------------------------------------------------------------------

export function Tile({
  tone,
  icon,
  label,
  value,
  sub,
  onClick,
  active,
  extra,
  title,
}: {
  tone: Tone;
  icon: IconName;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  extra?: ReactNode;
  title?: string;
}) {
  const textValue = typeof value === "string" && !/\d/.test(value);
  const inner = (
    <>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon" aria-hidden>
          <Icon name={icon} size={20} />
        </span>
      </span>
      <span className={`mg-stat-value dsh-clip${textValue ? " dsh-value-text" : ""}`}>{value}</span>
      {sub !== undefined && sub !== null && sub !== "" && <span className="mg-stat-sub dsh-clip">{sub}</span>}
      {extra && (
        <span aria-hidden className="dsh-stat-extra">
          {extra}
        </span>
      )}
    </>
  );
  if (!onClick) {
    return (
      <div className={`mg-stat tone-${tone} dsh-static`} title={title}>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`mg-stat tone-${tone}`}
      onClick={onClick}
      title={title}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
    >
      {inner}
    </button>
  );
}

export function TileGrid({ children }: { children: ReactNode }) {
  return <StatGrid>{children}</StatGrid>;
}

// ---------------------------------------------------------------------------
// Panel — a .card with the design's head / body
// ---------------------------------------------------------------------------

export function Panel({
  title,
  sub,
  actions,
  children,
  bodyPadding,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** ``0`` renders the body flush (tables). Other values are ignored —
   *  the design's ``.card-body`` padding applies. */
  bodyPadding?: number | string;
  className?: string;
}) {
  const flush = bodyPadding === 0;
  return (
    <section className={`card dsh-panel${className ? ` ${className}` : ""}`}>
      <header className="card-head">
        <div>
          <h3 className="card-title">{title}</h3>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {actions && <div className="dsh-panel-actions">{actions}</div>}
      </header>
      <div className={`card-body dsh-panel-body${flush ? " dsh-flush" : ""}`}>{children}</div>
    </section>
  );
}

/** Compact empty / error state for use inside a dashboard panel. */
export function PanelEmpty({
  icon,
  title,
  body,
  action,
  tone = "neutral",
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="dsh-panel-empty">
      <EmptyPanel tone={tone} icon={<Icon name={icon} size={22} />} title={title} body={body ?? ""} actions={action} />
    </div>
  );
}

/** Error state with a Retry action, for widgets whose query failed. */
export function PanelError({ title, body, retryLabel, onRetry }: { title: string; body: string; retryLabel: string; onRetry: () => void }) {
  return (
    <PanelEmpty
      tone="danger"
      icon="info"
      title={title}
      body={body}
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Soft status pill — the design's .pill with a dot
// ---------------------------------------------------------------------------

export function SoftPill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span aria-hidden className="pill-dot" />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Segmented bar + legend (status breakdown, storage)
// ---------------------------------------------------------------------------

export type BarTone = Tone | "free";

export function SegmentBar({ segments, label }: { segments: Array<{ tone: BarTone; value: number; title?: string }>; label?: string }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  return (
    <div className="dsh-bar" role="img" aria-label={label}>
      {total === 0 ? (
        <div className="dsh-bar-seg is-free" style={{ flex: 1 }} />
      ) : (
        segments.map((s, i) =>
          s.value > 0 ? <div key={i} className={`dsh-bar-seg is-${s.tone}`} style={{ flex: s.value }} title={s.title} /> : null,
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

export const nowrap = { whiteSpace: "nowrap" } as const;

/** "07:32:10" / ISO timestamp → "07:32". Attendance in/out times come
 *  over the wire as wall-clock ``HH:MM:SS`` strings, which ``new Date``
 *  can't parse. */
export function clockTime(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /^(\d{2}):(\d{2})/.exec(v);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
