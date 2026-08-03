// Edit drawer for an already-registered device.
//
// Adding is a two-step wizard (AddDeviceWizard) because a new device also
// needs its URL pasted into the terminal; editing is just the fields, so it
// stays a plain drawer.
//
// Nothing here touches the connection: the terminal dials us, so there is no
// IP, port or password to change, and the push token is the device's
// permanent identity.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DrawerShell } from "../../components/DrawerShell";
import { extractApiError } from "../../api/client";

import { Icon } from "../../shell/Icon";
import { usePatchDevice } from "./hooks";
import {
  DRIVER_OPTIONS,
  type Device,
  type DeviceDriver,
  type DevicePatchInput,
} from "./types";

interface Props {
  initial: Device;
  onClose: () => void;
}

export function DeviceDrawer({ initial, onClose }: Props) {
  const { t } = useTranslation();
  const patch = usePatchDevice();

  const [name, setName] = useState(initial.name);
  const [location, setLocation] = useState(initial.location);
  const [driver, setDriver] = useState<DeviceDriver>(initial.driver);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial.name);
    setLocation(initial.location);
    setDriver(initial.driver);
    setEnabled(initial.enabled);
    setError(null);
  }, [initial]);

  const submitting = patch.isPending;

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(
        t("devices.errors.nameRequired", { defaultValue: "Name is required." }),
      );
      return;
    }
    const patchBody: DevicePatchInput = {};
    if (name.trim() !== initial.name) patchBody.name = name.trim();
    if (location.trim() !== initial.location) patchBody.location = location.trim();
    if (driver !== initial.driver) patchBody.driver = driver;
    if (enabled !== initial.enabled) patchBody.enabled = enabled;
    if (Object.keys(patchBody).length === 0) {
      onClose();
      return;
    }
    try {
      await patch.mutateAsync({ id: initial.id, patch: patchBody });
      onClose();
    } catch (err) {
      setError(
        extractApiError(
          err,
          t("devices.errors.saveFailed", {
            defaultValue: "Could not save the device.",
          }),
        ),
      );
    }
  };

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {t("devices.label", { defaultValue: "DEVICE" })}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {`${t("devices.editTitle", { defaultValue: "Edit device" })} · ${initial.name}`}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div
          className="drawer-body"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {/* Learned from the first event — read-only when we have it. */}
          {initial.serial_number && (
            <Field
              label={t("devices.fields.serial", {
                defaultValue: "Serial number",
              })}
            >
              <div
                className="mono"
                style={{
                  ...inputStyle,
                  background: "var(--bg-sunken)",
                  color: "var(--text-secondary)",
                  fontWeight: 600,
                }}
              >
                {initial.serial_number}
              </div>
            </Field>
          )}

          <Field
            label={t("devices.fields.name", { defaultValue: "Device name" })}
            hint={t("devices.hints.name", {
              defaultValue: "Shown in reports and the device list.",
            })}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("devices.placeholders.name", {
                defaultValue: "e.g. Entrance",
              })}
              style={inputStyle}
              autoFocus
              maxLength={120}
            />
          </Field>

          <Field
            label={t("devices.fields.location", {
              defaultValue: "Branch / location",
            })}
          >
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("devices.placeholders.location", {
                defaultValue: "e.g. Head Office",
              })}
              style={inputStyle}
              maxLength={200}
            />
          </Field>

          <Field
            label={t("devices.fields.driver", { defaultValue: "Driver" })}
            hint={t("devices.hints.driver", {
              defaultValue: "Terminal vendor / integration protocol.",
            })}
          >
            <select
              value={driver}
              onChange={(e) => setDriver(e.target.value as DeviceDriver)}
              style={inputStyle}
            >
              {DRIVER_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>

          <div
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <ToggleRow
              checked={enabled}
              onChange={setEnabled}
              label={t("devices.fields.enabled", { defaultValue: "Enabled" })}
              hint={t("devices.hints.enabled", {
                defaultValue: "Accept events from this terminal.",
              })}
            />
          </div>

          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || !name.trim()}
          >
            <Icon name="check" size={12} />
            {submitting ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </span>
      {hint && (
        <span className="text-xs text-dim" style={{ marginInlineStart: 22 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          display: "flex",
          alignItems: "center",
          gap: 3,
        }}
      >
        {label}
        {required && (
          <span
            aria-hidden
            style={{
              color: "var(--danger-text)",
              fontWeight: 700,
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            *
          </span>
        )}
      </span>
      {children}
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  width: "100%",
};
