// The values an operator types into a terminal, plus the warnings that go
// with them. Shared by the add-device wizard's second step and the
// standalone "show push URL" modal, so the two can never drift apart.
//
// The token is the device's permanent identity: minted once at registration
// and never changed here. The URL carries it, and that URL is the entire
// credential for the ingest endpoint — copy-only, never logged.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import type { Device } from "./types";

// Pull out the two parts the device screen asks for. Returns null if the URL
// will not parse, in which case we fall back to showing it whole.
function splitForDevice(raw: string): { host: string; path: string } | null {
  try {
    const u = new URL(raw);
    return { host: u.hostname, path: `${u.pathname}${u.search}` };
  } catch {
    return null;
  }
}

export function DeviceSetupFields({ device }: { device: Device }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);

  const url = device.push_url ?? "";
  const parts = url ? splitForDevice(url) : null;

  const copy = async (value: string, key: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions). Every value
      // is on screen and selectable, so this is a nicety, not a failure.
    }
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  };

  // Label above value, value full width — a side-by-side label column is
  // what forced the long URL into a horizontal scrollbar.
  const Item = ({
    step,
    label,
    value,
    name,
  }: {
    step?: number;
    label: string;
    value: string;
    name: string;
  }) => (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}
      >
        {step !== undefined && (
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              flex: "none",
              borderRadius: "50%",
              background: "var(--bg-sunken)",
              color: "var(--text-tertiary)",
              fontSize: 10,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
            }}
          >
            {step}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.03em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <div
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            lineHeight: 1.5,
            wordBreak: "break-all",
            userSelect: "all",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "7px 10px",
          }}
        >
          {value || "—"}
        </div>
        <button
          className="btn btn-sm"
          onClick={() => copy(value, name)}
          disabled={!value}
          title={t("devices.setup.copy", { defaultValue: "Copy" })}
          aria-label={t("devices.setup.copyField", {
            field: label,
            defaultValue: `Copy ${label}`,
          })}
          style={{ flex: "none", paddingInline: 10 }}
        >
          <Icon name={copied === name ? "check" : "clipboard"} size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <p
        style={{
          margin: "0 0 12px",
          fontSize: 11.5,
          lineHeight: 1.45,
          color: "var(--text-secondary)",
        }}
      >
        {t("devices.setup.path", {
          name: device.name,
          defaultValue: `${device.name} → Configuration → Network → Network Service → HTTP Listening`,
        })}
      </p>

      {parts ? (
        <>
          <Item
            step={1}
            label={t("devices.setup.fieldHost", {
              defaultValue: "Event Alarm IP/Domain Name",
            })}
            value={parts.host}
            name="host"
          />
          <Item
            step={2}
            label={t("devices.setup.fieldUrl", { defaultValue: "URL" })}
            value={parts.path}
            name="url"
          />
        </>
      ) : (
        <div className="text-sm text-dim" style={{ padding: "8px 0" }}>
          {t("devices.setup.noUrl", {
            defaultValue: "No push URL for this device yet.",
          })}
        </div>
      )}

      <button
        onClick={() => setShowFull((s) => !s)}
        aria-expanded={showFull}
        style={{
          background: "none",
          border: 0,
          padding: "2px 0 0",
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--text-secondary)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <Icon name={showFull ? "chevronDown" : "chevronRight"} size={11} />
        {t("devices.setup.fullUrlToggle", {
          defaultValue: "Full URL — for testing, not the device form",
        })}
      </button>

      {showFull && (
        <div style={{ marginTop: 8 }}>
          <Item
            label={t("devices.setup.urlLabel", { defaultValue: "Full URL" })}
            value={url}
            name="full"
          />
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          background: "var(--danger-soft)",
          color: "var(--danger-text)",
          padding: "8px 10px",
          borderRadius: "var(--radius-sm)",
          fontSize: 11.5,
          lineHeight: 1.45,
          marginTop: 14,
        }}
      >
        <span style={{ flex: "none", marginTop: 1 }}>
          <Icon name="shield" size={12} />
        </span>
        <span>
          {t("devices.setup.secret", {
            defaultValue:
              "This URL is a password — anyone holding it can post attendance into your company. Don’t paste it into tickets, screenshots or chat.",
          })}
        </span>
      </div>

      <ul
        style={{
          listStyle: "none",
          margin: "8px 0 0",
          padding: 0,
          fontSize: 11.5,
          color: "var(--text-secondary)",
          lineHeight: 1.45,
        }}
      >
        <Check
          text={t("devices.setup.clockShort", {
            defaultValue:
              "Set the terminal clock (NTP) — an unset clock stamps events 1970.",
          })}
        />
        <Check
          text={t("devices.setup.certShort", {
            defaultValue:
              "HTTPS needs a valid certificate — terminals reject self-signed ones silently.",
          })}
        />
        <Check
          text={t("devices.setup.enrolShort", {
            defaultValue: "Enrol faces and fingerprints at the terminal itself.",
          })}
        />
      </ul>
    </>
  );
}

// The token as a fact about the device, with no controls attached — it is
// minted once and never changes.
export function DeviceTokenBadge({ device }: { device: Device }) {
  const { t } = useTranslation();
  if (!device.push_token) return null;
  return (
    <>
      <span className="text-xs text-dim">
        {t("devices.setup.tokenLabel", { defaultValue: "Device token" })}
      </span>
      <span className="pill pill-neutral mono">{device.push_token}</span>
    </>
  );
}

function Check({ text }: { text: string }) {
  return (
    <li
      style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "2px 0" }}
    >
      <span style={{ flex: "none", marginTop: 2, color: "var(--text-tertiary)" }}>
        <Icon name="check" size={10} />
      </span>
      <span>{text}</span>
    </li>
  );
}
