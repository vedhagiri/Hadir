// Shared presentation pieces for the core pages (Cameras · Devices ·
// Calendar): the inline switch control, inline alerts, the centred modal frame and the status pill. One
// module so the three pages read as one product; ``core.css`` (the
// area's single stylesheet) is imported from here.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";

import "./core.css";

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

/** iOS-style toggle (role="switch"). */
export function Switch({
  checked,
  onChange,
  title,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  title?: string;
  /** Accessible name when the switch has no visible label next to it. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? title}
      disabled={disabled}
      onClick={disabled ? undefined : onChange}
      title={title}
      className="co-switch"
    />
  );
}

// Form helpers (FormSection / FormField / SwitchRow) moved to the shared
// FormKit (components/FormKit.tsx) — use those for every Add/Edit form.

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function InlineAlert({
  tone = "danger",
  children,
  onClose,
}: {
  tone?: "danger" | "success" | "info";
  children: ReactNode;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`co-alert co-alert-${tone}`}>
      <span className="co-alert-text">{children}</span>
      {onClose && (
        <button type="button" className="co-alert-close" onClick={onClose} aria-label={t("common.close")}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal frame (ModalShell renders only the scrim + lifecycle)
// ---------------------------------------------------------------------------

export function ModalFrame({
  title,
  icon,
  body,
  footer,
  onClose,
}: {
  title: string;
  icon?: ReactNode;
  body: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="co-modal-host">
        <div role="dialog" aria-modal="true" aria-label={title} className="modal">
          <div className="modal-head co-modal-head">
            {icon && (
              <span aria-hidden className="co-modal-icon">
                {icon}
              </span>
            )}
            <h3 className="modal-title">{title}</h3>
          </div>
          <div className="modal-body">
            <p className="co-modal-body">{body}</p>
          </div>
          <div className="modal-foot">{footer}</div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

export function StatusPill({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return (
    <span className={`co-status tone-${tone}`} title={title}>
      <span aria-hidden className="co-status-dot" />
      {children}
    </span>
  );
}

/** Stroke icon for the danger empty state (no "alert" glyph in Icon.tsx). */
export function AlertGlyph({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
