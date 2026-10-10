// Local presentational helpers for the People area (Employees, My team,
// Photo approvals, Bulk photo upload, My profile, Users, Manager
// assignments). Kept here rather than in components/ so the shared
// ListPageUi module stays untouched. Every stat tile is the SHARED
// StatCard from ListPageUi — this module only adds thin wrappers plus
// the few layout bits (sections, banners, drawer tabs) that the design
// archive has no class for. Page-specific CSS lives in people.css.

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyPanel, StatCard, type StatTone } from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";

import "./people.css";

const noop = () => {};

/** Thin re-export of the shared StatCard. When no ``onClick`` is given
 *  the tile is still rendered by StatCard (same visuals) but is inert. */
export function StatTile({
  tone,
  icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  tone: StatTone;
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <StatCard
      tone={tone}
      icon={icon}
      label={label}
      value={value}
      sub={sub}
      active={!!active}
      onClick={onClick ?? noop}
    />
  );
}

/** Stroke-icon paths for the People-area stat cards (24×24 viewBox). */
export const PEOPLE_ICON = {
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  cameraOff: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <path d="M9.5 10.5l5 5M14.5 10.5l-5 5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </>
  ),
  x: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5l8-2v18M12 8h8v13M4 21h16" />
      <path d="M7.5 8h1M7.5 12h1M7.5 16h1M15.5 12h1M15.5 16h1" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </>
  ),
  star: (
    <>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z" />
    </>
  ),
} as const;

/** Card wrapper used around tables / grids on People pages. */
export function ListCard({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

const PILL_CLASS: Record<StatTone, string> = {
  info: "pill-info",
  success: "pill-success",
  warning: "pill-warning",
  danger: "pill-danger",
  neutral: "pill-neutral",
};

/** Soft status pill with a coloured dot — the design's .pill + .pill-dot. */
export function DotPill({
  tone,
  children,
  title,
}: {
  tone: StatTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className={`pill ${PILL_CLASS[tone]} pp-nowrap`}>
      <span aria-hidden className="pill-dot" />
      {children}
    </span>
  );
}

/** Section heading used inside drawers / cards to group related fields. */
export function Section({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pp-section">
      <div className="pp-section-head">
        <div>
          <div className="pp-section-title">{title}</div>
          {sub && <div className="pp-section-sub">{sub}</div>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Responsive form grid: ``cols`` columns on desktop, one at 720px. */
export function FormGrid({ cols = 2, children }: { cols?: number; children: ReactNode }) {
  return (
    <div className="pp-form-grid" style={{ ["--pp-cols" as string]: cols } as React.CSSProperties}>
      {children}
    </div>
  );
}

export type BannerTone = "info" | "warning" | "danger" | "success" | "neutral";

/** Inline notice: title + body + optional actions. */
export function Banner({
  tone = "neutral",
  title,
  children,
  actions,
  role,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div role={role} className={`pp-banner${tone === "neutral" ? "" : ` pp-banner-${tone}`}`}>
      {title && <div className="pp-banner-title">{title}</div>}
      {children && <div className="pp-banner-body">{children}</div>}
      {actions && <div className="pp-banner-actions">{actions}</div>}
    </div>
  );
}

/** Drawer tab strip using the design's .tabs / .tab classes. */
export function DrawerTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ key: K; label: string; count?: number | null }>;
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div className="pp-drawer-tabs">
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tb) => {
          const active = tb.key === value;
          return (
            <button
              key={tb.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tab${active ? " active" : ""}`}
              onClick={() => onChange(tb.key)}
            >
              {tb.label}
              {tb.count != null && (
                <span className={`pill ${active ? "pill-accent" : "pill-neutral"}`} style={{ marginInlineStart: 6 }}>
                  {tb.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Accessible on/off switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="pp-switch"
    >
      <span className="pp-switch-knob" />
    </button>
  );
}

/** Standard "couldn't load" panel with a Retry action (brief: state 2). */
export function LoadErrorPanel({
  title,
  body,
  onRetry,
}: {
  title: string;
  body?: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <EmptyPanel
      tone="danger"
      icon={<Icon name="info" size={28} />}
      title={title}
      body={
        body ??
        (t("people.loadErrorBody", {
          defaultValue: "The server didn't respond as expected. Check your connection and try again.",
        }) as string)
      }
      actions={
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" size={12} />
          {t("people.retry", { defaultValue: "Retry" }) as string}
        </button>
      }
    />
  );
}

/** Avatar circle sized by variant; colour comes from the caller. */
export function Avatar({
  name,
  color,
  size = "sm",
}: {
  name: string;
  color: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={`avatar pp-avatar${size === "sm" ? "" : ` pp-avatar-${size}`}`}
      aria-hidden
      style={{ background: color }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

/**
 * Horizontal stepper band for multi-step forms (wizards, import). Sits
 * directly under ``FormHeader``. ``current`` is 1-based; pass
 * ``current = steps.length + 1`` to show every step as done.
 * Local until the shared form kit grows one
 * (see /tmp/ui-agents/v2/kit-requests-people.md).
 */
export function FormStepper({
  steps,
  current,
  label,
}: {
  steps: string[];
  current: number;
  label: string;
}) {
  return (
    <ol className="pp-stepper" aria-label={label}>
      {steps.map((s, i) => {
        const n = i + 1;
        const state = n < current ? "is-done" : n === current ? "is-active" : "";
        return (
          <Fragment key={s}>
            {i > 0 && <li aria-hidden className={`pp-stepper-line${n <= current ? " is-done" : ""}`} />}
            <li className={`pp-stepper-item ${state}`} aria-current={n === current ? "step" : undefined}>
              <span className="pp-stepper-dot" aria-hidden>
                {n < current ? <Icon name="check" size={11} /> : n}
              </span>
              {s}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
