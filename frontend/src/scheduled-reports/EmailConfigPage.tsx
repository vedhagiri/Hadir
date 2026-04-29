// Settings → Email. Admin-only. Provider radio (SMTP / Microsoft
// Graph) drives which credential block renders. Secrets are
// write-only — the API surfaces a boolean ``has_*`` per secret so we
// can show "*** stored" and let the operator opt in to a rotation.

import { useEffect, useState } from "react";

import { ApiError } from "../api/client";
import { SettingsTabs } from "../settings/SettingsTabs";
import {
  useEmailConfig,
  usePatchEmailConfig,
  useSendTestEmail,
} from "./hooks";
import type { EmailConfigUpdate, EmailProvider } from "./types";

export function EmailConfigPage() {
  const cfg = useEmailConfig();
  const patch = usePatchEmailConfig();
  const test = useSendTestEmail();

  const [provider, setProvider] = useState<EmailProvider>("smtp");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpUseTls, setSmtpUseTls] = useState(true);
  const [graphTenant, setGraphTenant] = useState("");
  const [graphClientId, setGraphClientId] = useState("");
  const [graphClientSecret, setGraphClientSecret] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    if (!cfg.data) return;
    setProvider(cfg.data.provider);
    setSmtpHost(cfg.data.smtp_host);
    setSmtpPort(cfg.data.smtp_port);
    setSmtpUsername(cfg.data.smtp_username);
    setSmtpUseTls(cfg.data.smtp_use_tls);
    setGraphTenant(cfg.data.graph_tenant_id);
    setGraphClientId(cfg.data.graph_client_id);
    setFromAddress(cfg.data.from_address);
    setFromName(cfg.data.from_name);
    setEnabled(cfg.data.enabled);
    setSmtpPassword("");
    setGraphClientSecret("");
  }, [cfg.data]);

  const onSave = async () => {
    setError(null);
    setInfo(null);
    const payload: EmailConfigUpdate = {
      provider,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_username: smtpUsername,
      smtp_use_tls: smtpUseTls,
      graph_tenant_id: graphTenant,
      graph_client_id: graphClientId,
      from_address: fromAddress,
      from_name: fromName,
      enabled,
    };
    if (smtpPassword.length > 0) payload.smtp_password = smtpPassword;
    if (graphClientSecret.length > 0)
      payload.graph_client_secret = graphClientSecret;
    try {
      await patch.mutateAsync(payload);
      setSmtpPassword("");
      setGraphClientSecret("");
      setInfo("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    }
  };

  const onTest = async () => {
    setError(null);
    setInfo(null);
    if (!testTo.trim()) {
      setError("Type an email address to test against.");
      return;
    }
    try {
      await test.mutateAsync(testTo.trim());
      setInfo(`Test email sent to ${testTo.trim()}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Test send failed.");
    }
  };

  if (cfg.isLoading) return <p>Loading email settings…</p>;
  if (cfg.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load email settings.
      </p>
    );
  if (!cfg.data) return <p>Sign in to configure email.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Email
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Outbound credentials for scheduled reports + override
          notifications. Secrets are write-only — the field shows{" "}
          <span className="mono">***</span> when one is stored. Type a
          fresh value to rotate.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 18,
          maxWidth: 700,
        }}
      >
        <Field label="Provider">
          <div style={{ display: "flex", gap: 8 }}>
            {(["smtp", "microsoft_graph"] as EmailProvider[]).map((p) => (
              <label
                key={p}
                className={`pill ${provider === p ? "pill-accent" : "pill-neutral"}`}
                style={{ cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  checked={provider === p}
                  onChange={() => setProvider(p)}
                  style={{ display: "none" }}
                />
                {p === "smtp" ? "SMTP" : "Microsoft Graph"}
              </label>
            ))}
          </div>
        </Field>

        {provider === "smtp" ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 120px",
                gap: 8,
              }}
            >
              <Field label="Host">
                <input
                  className="input"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.example.com"
                />
              </Field>
              <Field label="Port">
                <input
                  className="input"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value))}
                />
              </Field>
            </div>
            <Field label="Username">
              <input
                className="input"
                value={smtpUsername}
                onChange={(e) => setSmtpUsername(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Password"
              hint={
                cfg.data.has_smtp_password
                  ? "Stored. Type a new value to rotate."
                  : "Required if your SMTP server requires authentication."
              }
            >
              <input
                className="input"
                type="password"
                value={smtpPassword}
                placeholder={cfg.data.has_smtp_password ? "***" : ""}
                onChange={(e) => setSmtpPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <label
              style={{
                display: "flex",
                gap: 6,
                fontSize: 13,
                alignItems: "center",
              }}
            >
              <input
                type="checkbox"
                checked={smtpUseTls}
                onChange={(e) => setSmtpUseTls(e.target.checked)}
              />
              Use TLS (STARTTLS)
            </label>
          </>
        ) : (
          <>
            <Field label="Entra tenant id">
              <input
                className="input"
                value={graphTenant}
                onChange={(e) => setGraphTenant(e.target.value)}
              />
            </Field>
            <Field label="Client id">
              <input
                className="input"
                value={graphClientId}
                onChange={(e) => setGraphClientId(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Client secret"
              hint={
                cfg.data.has_graph_client_secret
                  ? "Stored. Type a new value to rotate."
                  : "Application secret from your Entra app registration."
              }
            >
              <input
                className="input"
                type="password"
                value={graphClientSecret}
                placeholder={cfg.data.has_graph_client_secret ? "***" : ""}
                onChange={(e) => setGraphClientSecret(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <Field label="From address">
            <input
              className="input"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="reports@your-domain.com"
            />
          </Field>
          <Field label="From name">
            <input
              className="input"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Maugood Reports"
            />
          </Field>
        </div>

        <label
          style={{
            display: "flex",
            gap: 6,
            fontSize: 13,
            alignItems: "center",
          }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable email delivery for scheduled reports + notifications
        </label>

        {error && (
          <div
            role="alert"
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              border: "1px solid var(--border)",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}
        {info && (
          <div
            style={{
              background: "var(--bg-sunken)",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
            }}
          >
            {info}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={patch.isPending}
          >
            {patch.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>

      <section
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 18,
          maxWidth: 700,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Send test email</h2>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12.5 }}>
          Uses the saved configuration. Useful to verify SMTP / Graph
          credentials before scheduling a real report.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@your-domain.com"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn"
            onClick={() => void onTest()}
            disabled={test.isPending}
          >
            {test.isPending ? "Sending…" : "Send test"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
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
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}
