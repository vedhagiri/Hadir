// Add device — a two-step wizard in one modal.
//
//   1. Details   — name, branch, driver, enabled
//   2. Connect   — the values to type into the terminal
//
// One flow rather than a drawer followed by a separate modal, because the
// second step is not optional: a device with no URL pasted into it is a
// device that will never send anything. Keeping them in the same window
// makes that obvious.
//
// Step 2 has no Back button on purpose — the device is already created and
// its token minted by then, so "back" would imply the registration could be
// undone. Editing afterwards is a separate action from the device list.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DeviceSetupFields, DeviceTokenBadge } from "./DeviceSetupFields";
import { useCreateDevice } from "./hooks";
import {
  DRIVER_OPTIONS,
  type Device,
  type DeviceCreateInput,
  type DeviceDriver,
} from "./types";

interface Props {
  onClose: () => void;
}

export function AddDeviceWizard({ onClose }: Props) {
  const { t } = useTranslation();
  const create = useCreateDevice();

  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [driver, setDriver] = useState<DeviceDriver>("hikvision");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Set once the device exists — which is also what moves us to step 2.
  const [created, setCreated] = useState<Device | null>(null);
  const step = created ? 2 : 1;

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(
        t("devices.errors.nameRequired", { defaultValue: "Name is required." }),
      );
      return;
    }
    const input: DeviceCreateInput = {
      name: name.trim(),
      location: location.trim(),
      driver,
      enabled,
    };
    try {
      setCreated(await create.mutateAsync(input));
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
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-label={t("devices.wizard.title", { defaultValue: "Add device" })}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(520px, 94vw)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg, 0 20px 60px rgba(0,0,0,.3))",
          zIndex: 1000,
        }}
      >
        {/* header + stepper */}
        <div
          style={{
            padding: "16px 18px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                {t("devices.wizard.title", { defaultValue: "Add device" })}
              </h3>
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 10,
            }}
          >
            <Step
              n={1}
              done={step > 1}
              active={step === 1}
              label={t("devices.wizard.step1", {
                defaultValue: "Device details",
              })}
            />
            <span
              aria-hidden
              style={{
                flex: 1,
                height: 1,
                background: "var(--border)",
                minWidth: 12,
              }}
            />
            <Step
              n={2}
              done={false}
              active={step === 2}
              label={t("devices.wizard.step2", {
                defaultValue: "Connect the terminal",
              })}
            />
          </div>
        </div>

        {/* body */}
        <div style={{ overflowY: "auto", padding: "16px 18px" }}>
          {step === 1 ? (
            <>
              <Field
                label={t("devices.fields.name", { defaultValue: "Device name" })}
                required
                hint={t("devices.hints.name", {
                  defaultValue: "Shown in reports and the device list.",
                })}
              >
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
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

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>
                  {t("devices.fields.enabled", { defaultValue: "Enabled" })}
                  <span
                    className="text-xs text-dim"
                    style={{ display: "block" }}
                  >
                    {t("devices.hints.enabled", {
                      defaultValue: "Accept events from this terminal.",
                    })}
                  </span>
                </span>
              </label>

              <div
                style={{
                  display: "flex",
                  gap: 9,
                  alignItems: "flex-start",
                  marginTop: 14,
                  padding: "9px 11px",
                  background: "var(--bg-sunken)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ flex: "none", marginTop: 1 }}>
                  <Icon name="info" size={12} />
                </span>
                <span>
                  {t("devices.wizard.noNetworkNeeded", {
                    defaultValue:
                      "No IP address, port or device password needed — the terminal connects to us. Its serial and model are learned from the first event it sends.",
                  })}
                </span>
              </div>
            </>
          ) : (
            created && <DeviceSetupFields device={created} />
          )}

          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
                marginTop: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          {step === 2 && created && <DeviceTokenBadge device={created} />}
          <div style={{ flex: 1 }} />
          {step === 1 ? (
            <>
              <button
                className="btn"
                onClick={onClose}
                disabled={create.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={create.isPending || !name.trim()}
              >
                {create.isPending
                  ? t("common.saving")
                  : t("devices.wizard.continue", { defaultValue: "Continue" })}
                <Icon name="chevronRight" size={12} />
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onClose}>
              <Icon name="check" size={12} />
              {t("devices.wizard.finish", { defaultValue: "Finish" })}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function Step({
  n,
  label,
  active,
  done,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        fontWeight: 600,
        color: active
          ? "var(--text)"
          : done
            ? "var(--success-text, var(--text-secondary))"
            : "var(--text-tertiary)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          flex: "none",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontSize: 10,
          fontWeight: 700,
          background: active
            ? "var(--accent, var(--text))"
            : "var(--bg-sunken)",
          color: active ? "var(--bg)" : "inherit",
          border: active ? "0" : "1px solid var(--border)",
        }}
      >
        {done ? <Icon name="check" size={10} /> : n}
      </span>
      {label}
    </span>
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
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginBottom: 12,
      }}
    >
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
