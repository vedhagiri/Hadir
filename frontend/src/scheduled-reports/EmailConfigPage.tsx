// Settings → Email. Admin-only.
// Three inner tabs: Provider (SMTP / Microsoft Graph config),
// Attendance Emails (employee-facing status toggles + delivery log),
// Notifications (per-user category × channel grid).

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BsEnvelopeCheckFill,
  BsEnvelopeXFill,
  BsPauseFill,
  BsPlayFill,
  BsExclamationTriangleFill,
  BsCheckCircleFill,
  BsEnvelopeFill,
  BsCloudFill,
  BsHddNetworkFill,
  BsPersonFill,
  BsKeyFill,
  BsBuildingFill,
  BsPersonBadgeFill,
  BsShieldLockFill,
  BsPencilFill,
  BsFloppyFill,
  BsFlaskFill,
  BsLockFill,
  BsTrashFill,
  BsPlusLg,
} from "react-icons/bs";

import { ApiError } from "../api/client";
import { useMe } from "../auth/AuthProvider";
import { ModalShell } from "../components/DrawerShell";
import { SettingsTabs } from "../settings/SettingsTabs";
import { Icon } from "../shell/Icon";
import {
  useAttendanceEmailConfig,
  useAttendanceEmailLog,
  usePutAttendanceEmailConfig,
} from "../notifications/hooks";
import {
  type AttendanceEmailConfig,
  type AttendanceEmailConfigOut,
  type AttendanceEmailLogItem,
  type AttendanceEmailStatus,
} from "../notifications/types";
import {
  useEmailConfig,
  usePatchEmailConfig,
  usePendingEmailCount,
  useSendTestEmail,
} from "./hooks";
import type { EmailConfigUpdate, EmailProvider } from "./types";

type InnerTab = "provider" | "attendance";

// ─── small helpers ────────────────────────────────────────────────────────────

function logOutcome(item: AttendanceEmailLogItem): {
  label: string;
  color: string;
} {
  if (item.sent_at) return { label: "Sent", color: "var(--success, #0a8a52)" };
  if (item.skipped_at) return { label: "Skipped", color: "var(--text-secondary)" };
  if (item.failed_at) return { label: "Failed", color: "var(--danger, #b91c1c)" };
  return { label: "Pending", color: "var(--text-secondary)" };
}

// Minimal inner-tab bar (not the outer SettingsTabs).
function InnerTabs({
  value,
  onChange,
  tabs,
}: {
  value: InnerTab;
  onChange: (v: InnerTab) => void;
  tabs: { id: InnerTab; label: string }[];
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        borderBottom: "1px solid var(--border)",
        marginBottom: 20,
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          style={{
            background: "none",
            border: "none",
            borderBottom: value === t.id ? "2px solid var(--accent, #0b6e4f)" : "2px solid transparent",
            color: value === t.id ? "var(--accent, #0b6e4f)" : "var(--text-secondary)",
            fontWeight: value === t.id ? 700 : 500,
            fontSize: 13,
            padding: "8px 16px",
            cursor: "pointer",
            marginBottom: -1,
            borderRadius: 0,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Provider config modal ─────────────────────────────────────────────────────

function ProviderConfigModal({
  initialProvider,
  lockedProvider,
  configData,
  onClose,
  onSaved,
}: {
  initialProvider: EmailProvider;
  lockedProvider: boolean;
  configData: ReturnType<typeof useEmailConfig>["data"];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const d = configData!;
  const patch = usePatchEmailConfig();
  const pending = usePendingEmailCount();
  const pendingCount = pending.data?.count ?? 0;

  // When editing an existing provider, skip straight to credentials
  const [step, setStep] = useState<"provider" | "credentials" | "sender">(
    lockedProvider ? "credentials" : "provider",
  );
  const [provider, setProvider] = useState<EmailProvider>(initialProvider);
  const [smtpHost, setSmtpHost] = useState(d.smtp_host);
  const [smtpPort, setSmtpPort] = useState(d.smtp_port);
  const [smtpUsername, setSmtpUsername] = useState(d.smtp_username);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpUseTls, setSmtpUseTls] = useState(d.smtp_use_tls);
  const [graphTenant, setGraphTenant] = useState(d.graph_tenant_id);
  const [graphClientId, setGraphClientId] = useState(d.graph_client_id);
  const [graphClientSecret, setGraphClientSecret] = useState("");
  const [fromAddress, setFromAddress] = useState(d.from_address);
  const [fromName, setFromName] = useState(d.from_name);
  const [bccAddress, setBccAddress] = useState(d.bcc_address);
  const [enabled, setEnabled] = useState(d.enabled);
  const [error, setError] = useState<string | null>(null);

  const steps = lockedProvider
    ? [
        { id: "credentials" as const, label: provider === "smtp" ? "SMTP Server" : "Azure Credentials" },
        { id: "sender" as const, label: "Sender Identity" },
      ]
    : [
        { id: "provider" as const, label: "Provider" },
        { id: "credentials" as const, label: provider === "smtp" ? "SMTP Server" : "Azure Credentials" },
        { id: "sender" as const, label: "Sender Identity" },
      ];
  const stepIdx = steps.findIndex((s) => s.id === step);

  // Required field validation per step
  const isStepValid = (): boolean => {
    if (step === "provider") return true;
    if (step === "credentials") {
      if (provider === "smtp") return smtpHost.trim().length > 0;
      return graphTenant.trim().length > 0 && graphClientId.trim().length > 0;
    }
    if (step === "sender") return fromAddress.trim().length > 0;
    return true;
  };

  const onSave = async () => {
    setError(null);
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
      bcc_address: bccAddress,
      enabled,
    };
    if (smtpPassword.length > 0) payload.smtp_password = smtpPassword;
    if (graphClientSecret.length > 0) payload.graph_client_secret = graphClientSecret;
    try {
      await patch.mutateAsync(payload);
      const cancelled = 0;
      onSaved(cancelled > 0 ? `Saved · ${cancelled} queued emails cancelled` : "Configuration saved.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-label="Configure email provider"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 680,
          maxWidth: "96vw",
          maxHeight: "94vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 16,
          zIndex: 60,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Modal header */}
        <div
          style={{
            padding: "18px 22px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "color-mix(in srgb, var(--accent,#0b6e4f) 14%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: "var(--accent,#0b6e4f)",
              flexShrink: 0,
            }}
          >
            <BsEnvelopeFill />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
              {lockedProvider
                ? `Edit ${provider === "smtp" ? "SMTP" : "Microsoft Graph"} Configuration`
                : "Add Email Provider"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
              Step {stepIdx + 1} of {steps.length} · {steps[stepIdx]?.label}
            </div>
          </div>
          <button
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Step progress bar */}
        <div style={{ display: "flex", padding: "14px 22px 0", gap: 8 }}>
          {steps.map((s, i) => (
            <div key={s.id} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
              <div
                style={{
                  height: 4,
                  borderRadius: 99,
                  background: i <= stepIdx
                    ? "var(--accent, #0b6e4f)"
                    : "var(--border)",
                  transition: "background 0.25s",
                }}
              />
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: i === stepIdx ? 700 : 400,
                  color: i === stepIdx ? "var(--accent,#0b6e4f)" : "var(--text-tertiary)",
                  letterSpacing: "0.03em",
                }}
              >
                {i + 1}. {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>

          {/* Error */}
          {error && (
            <div
              style={{
                display: "flex", gap: 8, alignItems: "flex-start",
                background: "var(--danger-soft)", color: "var(--danger-text)",
                border: "1px solid #fecaca", padding: "10px 14px",
                borderRadius: 10, fontSize: 13, marginBottom: 16,
              }}
            >
              <BsExclamationTriangleFill style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}

          {/* ── Step 1: Provider ── */}
          {step === "provider" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--text-secondary)" }}>
                Choose the email service to use for outbound delivery.
              </p>
              {(["smtp", "microsoft_graph"] as EmailProvider[]).map((p) => (
                <label
                  key={p}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    border: `2px solid ${provider === p ? "var(--accent,#0b6e4f)" : "var(--border)"}`,
                    borderRadius: 14,
                    padding: "16px 18px",
                    cursor: "pointer",
                    background: provider === p
                      ? "color-mix(in srgb, var(--accent,#0b6e4f) 6%, var(--bg))"
                      : "var(--bg)",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  <input type="radio" name="provider" value={p} checked={provider === p} onChange={() => setProvider(p)} style={{ display: "none" }} />
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      background: provider === p
                        ? "color-mix(in srgb, var(--accent,#0b6e4f) 15%, transparent)"
                        : "var(--bg-sunken)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                      color: provider === p ? "var(--accent,#0b6e4f)" : "var(--text-secondary)",
                      flexShrink: 0,
                      transition: "background 0.15s, color 0.15s",
                    }}
                  >
                    {p === "smtp" ? <BsEnvelopeFill /> : <BsCloudFill />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {p === "smtp" ? "SMTP" : "Microsoft Graph"}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.5 }}>
                      {p === "smtp"
                        ? "Gmail, Outlook, Brevo, or any custom SMTP relay"
                        : "Microsoft 365 / Azure with app credentials"}
                    </div>
                    {p === "smtp" && (
                      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        {["Gmail", "Outlook", "Brevo", "SendGrid"].map((tag) => (
                          <span key={tag} className="pill pill-neutral" style={{ fontSize: 10.5 }}>{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: `2px solid ${provider === p ? "var(--accent,#0b6e4f)" : "var(--border)"}`,
                      background: provider === p ? "var(--accent,#0b6e4f)" : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 11,
                      flexShrink: 0,
                      transition: "all 0.15s",
                    }}
                  >
                    {provider === p && <BsCheckCircleFill size={10} />}
                  </div>
                </label>
              ))}
            </div>
          )}

          {/* ── Step 2: Credentials ── */}
          {step === "credentials" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {provider === "smtp" ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 14px",
                      borderRadius: 12,
                      background: "color-mix(in srgb, var(--accent,#0b6e4f) 6%, var(--bg))",
                      border: "1px solid color-mix(in srgb, var(--accent,#0b6e4f) 20%, transparent)",
                      fontSize: 12.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <BsHddNetworkFill style={{ color: "var(--accent,#0b6e4f)", fontSize: 16, flexShrink: 0 }} />
                    Enter your SMTP relay server details. These are provided by your email service.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 10 }}>
                    <Field label="Host *">
                      <input className="input" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
                    </Field>
                    <Field label="Port">
                      <input className="input" type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
                    </Field>
                  </div>
                  <Field label="Username">
                    <input className="input" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} autoComplete="off" placeholder="your@email.com" />
                  </Field>
                  <Field
                    label="Password"
                    {...(d.has_smtp_password ? { hint: "Leave blank to keep the stored password" } : {})}
                  >
                    <input
                      className="input"
                      type="password"
                      value={smtpPassword}
                      placeholder={d.has_smtp_password ? "•••••• (stored)" : "Enter password"}
                      onChange={(e) => setSmtpPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </Field>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "11px 14px",
                      borderRadius: 10,
                      border: `1.5px solid ${smtpUseTls ? "var(--accent,#0b6e4f)" : "var(--border)"}`,
                      background: smtpUseTls ? "color-mix(in srgb, var(--accent,#0b6e4f) 5%, var(--bg))" : "var(--bg)",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 500,
                      transition: "border-color 0.15s",
                    }}
                  >
                    <input type="checkbox" checked={smtpUseTls} onChange={(e) => setSmtpUseTls(e.target.checked)} />
                    <BsLockFill style={{ color: "var(--accent,#0b6e4f)" }} />
                    Use TLS / STARTTLS
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 400, marginInlineStart: 4 }}>
                      (recommended for port 587)
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 14px",
                      borderRadius: 12,
                      background: "color-mix(in srgb, var(--accent,#0b6e4f) 6%, var(--bg))",
                      border: "1px solid color-mix(in srgb, var(--accent,#0b6e4f) 20%, transparent)",
                      fontSize: 12.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <BsBuildingFill style={{ color: "var(--accent,#0b6e4f)", fontSize: 16, flexShrink: 0 }} />
                    Register an app in Azure Active Directory and paste the credentials below.
                  </div>
                  <Field label="Entra Tenant ID">
                    <input className="input" value={graphTenant} onChange={(e) => setGraphTenant(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                  </Field>
                  <Field label="Client ID (Application ID)">
                    <input className="input" value={graphClientId} onChange={(e) => setGraphClientId(e.target.value)} autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                  </Field>
                  <Field
                    label="Client Secret"
                    {...(d.has_graph_client_secret ? { hint: "Leave blank to keep the stored secret" } : {})}
                  >
                    <input
                      className="input"
                      type="password"
                      value={graphClientSecret}
                      placeholder={d.has_graph_client_secret ? "•••••• (stored)" : "Enter client secret"}
                      onChange={(e) => setGraphClientSecret(e.target.value)}
                      autoComplete="new-password"
                    />
                  </Field>
                </>
              )}
            </div>
          )}

          {/* ── Step 3: Sender identity ── */}
          {step === "sender" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "color-mix(in srgb, var(--accent,#0b6e4f) 6%, var(--bg))",
                  border: "1px solid color-mix(in srgb, var(--accent,#0b6e4f) 20%, transparent)",
                  fontSize: 12.5,
                  color: "var(--text-secondary)",
                }}
              >
                <BsEnvelopeFill style={{ color: "var(--accent,#0b6e4f)", fontSize: 16, flexShrink: 0 }} />
                The name and address that recipients will see in their inbox.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="From Address *">
                  <input className="input" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="reports@your-domain.com" />
                </Field>
                <Field label="Display Name">
                  <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Maugood Reports" />
                </Field>
              </div>
              <Field label="BCC (monitoring address)">
                <input
                  className="input"
                  type="email"
                  value={bccAddress}
                  onChange={(e) => setBccAddress(e.target.value)}
                  placeholder="monitoring@your-company.com (optional)"
                />
              </Field>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "11px 14px",
                  borderRadius: 10,
                  border: `1.5px solid ${enabled ? "var(--accent,#0b6e4f)" : "var(--border)"}`,
                  background: enabled ? "color-mix(in srgb, var(--accent,#0b6e4f) 5%, var(--bg))" : "var(--bg)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                  transition: "border-color 0.15s",
                }}
              >
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                Enable email sending
              </label>
              {!enabled && pendingCount > 0 && (
                <div
                  style={{
                    display: "flex", gap: 8, alignItems: "flex-start",
                    padding: "10px 14px", borderRadius: 10,
                    background: "color-mix(in srgb, #b45309 8%, var(--bg))",
                    border: "1px solid #b45309", fontSize: 12.5, color: "#92400e",
                  }}
                >
                  <BsExclamationTriangleFill style={{ flexShrink: 0, marginTop: 1 }} />
                  Saving with this unchecked will cancel {pendingCount} queued email{pendingCount !== 1 ? "s" : ""}.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            background: "var(--bg-elev)",
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (step === "provider") { onClose(); return; }
              if (step === "credentials") {
                if (lockedProvider) { onClose(); return; }
                setStep("provider");
              }
              if (step === "sender") setStep("credentials");
            }}
          >
            {(step === "provider" || (lockedProvider && step === "credentials")) ? "Cancel" : "← Back"}
          </button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {step !== "sender" ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!isStepValid()}
                onClick={() => {
                  if (step === "provider") setStep("credentials");
                  else if (step === "credentials") setStep("sender");
                }}
                style={{ minWidth: 110 }}
              >
                Next →
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onSave()}
                disabled={patch.isPending || !isStepValid()}
                style={{ minWidth: 140 }}
              >
                {patch.isPending
                  ? "Saving…"
                  : <><BsFloppyFill style={{ marginInlineEnd: 6 }} />Save Changes</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Provider tab ─────────────────────────────────────────────────────────────

function ProviderPanel() {
  const { t } = useTranslation();
  const cfg = useEmailConfig();
  const pending = usePendingEmailCount();
  const patch = usePatchEmailConfig();
  const testMutation = useSendTestEmail();

  // Which provider's edit modal is open (null = closed)
  const [editingProvider, setEditingProvider] = useState<EmailProvider | null>(null);
  // Which provider's delete confirm popup is open
  const [deleteConfirm, setDeleteConfirm] = useState<EmailProvider | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testSuccess, setTestSuccess] = useState(false);

  const onTest = async () => {
    setError(null);
    setInfo(null);
    setTestSuccess(false);
    if (!testTo.trim()) {
      setError(t("emailConfig.msg.testAddressRequired") as string);
      return;
    }
    try {
      await testMutation.mutateAsync(testTo.trim());
      setTestSuccess(true);
      setInfo(t("emailConfig.msg.testSent", { to: testTo.trim() }) as string);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : (t("emailConfig.msg.testFailed") as string),
      );
    }
  };

  if (cfg.isLoading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "40px 0", color: "var(--text-secondary)", fontSize: 13 }}>
      <span style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", display: "inline-block", animation: "spin 0.8s linear infinite" }} />
      Loading email configuration…
    </div>
  );
  if (cfg.error || !cfg.data)
    return <p style={{ color: "var(--danger-text)", fontSize: 13 }}>Failed to load email config.</p>;

  const d = cfg.data;
  const pendingCount = pending.data?.count ?? 0;

  // A provider is "configured" if its primary credential is non-empty
  const smtpConfigured = !!d.smtp_host;
  const graphConfigured = !!d.graph_tenant_id;

  const onToggleEnabled = async () => {
    try {
      await patch.mutateAsync({ enabled: !d.enabled });
    } catch { /* banner shows error */ }
  };

  const onDeleteProvider = async (p: EmailProvider) => {
    try {
      const updates: Parameters<typeof patch.mutateAsync>[0] = p === "smtp"
        ? { smtp_host: "", smtp_username: "", smtp_password: "" }
        : { graph_tenant_id: "", graph_client_id: "", graph_client_secret: "" };
      // If deleting the active provider, switch to the other one (if available)
      if (p === "smtp" && d.provider === "smtp" && graphConfigured) {
        updates.provider = "microsoft_graph";
      } else if (p === "microsoft_graph" && d.provider === "microsoft_graph" && smtpConfigured) {
        updates.provider = "smtp";
      }
      await patch.mutateAsync(updates);
      setDeleteConfirm(null);
      setInfo(`${p === "smtp" ? "SMTP" : "Microsoft Graph"} configuration removed.`);
    } catch (err) {
      setDeleteConfirm(null);
      setError(err instanceof ApiError ? err.message : "Failed to remove provider.");
    }
  };

  const PROVIDERS: { key: EmailProvider; label: string; shortDesc: string; icon: React.ReactNode }[] = [
    { key: "smtp", label: "SMTP", shortDesc: "Gmail, Outlook, Brevo, or any relay", icon: <BsEnvelopeFill /> },
    { key: "microsoft_graph", label: "Microsoft Graph", shortDesc: "Microsoft 365 / Azure app credentials", icon: <BsCloudFill /> },
  ];

  const configuredList = PROVIDERS.filter((p) => p.key === "smtp" ? smtpConfigured : graphConfigured);
  const unconfiguredList = PROVIDERS.filter((p) => p.key === "smtp" ? !smtpConfigured : !graphConfigured);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Master switch banner (only when at least one provider is set) ── */}
      {(smtpConfigured || graphConfigured) && <div
        style={{
          borderRadius: 14,
          border: `1.5px solid ${d.enabled ? "#bbf7d0" : "#fecaca"}`,
          background: d.enabled
            ? "linear-gradient(135deg, color-mix(in srgb, #0a8a52 6%, var(--bg)) 0%, var(--bg) 100%)"
            : "linear-gradient(135deg, color-mix(in srgb, #b91c1c 5%, var(--bg)) 0%, var(--bg) 100%)",
          padding: "18px 22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: d.enabled
                ? "color-mix(in srgb, #0a8a52 15%, transparent)"
                : "color-mix(in srgb, #b91c1c 12%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              flexShrink: 0,
            }}
          >
            {d.enabled ? <BsEnvelopeCheckFill /> : <BsEnvelopeXFill />}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
              Email delivery is
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  padding: "2px 10px",
                  borderRadius: 999,
                  background: d.enabled ? "#0a8a52" : "#b91c1c",
                  color: "#fff",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", opacity: 0.8 }} />
                {d.enabled ? "ACTIVE" : "PAUSED"}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 3 }}>
              {d.enabled
                ? "Attendance reports and scheduled emails are being delivered."
                : pendingCount > 0
                  ? `Delivery paused · ${pendingCount} email${pendingCount !== 1 ? "s" : ""} queued but not yet sent`
                  : "No emails will be sent until you re-enable delivery."}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn"
          style={d.enabled
            ? { borderColor: "#fecaca", color: "#b91c1c", minWidth: 130 }
            : { borderColor: "#bbf7d0", color: "#0a8a52", minWidth: 130 }}
          disabled={patch.isPending}
          onClick={() => void onToggleEnabled()}
        >
          {patch.isPending
            ? "Saving…"
            : d.enabled
              ? <><BsPauseFill style={{ marginInlineEnd: 5 }} />Pause delivery</>
              : <><BsPlayFill style={{ marginInlineEnd: 5 }} />Resume delivery</>}
        </button>
      </div>}

      {/* Feedback banners */}
      {error && (
        <div role="alert" style={{ background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid #fecaca", padding: "10px 14px", borderRadius: 10, fontSize: 13, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <BsExclamationTriangleFill style={{ flexShrink: 0, marginTop: 1 }} />{error}
        </div>
      )}
      {info && (
        <div style={{ background: "color-mix(in srgb, #0a8a52 8%, var(--bg))", border: "1px solid #bbf7d0", padding: "10px 14px", borderRadius: 10, fontSize: 13, display: "flex", gap: 8, alignItems: "center", color: "#0a8a52", fontWeight: 500 }}>
          <BsCheckCircleFill style={{ marginInlineEnd: 6, flexShrink: 0 }} />{info}
        </div>
      )}

      {/* ── Configured provider cards ──────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: "var(--text-secondary)", letterSpacing: "0.05em", textTransform: "uppercase", paddingInlineStart: 2 }}>
            Email Providers
          </div>
          {unconfiguredList.length > 0 && (
            <div style={{ display: "flex", gap: 8 }}>
              {unconfiguredList.map(({ key, label, icon }) => (
                <button
                  key={key}
                  type="button"
                  className="btn btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                  onClick={() => setEditingProvider(key)}
                >
                  <BsPlusLg style={{ fontSize: 11 }} />
                  <span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>
                  Add {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {configuredList.length === 0 && (
          <div style={{ textAlign: "center", padding: "28px 20px", borderRadius: 14, border: "1.5px dashed var(--border)", color: "var(--text-secondary)", fontSize: 13 }}>
            No providers configured yet. Add one below to start sending emails.
          </div>
        )}

        {configuredList.map(({ key, label, icon }) => {
          const isActive = d.provider === key;

          return (
            <div
              key={key}
              style={{
                borderRadius: 14,
                border: `1.5px solid ${isActive ? "color-mix(in srgb, var(--accent,#0b6e4f) 30%, var(--border))" : "var(--border)"}`,
                background: isActive
                  ? "color-mix(in srgb, var(--accent,#0b6e4f) 3%, var(--bg))"
                  : "var(--bg)",
                overflow: "hidden",
                marginBottom: 10,
              }}
            >
              {/* Card header */}
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elev)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: isActive
                        ? "color-mix(in srgb, var(--accent,#0b6e4f) 14%, transparent)"
                        : "var(--bg-sunken)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      color: isActive ? "var(--accent,#0b6e4f)" : "var(--text-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
                      {label}
                      {isActive && (
                        <span className="pill pill-accent" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
                          Active
                        </span>
                      )}
                    </div>
                    {d.updated_at && (
                      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 1 }}>
                        Updated {new Date(d.updated_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setEditingProvider(key)}
                  >
                    <BsPencilFill style={{ marginInlineEnd: 5 }} />Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ color: "#b91c1c", borderColor: "#fecaca" }}
                    onClick={() => setDeleteConfirm(key)}
                    aria-label={`Remove ${label}`}
                  >
                    <BsTrashFill style={{ marginInlineEnd: 5 }} />Remove
                  </button>
                </div>
              </div>

              {/* Config tiles */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 1,
                  background: "var(--border)",
                }}
              >
                {key === "smtp" ? (
                  <>
                    <ConfigTile icon={<BsHddNetworkFill />} label="SMTP Server">
                      {d.smtp_host
                        ? <><strong>{d.smtp_host}</strong><span style={{ color: "var(--text-tertiary)" }}>:{d.smtp_port}</span>{d.smtp_use_tls && <span className="pill pill-neutral" style={{ fontSize: 10, marginInlineStart: 6 }}>TLS</span>}</>
                        : <span style={{ color: "var(--text-tertiary)" }}>Not configured</span>}
                    </ConfigTile>
                    <ConfigTile icon={<BsPersonFill />} label="Username">
                      {d.smtp_username || <span style={{ color: "var(--text-tertiary)" }}>—</span>}
                    </ConfigTile>
                    <ConfigTile icon={<BsKeyFill />} label="Password">
                      {d.has_smtp_password
                        ? <span style={{ letterSpacing: 2 }}>••••••<span style={{ marginInlineStart: 6, fontSize: 11, color: "var(--text-secondary)", letterSpacing: 0 }}>stored</span></span>
                        : <span style={{ color: "var(--text-tertiary)" }}>Not set</span>}
                    </ConfigTile>
                    <ConfigTile icon={<BsEnvelopeFill />} label="From Address">
                      {d.from_address
                        ? <><strong>{d.from_address}</strong>{d.from_name && <span style={{ color: "var(--text-tertiary)", display: "block", fontSize: 11.5, marginTop: 1 }}>{d.from_name}</span>}</>
                        : <span style={{ color: "var(--text-tertiary)" }}>—</span>}
                    </ConfigTile>
                  </>
                ) : (
                  <>
                    <ConfigTile icon={<BsBuildingFill />} label="Entra Tenant ID">
                      <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{d.graph_tenant_id || <span style={{ color: "var(--text-tertiary)", fontStyle: "normal" }}>—</span>}</code>
                    </ConfigTile>
                    <ConfigTile icon={<BsPersonBadgeFill />} label="Client ID">
                      <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{d.graph_client_id || <span style={{ color: "var(--text-tertiary)", fontStyle: "normal" }}>—</span>}</code>
                    </ConfigTile>
                    <ConfigTile icon={<BsShieldLockFill />} label="Client Secret">
                      {d.has_graph_client_secret
                        ? <span style={{ letterSpacing: 2 }}>••••••<span style={{ marginInlineStart: 6, fontSize: 11, color: "var(--text-secondary)", letterSpacing: 0 }}>stored</span></span>
                        : <span style={{ color: "var(--text-tertiary)" }}>Not set</span>}
                    </ConfigTile>
                    <ConfigTile icon={<BsEnvelopeFill />} label="From Address">
                      {d.from_address
                        ? <><strong>{d.from_address}</strong>{d.from_name && <span style={{ color: "var(--text-tertiary)", display: "block", fontSize: 11.5, marginTop: 1 }}>{d.from_name}</span>}</>
                        : <span style={{ color: "var(--text-tertiary)" }}>—</span>}
                    </ConfigTile>
                  </>
                )}
              </div>
            </div>
          );
        })}

      </div>

      {/* ── Provider config modal ──────────────────────────────────────────── */}
      {editingProvider !== null && (
        <ProviderConfigModal
          initialProvider={editingProvider}
          lockedProvider={editingProvider === "smtp" ? smtpConfigured : graphConfigured}
          configData={cfg.data}
          onClose={() => setEditingProvider(null)}
          onSaved={(msg) => { setInfo(msg); setEditingProvider(null); }}
        />
      )}

      {/* ── Delete confirm popup ───────────────────────────────────────────── */}
      {deleteConfirm !== null && (
        <ModalShell onClose={() => setDeleteConfirm(null)}>
          <div
            role="dialog"
            aria-label="Confirm remove provider"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 420,
              maxWidth: "92vw",
              background: "var(--bg)",
              border: "1px solid var(--border-strong)",
              borderRadius: 16,
              zIndex: 60,
              boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "18px 20px 14px",
                borderBottom: "1px solid var(--border)",
                background: "color-mix(in srgb, #b91c1c 5%, var(--bg))",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "color-mix(in srgb, #b91c1c 14%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  color: "#b91c1c",
                  flexShrink: 0,
                }}
              >
                <BsTrashFill />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>
                  Remove {deleteConfirm === "smtp" ? "SMTP" : "Microsoft Graph"}?
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
                  This will clear the stored credentials.
                </div>
              </div>
              <button
                className="icon-btn"
                aria-label="Close"
                onClick={() => setDeleteConfirm(null)}
                style={{ fontSize: 18, lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "18px 20px" }}>
              <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.6 }}>
                Are you sure you want to remove the{" "}
                <strong>{deleteConfirm === "smtp" ? "SMTP" : "Microsoft Graph"}</strong>{" "}
                configuration? All stored credentials will be cleared and cannot be recovered.
              </p>
              {deleteConfirm === d.provider && (configuredList.length === 1) && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 13px",
                    borderRadius: 9,
                    background: "color-mix(in srgb, #b45309 8%, var(--bg))",
                    border: "1px solid #b45309",
                    fontSize: 12.5,
                    color: "#92400e",
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                  }}
                >
                  <BsExclamationTriangleFill style={{ flexShrink: 0, marginTop: 1 }} />
                  This is your only configured provider. Removing it will disable email delivery.
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg-elev)",
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <button
                type="button"
                className="btn"
                onClick={() => setDeleteConfirm(null)}
                disabled={patch.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: "#b91c1c", color: "#fff", borderColor: "#b91c1c" }}
                onClick={() => void onDeleteProvider(deleteConfirm)}
                disabled={patch.isPending}
              >
                <BsTrashFill style={{ marginInlineEnd: 6 }} />
                {patch.isPending ? "Removing…" : "Yes, Remove"}
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {/* ── Test email card (only when at least one provider is set) ─────── */}
      {(smtpConfigured || graphConfigured) && <div
        style={{
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 22px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: "color-mix(in srgb, var(--accent, #0b6e4f) 12%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
            }}
          >
            <BsFlaskFill />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>Send Test Email</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 1 }}>
              Verify your configuration by sending a test message.
            </div>
          </div>
        </div>
        <div style={{ padding: "16px 22px" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <Field label="Recipient Email">
              <input
                className="input"
                value={testTo}
                onChange={(e) => { setTestTo(e.target.value); setTestSuccess(false); }}
                placeholder="you@your-domain.com"
                style={{ minWidth: 280 }}
              />
            </Field>
            <button
              type="button"
              className={`btn ${testSuccess ? "" : ""}`}
              style={testSuccess ? { borderColor: "#bbf7d0", color: "#0a8a52" } : {}}
              onClick={() => void onTest()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending
                ? "Sending…"
                : testSuccess
                  ? <><BsCheckCircleFill style={{ marginInlineEnd: 5 }} />Sent!</>
                  : "Send Test"}
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}

// ─── Attendance emails tab ────────────────────────────────────────────────────

const ATT_STATUSES: AttendanceEmailStatus[] = ["present", "late", "absent"];
const STATUS_LABELS: Record<AttendanceEmailStatus, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
};
const STATUS_COLORS: Record<AttendanceEmailStatus, string> = {
  present: "#0a8a52",
  late: "#b45309",
  absent: "#b91c1c",
};

const PAGE_SIZE = 50;

function AttendanceEmailsPanel({ isAdmin, isHR }: { isAdmin: boolean; isHR: boolean }) {
  const config = useAttendanceEmailConfig(isAdmin);
  const putConfig = usePutAttendanceEmailConfig();
  const pendingCount = usePendingEmailCount();

  // Filter + pagination state
  const [searchRaw, setSearchRaw] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  // Debounce search so we don't fire on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchRaw), 300);
    return () => clearTimeout(t);
  }, [searchRaw]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [debouncedSearch, dateFrom, dateTo]);

  const logParams = useMemo(() => {
    const p: { page: number; page_size: number; search?: string; date_from?: string; date_to?: string } = {
      page,
      page_size: PAGE_SIZE,
    };
    if (debouncedSearch) p.search = debouncedSearch;
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo) p.date_to = dateTo;
    return p;
  }, [page, debouncedSearch, dateFrom, dateTo]);

  const log = useAttendanceEmailLog(isAdmin || isHR, logParams);

  const [cancelledBanner, setCancelledBanner] = useState<AttendanceEmailConfigOut | null>(null);

  const current: AttendanceEmailConfig = config.data ?? {
    present: false,
    late: false,
    absent: false,
  };

  const onToggle = async (status: AttendanceEmailStatus, next: boolean) => {
    try {
      const result = await putConfig.mutateAsync({ ...current, [status]: next });
      if (!next && result.cancelled_queue_rows > 0) {
        setCancelledBanner(result);
      } else {
        setCancelledBanner(null);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Save failed.";
      window.alert(msg);
    }
  };

  const items = log.data?.items ?? [];
  const total = log.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Cancellation notice — shown briefly when queued emails were cancelled */}
      {cancelledBanner && cancelledBanner.cancelled_queue_rows > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 16px",
            background: "color-mix(in srgb, #b45309 10%, transparent)",
            border: "1px solid #b45309",
            borderRadius: 10,
            fontSize: 13,
            color: "#92400e",
          }}
        >
          <span>
            <strong>{cancelledBanner.cancelled_queue_rows}</strong> pending email
            {cancelledBanner.cancelled_queue_rows === 1 ? "" : "s"} in the queue were
            cancelled immediately.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setCancelledBanner(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#92400e",
              fontSize: 15,
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Toggles — Admin only */}
      {isAdmin && (
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Email Triggers</h3>
              <p className="card-sub">
                When enabled, employees receive a status email on the day their attendance is processed.
              </p>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {ATT_STATUSES.map((s) => {
                const active = current[s];
                return (
                  <label
                    key={s}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      border: `1.5px solid ${active ? STATUS_COLORS[s] : "var(--border)"}`,
                      borderRadius: 10,
                      padding: "10px 16px",
                      cursor: "pointer",
                      background: active
                        ? `color-mix(in srgb, ${STATUS_COLORS[s]} 8%, transparent)`
                        : "var(--bg)",
                      minWidth: 130,
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(e) => void onToggle(s, e.target.checked)}
                      disabled={config.isLoading || putConfig.isPending}
                      style={{ display: "none" }}
                    />
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: active ? STATUS_COLORS[s] : "var(--border)",
                        flexShrink: 0,
                        transition: "background 0.15s",
                      }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, color: active ? STATUS_COLORS[s] : "var(--text)" }}>
                      {STATUS_LABELS[s]}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Delivery log */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">
              Recent Deliveries
            </h3>
            <p className="card-sub">All attendance email attempts — search by name, filter by date.</p>
          </div>
          {/* Queue counter */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            {(() => {
              const count = pendingCount.data?.count ?? 0;
              return (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: count > 0 ? "var(--warn-soft, #fef9ec)" : "var(--bg-sunken)",
                    border: `1px solid ${count > 0 ? "var(--warn-border, #f5c518)" : "var(--border)"}`,
                    color: count > 0 ? "#b45309" : "var(--text-secondary)",
                  }}
                  title="Emails waiting to be sent"
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: count > 0 ? "#f59e0b" : "var(--border)",
                      flexShrink: 0,
                    }}
                  />
                  {count > 0 ? `${count} in queue` : "Queue empty"}
                </span>
              );
            })()}
          </div>
        </div>

        {/* Filter row */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            flexWrap: "wrap",
          }}
        >
          <div className="topbar-search" style={{ flex: "1 1 200px", minWidth: 160 }}>
            <Icon name="search" size={13} />
            <input
              placeholder="Search employee name…"
              value={searchRaw}
              onChange={(e) => setSearchRaw(e.target.value)}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-secondary)" }}>
            From
            <input
              type="date"
              className="input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ fontSize: 12.5, padding: "4px 8px" }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-secondary)" }}>
            To
            <input
              type="date"
              className="input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{ fontSize: 12.5, padding: "4px 8px" }}
            />
          </label>
          {(searchRaw || dateFrom || dateTo) && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => { setSearchRaw(""); setDateFrom(""); setDateTo(""); }}
            >
              Clear
            </button>
          )}
          <span
            className="mono text-xs text-dim"
            style={{ marginInlineStart: "auto", whiteSpace: "nowrap" }}
          >
            {items.length} / {total}
          </span>
        </div>

        {/* Table */}
        <div style={{ overflowX: "auto" }}>
          <table
            className="table"
            style={{ ["--mg-sticky-bg" as string]: "var(--bg-elev)" } as React.CSSProperties}
          >
            <thead
              style={{
                position: "sticky",
                top: 0,
                zIndex: 20,
                background: "var(--bg-elev)",
              }}
            >
              <tr>
                <th>Employee</th>
                <th>Date</th>
                <th>Status</th>
                <th>Recipient</th>
                <th>Delivery</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {log.isLoading && (
                <tr>
                  <td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 13 }}>
                    Loading…
                  </td>
                </tr>
              )}
              {!log.isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 13 }}>
                    {searchRaw || dateFrom || dateTo ? "No results match your filters." : "No attendance emails have been sent yet."}
                  </td>
                </tr>
              )}
              {items.map((item) => {
                const outcome = logOutcome(item);
                return (
                  <tr key={item.id}>
                    <td>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{item.employee_name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                        {item.employee_code}
                      </div>
                    </td>
                    <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{item.date}</td>
                    <td>
                      <span
                        className="pill pill-neutral"
                        style={{
                          fontSize: 11,
                          color:
                            item.status === "present"
                              ? STATUS_COLORS.present
                              : item.status === "late"
                                ? STATUS_COLORS.late
                                : STATUS_COLORS.absent,
                        }}
                      >
                        {STATUS_LABELS[item.status] ?? item.status}
                      </span>
                      {item.recipient_kind === "manager" && (
                        <span className="pill pill-neutral" style={{ fontSize: 10, marginInlineStart: 4 }}>
                          Mgr
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      {item.recipient_email ?? "—"}
                    </td>
                    <td>
                      <span
                        className={`pill ${
                          outcome.label === "Sent"
                            ? "pill-accent"
                            : outcome.label === "Failed"
                              ? "pill-danger"
                              : "pill-neutral"
                        }`}
                        style={{ fontSize: 11 }}
                        title={item.last_error ?? undefined}
                      >
                        {outcome.label}
                      </span>
                    </td>
                    <td style={{ fontSize: 12.5, color: "var(--text-secondary)", textAlign: "center" }}>
                      {item.attempts}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination strip */}
        {total > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 14px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
            }}
          >
            <span className="text-dim">
              Page {page} of {totalPages} · {total.toLocaleString()} total
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-sm"
                disabled={page <= 1 || log.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Icon name="chevronLeft" size={11} />
                Previous
              </button>
              <button
                className="btn btn-sm"
                disabled={page >= totalPages || log.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
                <Icon name="chevronRight" size={11} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export function EmailConfigPage() {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data?.active_role;
  const isAdmin = role === "Admin";
  const isHR = role === "HR";

  const [activeTab, setActiveTab] = useState<InnerTab>("provider");

  const tabs: { id: InnerTab; label: string }[] = [
    { id: "provider", label: "Provider" },
    { id: "attendance", label: "Attendance Emails" },
  ];

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
          {t("emailConfig.title") as string}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("emailConfig.subtitle") as string}
        </p>
      </header>

      <InnerTabs value={activeTab} onChange={setActiveTab} tabs={tabs} />

      {activeTab === "provider" && <ProviderPanel />}
      {activeTab === "attendance" && (
        <AttendanceEmailsPanel isAdmin={isAdmin} isHR={isHR} />
      )}
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function ConfigTile({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 20px", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <span style={{ fontSize: 14, color: "var(--accent, #0b6e4f)", display: "flex" }}>{icon}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)" }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>{children}</div>
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
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{hint}</span>
      )}
    </label>
  );
}
