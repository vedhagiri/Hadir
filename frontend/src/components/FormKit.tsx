// Shared form kit for every Add / Edit drawer and modal.
//
// One visual language for forms across the app: a header with an icon
// tile + title + one-line purpose, titled sections (optionally numbered)
// with a short helper line, fields laid out on a 2-column grid (long
// fields span both), labels above inputs, a red ``*`` on required
// fields, helper text under the control, inline validation errors, and
// a sticky footer with a "* required" note on the start side and
// Cancel + the primary action on the end side.
//
// Markup only — lifecycle (portal, scrim, focus trap) stays in
// ``DrawerShell`` / ``ModalShell``. Styling lives in ./form-kit.css
// (prefix ``fk-``) on top of the global .drawer / .modal / .input /
// .select / .textarea / .btn classes restyled by theme/modern.css.
//
// Typical drawer:
//
//   <DrawerShell onClose={onClose}>
//     <form className="drawer fk-drawer" onSubmit={submit}>
//       <FormHeader icon={<Icon name="camera" size={18} />} title="Add camera"
//                   subtitle="Connect an RTSP stream to start capturing." onClose={onClose} />
//       <div className="drawer-body fk-body">
//         <FormSection step={1} title="Identity" description="How the camera shows up in lists.">
//           <Field label="Name" required htmlFor="cam-name" error={errors.name}>
//             <input id="cam-name" className="input" … />
//           </Field>
//           …
//         </FormSection>
//       </div>
//       <FormFooter onCancel={onClose} submitLabel="Add camera" submitting={busy} canSubmit={valid} />
//     </form>
//   </DrawerShell>

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";

import "./form-kit.css";

/** Drawer / modal header: icon tile · title · subtitle · close button. */
export function FormHeader({
  icon,
  eyebrow,
  title,
  subtitle,
  onClose,
  actions,
  titleId,
}: {
  icon?: ReactNode;
  /** Small uppercase label above the title (e.g. "New employee"). */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose?: () => void;
  /** Extra header controls rendered before the close button. */
  actions?: ReactNode;
  /** id for aria-labelledby on the dialog. */
  titleId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="drawer-head fk-head">
      {icon && (
        <span className="fk-head-icon" aria-hidden>
          {icon}
        </span>
      )}
      <div className="fk-head-text">
        {eyebrow && <div className="fk-eyebrow">{eyebrow}</div>}
        <h2 className="fk-title" id={titleId}>
          {title}
        </h2>
        {subtitle && <p className="fk-subtitle">{subtitle}</p>}
      </div>
      <div className="fk-head-actions">
        {actions}
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close", { defaultValue: "Close" })}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** A titled group of fields. ``columns={1}`` stacks every field. */
export function FormSection({
  step,
  title,
  description,
  aside,
  columns = 2,
  children,
}: {
  /** Optional step number shown in a small badge before the title. */
  step?: number;
  title: ReactNode;
  description?: ReactNode;
  /** End-aligned content in the section header (e.g. a toggle). */
  aside?: ReactNode;
  columns?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <section className="fk-section">
      <div className="fk-section-head">
        {step !== undefined && (
          <span className="fk-step" aria-hidden>
            {step}
          </span>
        )}
        <div className="fk-section-text">
          <h3 className="fk-section-title">{title}</h3>
          {description && <p className="fk-section-desc">{description}</p>}
        </div>
        {aside && <div className="fk-section-aside">{aside}</div>}
      </div>
      <div className={`fk-grid${columns === 1 ? " fk-grid-1" : ""}`}>{children}</div>
    </section>
  );
}

/** Label above the control, red ``*`` when required, help or error below. */
export function Field({
  label,
  htmlFor,
  required,
  help,
  error,
  span = 1,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  help?: ReactNode;
  /** Inline validation message; replaces ``help`` while present. */
  error?: ReactNode;
  /** 2 = full row on the 2-column grid. */
  span?: 1 | 2;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`fk-field${span === 2 ? " fk-span-2" : ""}${error ? " has-error" : ""}`}>
      <label className="fk-label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="fk-req" aria-label={t("form.required", { defaultValue: "required" })}>
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <span className="fk-error" role="alert">
          <Icon name="info" size={12} />
          {error}
        </span>
      ) : (
        help && <span className="fk-help">{help}</span>
      )}
    </div>
  );
}

/** A full-width row with a title, description and an on/off switch. */
export function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled,
  id,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className={`fk-switch-row${disabled ? " is-disabled" : ""}`} htmlFor={id}>
      <span className="fk-switch-text">
        <span className="fk-switch-label">{label}</span>
        {description && <span className="fk-switch-desc">{description}</span>}
      </span>
      <span className="fk-switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="fk-switch-track" aria-hidden>
          <span className="fk-switch-thumb" />
        </span>
      </span>
    </label>
  );
}

/** Mutually exclusive options as selectable cards (role="radiogroup"). */
export function ChoiceCards<V extends string>({
  label,
  value,
  onChange,
  options,
  columns = 2,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: Array<{ value: V; title: ReactNode; description?: ReactNode; icon?: ReactNode; disabled?: boolean }>;
  columns?: 2 | 3;
}) {
  return (
    <div className={`fk-choices fk-choices-${columns}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          className="fk-choice"
          onClick={() => onChange(o.value)}
        >
          {o.icon && (
            <span className="fk-choice-icon" aria-hidden>
              {o.icon}
            </span>
          )}
          <span className="fk-choice-text">
            <span className="fk-choice-title">{o.title}</span>
            {o.description && <span className="fk-choice-desc">{o.description}</span>}
          </span>
          <span className="fk-choice-check" aria-hidden>
            {value === o.value && <Icon name="check" size={11} />}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Inline banner inside a form (server error, warning, info). */
export function FormNotice({ tone = "info", title, children }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`fk-notice tone-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "success" ? "check" : "info"} size={15} />
      <div>
        {title && <div className="fk-notice-title">{title}</div>}
        {children && <div className="fk-notice-body">{children}</div>}
      </div>
    </div>
  );
}

/**
 * Sticky footer: "* required" note (or a custom note) on the start side,
 * Cancel + primary submit on the end side. The submit button is a real
 * ``type="submit"`` so Enter submits the surrounding <form>.
 */
export function FormFooter({
  onCancel,
  submitLabel,
  submitting,
  submittingLabel,
  canSubmit = true,
  danger,
  note,
  extra,
  showRequiredNote = true,
}: {
  onCancel: () => void;
  submitLabel: ReactNode;
  submitting?: boolean;
  submittingLabel?: ReactNode;
  canSubmit?: boolean;
  /** Destructive primary action (red). */
  danger?: boolean;
  note?: ReactNode;
  /** Extra buttons placed before Cancel (e.g. a ghost "Delete"). */
  extra?: ReactNode;
  showRequiredNote?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="drawer-foot fk-foot">
      <div className="fk-foot-note">
        {note ??
          (showRequiredNote && (
            <>
              <span className="fk-req">*</span> {t("form.requiredNote", { defaultValue: "Required fields" })}
            </>
          ))}
      </div>
      <div className="fk-foot-actions">
        {extra}
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
          {t("common.cancel", { defaultValue: "Cancel" })}
        </button>
        <button type="submit" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={!canSubmit || submitting}>
          {submitting && <span className="fk-spinner" aria-hidden />}
          {submitting ? (submittingLabel ?? submitLabel) : submitLabel}
        </button>
      </div>
    </div>
  );
}
