// Small local building blocks shared by the workflow pages (Approvals,
// My requests, Shift policies, Leave & calendar, Notifications). Every
// visual primitive here is a thin wrapper over the design-archive
// classes restyled by theme/modern.css — pills, tabs, section labels,
// alerts, plus FormModal / FormSteps / FormFootBar (the FormKit
// centred-modal + wizard wrappers used by every workflow form). Stat cards come from components/ListPageUi
// (StatCard / StatGrid); nothing here duplicates them.

import { useId, type FormEvent, type ReactNode } from "react";

import { ModalShell } from "../components/DrawerShell";
import { FormHeader } from "../components/FormKit";
import { Icon } from "../shell/Icon";
import "./workflow.css";

export type SoftTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

/** Status pill — the design's `.pill pill-<tone>` with an optional dot. */
export function SoftPill({
  tone,
  children,
  title,
  dot = true,
}: {
  tone: SoftTone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {dot && <span aria-hidden className="pill-dot" />}
      {children}
    </span>
  );
}

/** Underline tab strip (design `.tabs` / `.tab`). */
export function TabStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="tablist" aria-label={label} className="tabs wf-tabs">
      {children}
    </div>
  );
}

export function TabButton({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number | null;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`tab${active ? " active" : ""}`}
    >
      {children}
      {count !== undefined && count !== null && <span className="wf-tab-count">{count}</span>}
    </button>
  );
}

/** Card shell for a data table — `.card` + horizontal overflow guard. */
export function TableCard({ children, head }: { children: ReactNode; head?: ReactNode }) {
  return (
    <div className="card wf-table-card">
      {head}
      {children}
    </div>
  );
}

/** Section heading row inside a page: title + optional sub + actions. */
export function SectionHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="wf-section-head">
      <div className="wf-grow">
        <h2 className="wf-section-title">{title}</h2>
        {sub && <p className="wf-section-sub">{sub}</p>}
      </div>
      {actions && <div className="wf-row">{actions}</div>}
    </div>
  );
}

/** Small in-form / in-drawer section label with a trailing rule. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="wf-section-label">{children}</div>;
}

/** Inline alert (danger by default). */
export function Alert({
  tone = "danger",
  children,
  role = "alert",
}: {
  tone?: "danger" | "success" | "warning" | "neutral";
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div role={role} className={`wf-alert${tone === "neutral" ? "" : ` wf-alert-${tone}`}`}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form modal — the FormKit standard for small forms / confirmations
// ---------------------------------------------------------------------------

/** Centred ``<form className="modal fk-modal">`` with the FormKit header,
 *  an ``fk-body`` and whatever footer the caller passes (usually
 *  ``FormFooter``). ModalShell supplies the portal, scrim + focus trap.
 *  The submit event is stopped here so it never bubbles (through the
 *  React portal) into an ancestor form. */
export function FormModal({
  onClose,
  onSubmit,
  icon,
  eyebrow,
  title,
  subtitle,
  size = "md",
  busy,
  steps,
  footer,
  children,
}: {
  onClose: () => void;
  /** Receives the submit event; ``preventDefault`` is already called. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  icon?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** While true the header close button is inert (a request is in flight). */
  busy?: boolean;
  /** Optional stepper strip rendered under the header (wizards). */
  steps?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <ModalShell onClose={onClose}>
      <div className="wf-fk-host">
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`modal fk-modal wf-fk-${size}`}
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSubmit?.(e);
          }}
        >
          <FormHeader
            icon={icon}
            eyebrow={eyebrow}
            title={title}
            subtitle={subtitle}
            titleId={titleId}
            onClose={busy ? () => undefined : onClose}
          />
          {steps}
          <div className="fk-body">{children}</div>
          {footer}
        </form>
      </div>
    </ModalShell>
  );
}

/** Horizontal stepper for multi-step (wizard) forms. */
export function FormSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="wf-fk-steps">
      {steps.map((label, i) => {
        const state = i < current ? "is-done" : i === current ? "is-current" : "";
        return (
          <li key={label} className={`wf-fk-step ${state}`} aria-current={i === current ? "step" : undefined}>
            <span className="wf-fk-step-dot" aria-hidden>
              {i < current ? <Icon name="check" size={11} /> : i + 1}
            </span>
            <span className="wf-fk-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Footer bar in the FormKit look with free-form content — for wizard
 *  steps whose actions don't fit FormFooter's Cancel + submit pair. */
export function FormFootBar({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="drawer-foot fk-foot">
      <div className="fk-foot-note">{start}</div>
      <div className="fk-foot-actions">{children}</div>
    </div>
  );
}

/** Stroke icons for stat cards / empty states (24×24 children). */
export const WF_ICON = {
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  clockAlert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  x: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
} as const;

export function WfSvg({ children, size = 30 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

/** Pull a human-readable message out of an ApiError-ish body. */
export function errorDetail(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const body = (err as { body?: unknown }).body as { detail?: unknown } | null | undefined;
    if (body && typeof body.detail === "string") return body.detail;
    if (body && body.detail && typeof body.detail === "object") {
      const m = (body.detail as { message?: unknown }).message;
      if (typeof m === "string") return m;
    }
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return `${fallback} (${status})`;
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}
