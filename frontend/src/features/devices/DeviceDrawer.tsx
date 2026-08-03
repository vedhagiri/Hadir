// Add/Edit form drawer for an attendance device. Ported from the camera
// CameraDrawer so the two screens read as one system.
//
// Write-only credentials: the username + password fields are display-only
// placeholders (``***``) on edit. On PATCH we only send them when the
// operator actually re-types both — that preserves the backend rule that
// the stored Fernet cipher is left untouched when the fields are omitted
// (the device analogue of the camera rtsp_url rule).
//
// The serial number is auto-read from the device on save and immutable in
// this UI, so it is surfaced as a read-only mono badge on edit (mirrors the
// camera_code badge).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DrawerShell } from "../../components/DrawerShell";
import { extractApiError } from "../../api/client";

import { Icon } from "../../shell/Icon";
import { useCreateDevice, usePatchDevice } from "./hooks";
import {
  DRIVER_OPTIONS,
  ENROLLMENT_SCOPE_OPTIONS,
  type Device,
  type DeviceCreateInput,
  type DeviceDriver,
  type DevicePatchInput,
  type EnrollmentScope,
} from "./types";

interface Props {
  mode: "create" | "edit";
  initial: Device | null;
  onClose: () => void;
}

export function DeviceDrawer({ mode, initial, onClose }: Props) {
  const { t } = useTranslation();
  const create = useCreateDevice();
  const patch = usePatchDevice();

  const [name, setName] = useState(initial?.name ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [driver, setDriver] = useState<DeviceDriver>(
    initial?.driver ?? "hikvision",
  );
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState<string>(
    initial?.port != null ? String(initial.port) : "80",
  );
  const [doorNo, setDoorNo] = useState(initial?.door_no ?? "");
  const [scope, setScope] = useState<EnrollmentScope>(
    initial?.enrollment_scope ?? "all",
  );
  // New devices default Enabled ON so the terminal is immediately useful
  // after Add. Edit mode keeps the row's persisted value.
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // Write-only — never prefilled from the response (credentials are
  // encrypted server-side and never returned).
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial?.name ?? "");
    setLocation(initial?.location ?? "");
    setDriver(initial?.driver ?? "hikvision");
    setHost(initial?.host ?? "");
    setPort(initial?.port != null ? String(initial.port) : "80");
    setDoorNo(initial?.door_no ?? "");
    setScope(initial?.enrollment_scope ?? "all");
    setEnabled(initial?.enabled ?? true);
    setUsername("");
    setPassword("");
    setShowPassword(false);
    setError(null);
  }, [initial]);

  const submitting = create.isPending || patch.isPending;

  // Add Device is enabled only after the hard-required fields are filled.
  // Edit Save is always enabled (all required fields were set at create).
  const canSubmit =
    mode === "edit"
      ? !submitting
      : !submitting &&
        name.trim().length > 0 &&
        host.trim().length > 0 &&
        port.trim().length > 0 &&
        username.trim().length > 0 &&
        password.trim().length > 0;

  const submit = async () => {
    setError(null);
    const portNum = parseInt(port, 10);
    try {
      if (mode === "create") {
        if (!name.trim()) {
          setError(t("devices.errors.nameRequired", { defaultValue: "Name is required." }));
          return;
        }
        if (!host.trim()) {
          setError(t("devices.errors.hostRequired", { defaultValue: "Host / IP is required." }));
          return;
        }
        if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
          setError(t("devices.errors.portInvalid", { defaultValue: "Port must be between 1 and 65535." }));
          return;
        }
        if (!username.trim() || !password.trim()) {
          setError(t("devices.errors.credsRequired", { defaultValue: "Username and password are required." }));
          return;
        }
        const input: DeviceCreateInput = {
          name: name.trim(),
          location: location.trim(),
          driver,
          host: host.trim(),
          port: portNum,
          username: username.trim(),
          password: password,
          door_no: doorNo.trim() || null,
          enrollment_scope: scope,
          enabled,
        };
        await create.mutateAsync(input);
      } else {
        if (!initial) return;
        const patchBody: DevicePatchInput = {};
        if (name.trim() !== initial.name) patchBody.name = name.trim();
        if (location.trim() !== initial.location) patchBody.location = location.trim();
        if (driver !== initial.driver) patchBody.driver = driver;
        if (host.trim() !== initial.host) patchBody.host = host.trim();
        if (Number.isFinite(portNum) && portNum !== initial.port) {
          patchBody.port = portNum;
        }
        const doorNorm = doorNo.trim() || null;
        if (doorNorm !== (initial.door_no ?? null)) patchBody.door_no = doorNorm;
        if (scope !== initial.enrollment_scope) patchBody.enrollment_scope = scope;
        if (enabled !== initial.enabled) patchBody.enabled = enabled;
        // Credential rotation — send BOTH or NEITHER. A single field is a
        // user error, not a partial rotation.
        if (username.trim() || password.trim()) {
          if (!username.trim() || !password.trim()) {
            setError(
              t("devices.errors.credsBoth", {
                defaultValue:
                  "To change credentials, enter both username and password.",
              }),
            );
            return;
          }
          patchBody.username = username.trim();
          patchBody.password = password;
        }
        if (Object.keys(patchBody).length === 0) {
          onClose();
          return;
        }
        await patch.mutateAsync({ id: initial.id, patch: patchBody });
      }
      onClose();
    } catch (err) {
      // Surface the backend's actual message (e.g. duplicate serial 409,
      // unreachable host 502) instead of a generic "save failed".
      setError(extractApiError(err, t("devices.errors.saveFailed", { defaultValue: "Could not save the device." })));
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
              {mode === "create"
                ? t("devices.addTitle", { defaultValue: "Add device" })
                : `${t("devices.editTitle", { defaultValue: "Edit device" })} · ${initial?.name ?? ""}`}
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
          {/* Serial — auto-assigned on create, read-only mono badge on edit. */}
          {mode === "edit" && initial?.serial_number && (
            <Field label={t("devices.fields.serial", { defaultValue: "Serial number" })}>
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

          <Field label={t("devices.fields.name", { defaultValue: "Device name" })} required={mode === "create"}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("devices.placeholders.name", { defaultValue: "e.g. Main Gate Terminal" })}
              style={inputStyle}
              autoFocus
              maxLength={120}
            />
          </Field>

          <Field label={t("devices.fields.location", { defaultValue: "Location" })}>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("devices.placeholders.location", { defaultValue: "e.g. Building A – Entrance" })}
              style={inputStyle}
              maxLength={200}
            />
          </Field>

          <Field
            label={t("devices.fields.driver", { defaultValue: "Driver" })}
            hint={t("devices.hints.driver", { defaultValue: "Terminal vendor / integration protocol." })}
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

          {/* Connection — host + port live on one row. */}
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 2 }}>
              <Field label={t("devices.fields.host", { defaultValue: "Host / IP" })} required={mode === "create"}>
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.1.64"
                  autoComplete="off"
                  spellCheck={false}
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label={t("devices.fields.port", { defaultValue: "Port" })} required={mode === "create"}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label={t("devices.fields.doorNo", { defaultValue: "Door no." })}>
                <input
                  value={doorNo}
                  onChange={(e) => setDoorNo(e.target.value)}
                  placeholder="1"
                  style={inputStyle}
                />
              </Field>
            </div>
          </div>

          {/* Credentials — write-only. *** placeholder on edit; only sent
              when the operator re-types both to rotate. */}
          <Field
            label={t("devices.fields.username", { defaultValue: "Username" })}
            required={mode === "create"}
            {...(mode === "edit"
              ? {
                  hint: t("devices.hints.credsEdit", {
                    defaultValue: "Leave blank to keep the saved credentials.",
                  }),
                }
              : {})}
          >
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={mode === "edit" ? "***" : "admin"}
              autoComplete="off"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          <Field
            label={t("devices.fields.password", { defaultValue: "Password" })}
            required={mode === "create"}
          >
            <div style={{ position: "relative" }}>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? "text" : "password"}
                placeholder={mode === "edit" ? "***" : ""}
                autoComplete="new-password"
                spellCheck={false}
                style={{ ...inputStyle, width: "100%", paddingInlineEnd: 52 }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={
                  showPassword
                    ? t("devices.hidePassword", { defaultValue: "Hide password" })
                    : t("devices.showPassword", { defaultValue: "Show password" })
                }
                style={{
                  position: "absolute",
                  insetInlineEnd: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: 0,
                  background: "none",
                  color: "var(--text-tertiary)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                {showPassword
                  ? t("devices.hide", { defaultValue: "hide" })
                  : t("devices.show", { defaultValue: "show" })}
              </button>
            </div>
          </Field>

          {/* Options — enrollment scope + enabled toggle. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <Field
              label={t("devices.fields.enrollmentScope", { defaultValue: "Enrollment scope" })}
              hint={t("devices.hints.enrollmentScope", { defaultValue: "Which employees' faces get pushed to this terminal." })}
            >
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as EnrollmentScope)}
                style={inputStyle}
              >
                {ENROLLMENT_SCOPE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <ToggleRow
              checked={enabled}
              onChange={setEnabled}
              label={t("devices.fields.enabled", { defaultValue: "Enabled" })}
              hint={t("devices.hints.enabled", { defaultValue: "Accept events and run sync for this device." })}
            />
          </div>

          {/* What-happens-on-save helper, mirrors the mockup's side panel. */}
          {mode === "create" && (
            <div
              style={{
                padding: "10px 12px",
                background: "var(--bg-sunken)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "flex",
                gap: 10,
              }}
            >
              <Icon name="shield" size={14} />
              <span>
                {t("devices.hints.onSave", {
                  defaultValue:
                    "On save, Maugood reads the device serial, encrypts the credentials, and registers the terminal.",
                })}
              </span>
            </div>
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
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            <Icon name="check" size={12} />
            {submitting
              ? t("common.saving")
              : mode === "create"
                ? t("common.add")
                : t("common.save")}
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
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
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
          <span aria-hidden style={{ color: "var(--danger-text)", fontWeight: 700, fontSize: 13, lineHeight: 1 }}>
            *
          </span>
        )}
      </span>
      {children}
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </label>
  );
}

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
