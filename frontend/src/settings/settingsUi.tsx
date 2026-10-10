// Local building blocks for the Settings hub pages. Kept inside
// settings/ (not components/) so the shared primitives stay untouched;
// every settings page imports from here so cards, setting rows, pills,
// alerts and modals look the same across Workspace, Branding, Email,
// ERP, Authentication, etc.
//
// All layout lives in ./settings.css (prefix ``st-``); the visual
// skin (card, card-head, card-title, pill, btn, modal …) comes from
// the global design classes restyled by theme/modern.css.

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyPanel } from "../components/ListPageUi";
import { ModalShell } from "../components/DrawerShell";
import { Field, FormFooter, FormHeader } from "../components/FormKit";
import { Icon } from "../shell/Icon";

import "./settings.css";

// ---------------------------------------------------------------------------
// Page scaffold: tabs + header + card stack
// ---------------------------------------------------------------------------

export function SettingsPage({
  title,
  subtitle,
  actions,
  wide,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Page-level actions (at most one ``btn-primary``). */
  actions?: ReactNode;
  /** Let the card stack use the full content width (tables). */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-sub">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      <div className={`st-stack${wide ? " st-stack-wide" : ""}`}>{children}</div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sectioned card: head (icon + title + sub + actions) · body · foot
// ---------------------------------------------------------------------------

export function SettingsCard({
  icon,
  title,
  description,
  actions,
  footer,
  footerNote,
  flush,
  tight,
  children,
  style,
  bodyStyle,
  id,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned head content (status pill, small buttons). */
  actions?: ReactNode;
  /** Footer content — usually the Save button. */
  footer?: ReactNode;
  /** Muted text on the start side of the footer. */
  footerNote?: ReactNode;
  /** Body with no padding (tables, lists that bring their own). */
  flush?: boolean;
  /** Body with 12px padding (tables inside cards). */
  tight?: boolean;
  children?: ReactNode;
  /** Back-compat — prefer CSS classes. */
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  id?: string;
}) {
  const bodyClass = flush ? "card-body st-card-body-flush" : tight ? "card-body st-card-body-tight" : "card-body";
  return (
    <section className="card st-card" style={style} id={id}>
      <header className="card-head st-card-head">
        {icon && (
          <span aria-hidden className="st-card-icon">
            {icon}
          </span>
        )}
        <div className="st-card-head-text">
          <h2 className="card-title">{title}</h2>
          {description && <p className="card-sub">{description}</p>}
        </div>
        {actions && <div className="st-card-actions">{actions}</div>}
      </header>
      {children && (
        <div className={bodyClass} style={bodyStyle}>
          {children}
        </div>
      )}
      {(footer || footerNote) && (
        <footer className="st-card-foot">
          {footerNote && <span className="st-card-foot-note">{footerNote}</span>}
          {footer}
        </footer>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Labelled setting row: label + help on the start side, control on the end.
// ---------------------------------------------------------------------------

export function SettingRow({
  label,
  help,
  htmlFor,
  children,
  last,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`st-row${last ? " st-row-last" : ""}`}>
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="st-row-label">
            {label}
          </label>
        ) : (
          <div className="st-row-label">{label}</div>
        )}
        {help && <div className="st-row-help">{help}</div>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form field (label above control) using the design's .field classes
// ---------------------------------------------------------------------------

/** Thin adapter over the shared form kit ``Field`` (kept for the
 *  pages that still use the ``span: boolean`` signature). */
export function FormField({
  label,
  help,
  htmlFor,
  span,
  required,
  error,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  /** Span every column of an ``st-form-grid`` / ``fk-grid``. */
  span?: boolean;
  required?: boolean;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field
      label={label}
      help={help}
      error={error}
      span={span ? 2 : 1}
      required={!!required}
      {...(htmlFor !== undefined ? { htmlFor } : {})}
    >
      {children}
    </Field>
  );
}

/** Toggle-style chip (weekend days, date formats, radio choices). */
export function ChoiceChip({
  on,
  onClick,
  disabled,
  role,
  sample,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** ``radio`` renders aria-checked, otherwise aria-pressed. */
  role?: "radio";
  sample?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const aria = role === "radio" ? { role: "radio" as const, "aria-checked": on } : { "aria-pressed": on };
  return (
    <button type="button" className="st-chip" onClick={onClick} disabled={disabled} title={title} {...aria}>
      {children}
      {sample !== undefined && <span className="st-chip-sample">{sample}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status pill — thin wrapper over the design's .pill classes
// ---------------------------------------------------------------------------

export type PillTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

export function SoftPill({
  tone,
  children,
  title,
  dot = true,
}: {
  tone: PillTone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {dot && <span className="pill-dot" aria-hidden />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline alert
// ---------------------------------------------------------------------------

export type AlertTone = "success" | "danger" | "warning" | "info" | "neutral";

export function InlineAlert({
  tone = "neutral",
  title,
  children,
  actions,
  role,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
}) {
  const iconName = tone === "success" ? "check" : tone === "danger" || tone === "warning" ? "info" : "info";
  return (
    <div className={`st-alert${tone === "neutral" ? "" : ` st-alert-${tone}`}`} role={role ?? (tone === "danger" ? "alert" : "status")}>
      <Icon name={iconName} size={14} className="st-alert-icon" />
      <div className="st-alert-body">
        {title && <strong className="st-alert-title">{title}</strong>}
        {children}
        {actions && <div className="st-alert-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Error state for a whole page/card: EmptyPanel in the danger tone + Retry. */
export function LoadErrorPanel({
  title,
  body,
  onRetry,
}: {
  title: string;
  body?: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <EmptyPanel
      tone="danger"
      icon={<Icon name="info" size={28} />}
      title={title}
      body={body ?? t("settingsUi.loadErrorBody", { defaultValue: "The server did not respond as expected. Check your connection and try again." })}
      actions={
        onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" size={12} />
            {t("settingsUi.retry", { defaultValue: "Retry" })}
          </button>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Facts grid
// ---------------------------------------------------------------------------

export function Facts({ children }: { children: ReactNode }) {
  return <div className="st-facts">{children}</div>;
}

export function Fact({
  label,
  icon,
  value,
  mono,
  full,
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  value?: ReactNode;
  mono?: boolean;
  full?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`st-fact${full ? " st-fact-full" : ""}`}>
      <div className="st-fact-label">
        {icon}
        {label}
      </div>
      <div className={`st-fact-value${mono ? " mono" : ""}`}>{children ?? value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Person chip (org-structure tables)
// ---------------------------------------------------------------------------

export function PersonChip({ name, title }: { name: string; title?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="st-person" title={title}>
      <span aria-hidden className="st-person-avatar">
        {initials || "?"}
      </span>
      <span className="st-person-name">{name}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Table wrapper + helpers
// ---------------------------------------------------------------------------

/** Card holding a table: no inner padding, horizontal scroll on narrow. */
export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="card st-card">
      <div className="st-table-wrap">{children}</div>
    </div>
  );
}

export const nowrap: CSSProperties = { whiteSpace: "nowrap" };

// ---------------------------------------------------------------------------
// Centred modal — ModalShell renders only the scrim, so the panel
// carries its own fixed centring host. Uses the design's .modal skin.
// ---------------------------------------------------------------------------

export function SettingsModal({
  title,
  subtitle,
  onClose,
  closeLabel,
  width,
  footer,
  labelledBy,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  width?: number;
  footer?: ReactNode;
  labelledBy?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = labelledBy ?? "st-modal-title";
  return (
    <ModalShell onClose={onClose}>
      <div className="st-modal-host">
        <div
          className="modal st-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={width ? ({ ["--st-modal-w" as string]: `${width}px` } as CSSProperties) : undefined}
        >
          <div className="modal-head">
            <div className="modal-head-text">
              <h2 className="modal-title" id={titleId}>
                {title}
              </h2>
              {subtitle && <p className="modal-sub">{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel ?? t("common.close")}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Form-kit modal: ModalShell + centring host + <form class="modal fk-modal">
// with the kit's header; body + footer supplied by the caller.
// ---------------------------------------------------------------------------

export function SettingsFormModal({
  icon,
  title,
  subtitle,
  onClose,
  onSubmit,
  footer,
  size = "md",
  tone,
  titleId,
  children,
}: {
  /** ``danger`` tints the header icon tile red (destructive confirms). */
  tone?: "danger";
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** Called on submit (Enter / primary button); default is prevented. */
  onSubmit?: () => void;
  /** Usually a kit ``<FormFooter>``. */
  footer?: ReactNode;
  /** md = 520px, lg = 640px, xl = 760px. */
  size?: "md" | "lg" | "xl";
  titleId: string;
  children: ReactNode;
}) {
  const handle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit?.();
  };
  return (
    <ModalShell onClose={onClose}>
      <div className="st-fk-host">
        <form
          className={`modal fk-modal st-fk-modal st-fk-${size}${tone === "danger" ? " st-fk-danger" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onSubmit={handle}
          noValidate
        >
          <FormHeader icon={icon} title={title} subtitle={subtitle} onClose={onClose} titleId={titleId} />
          <div className="fk-body">{children}</div>
          {footer}
        </form>
      </div>
    </ModalShell>
  );
}

/** Destructive / confirm dialog built on the same kit parts. */
export function ConfirmModal({
  icon,
  title,
  subtitle,
  children,
  confirmLabel,
  busy,
  danger = true,
  onConfirm,
  onClose,
  titleId,
  canConfirm = true,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  confirmLabel: ReactNode;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  titleId: string;
  canConfirm?: boolean;
}) {
  return (
    <SettingsFormModal
      icon={icon ?? <Icon name="trash" size={18} />}
      {...(danger ? { tone: "danger" as const } : {})}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onSubmit={() => {
        if (!busy && canConfirm) onConfirm();
      }}
      titleId={titleId}
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={confirmLabel}
          submitting={!!busy}
          canSubmit={canConfirm}
          danger={danger}
          showRequiredNote={false}
        />
      }
    >
      {children}
    </SettingsFormModal>
  );
}

/** Footer for modals whose actions apply immediately (no submit). */
export function CloseFooter({ onClose, note, label }: { onClose: () => void; note?: ReactNode; label?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="drawer-foot fk-foot">
      <div className="fk-foot-note">{note}</div>
      <div className="fk-foot-actions">
        <button type="button" className="btn" onClick={onClose}>
          {label ?? t("common.close")}
        </button>
      </div>
    </div>
  );
}
