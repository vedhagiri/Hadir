// Settings → Email. Admin-only.
// Two inner tabs: Provider (SMTP / Microsoft Graph config) and
// Attendance Emails (employee-facing status toggles + delivery log).
//
// Secrets stay write-only: the API only tells us ``has_smtp_password``
// / ``has_graph_client_secret``; the form sends a secret only when the
// operator actually typed one.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BsCloudFill, BsEnvelopeFill } from "react-icons/bs";

import { ApiError } from "../api/client";
import { useMe } from "../auth/AuthProvider";
import { EmptyPanel, ResetButton, SearchField, Toolbar } from "../components/ListPageUi";
import { SkeletonPanel, SkeletonRows } from "../components/Skeleton";
import { ChoiceCards, Field, FormFooter, FormNotice, FormSection, SwitchField } from "../components/FormKit";
import {
  ConfirmModal,
  Fact,
  Facts,
  FormField,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
  SettingsFormModal,
  SettingsPage,
  SoftPill,
  type PillTone,
} from "../settings/settingsUi";
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

import "./email-forms.css";

type InnerTab = "provider" | "attendance";

const CARD_W = { maxWidth: 960 } as const;

// ─── small helpers ────────────────────────────────────────────────────────────

type Outcome = "sent" | "skipped" | "failed" | "pending";

function logOutcome(item: AttendanceEmailLogItem): Outcome {
  if (item.sent_at) return "sent";
  if (item.skipped_at) return "skipped";
  if (item.failed_at) return "failed";
  return "pending";
}

const OUTCOME_TONE: Record<Outcome, PillTone> = {
  sent: "success",
  skipped: "neutral",
  failed: "danger",
  pending: "warning",
};

const ATT_STATUSES: AttendanceEmailStatus[] = ["present", "late", "absent"];
const STATUS_TONE: Record<AttendanceEmailStatus, PillTone> = {
  present: "success",
  late: "warning",
  absent: "danger",
};

function providerLabel(p: EmailProvider): string {
  return p === "smtp" ? "SMTP" : "Microsoft Graph";
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
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={`tab${value === tab.id ? " active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
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
  const { t } = useTranslation();
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

  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const requiredMsg = t("settingsUi.email.fieldRequired", { defaultValue: "This field is required." });

  const credLabel =
    provider === "smtp"
      ? t("settingsUi.email.stepSmtp", { defaultValue: "SMTP server" })
      : t("settingsUi.email.stepAzure", { defaultValue: "Azure credentials" });
  const steps = lockedProvider
    ? [
        { id: "credentials" as const, label: credLabel },
        { id: "sender" as const, label: t("settingsUi.email.stepSender", { defaultValue: "Sender identity" }) },
      ]
    : [
        { id: "provider" as const, label: t("emailConfig.field.provider") },
        { id: "credentials" as const, label: credLabel },
        { id: "sender" as const, label: t("settingsUi.email.stepSender", { defaultValue: "Sender identity" }) },
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
      onSaved(
        cancelled > 0
          ? `Saved · ${cancelled} queued emails cancelled`
          : t("settingsUi.email.configSaved", { defaultValue: "Configuration saved." }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("emailConfig.msg.saveFailed"));
    }
  };

  const onBack = () => {
    if (step === "credentials") {
      if (lockedProvider) {
        onClose();
        return;
      }
      setStep("provider");
    }
    if (step === "sender") setStep("credentials");
  };
  const isCancel = step === "provider" || (lockedProvider && step === "credentials");

  // Enter / primary button: advance a step, or save on the last one.
  const onPrimary = () => {
    if (!isStepValid()) return;
    if (step === "provider") setStep("credentials");
    else if (step === "credentials") setStep("sender");
    else if (!patch.isPending) void onSave();
  };

  const stored = t("settingsUi.email.storedReplacePlaceholder", { defaultValue: "•••••• stored — type to replace" });

  return (
    <SettingsFormModal
      size="lg"
      titleId="email-provider-modal-title"
      icon={<Icon name="mail" size={18} />}
      title={
        lockedProvider
          ? t("settingsUi.email.editProviderTitle", {
              defaultValue: "Edit {{provider}} configuration",
              provider: providerLabel(provider),
            })
          : t("settingsUi.email.addProviderTitle", { defaultValue: "Add email provider" })
      }
      subtitle={t("settingsUi.email.wizardSubtitle", {
        defaultValue: "Connect the service Maugood uses to send reports and notifications.",
      })}
      onClose={onClose}
      onSubmit={onPrimary}
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={
            step !== "sender" ? (
              <>
                {t("common.next")}
                <Icon name="chevronRight" size={12} />
              </>
            ) : (
              t("emailConfig.save")
            )
          }
          submittingLabel={t("common.saving")}
          submitting={patch.isPending}
          canSubmit={isStepValid()}
          extra={
            !isCancel ? (
              <button type="button" className="btn btn-ghost" onClick={onBack} disabled={patch.isPending}>
                <Icon name="chevronLeft" size={12} />
                {t("settingsUi.email.back", { defaultValue: "Back" })}
              </button>
            ) : undefined
          }
        />
      }
    >
      {/* Step progress */}
      <ol className="em-stepper" aria-label={t("settingsUi.email.steps", { defaultValue: "Steps" })}>
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={`em-step${i < stepIdx ? " is-done" : ""}${i === stepIdx ? " is-current" : ""}`}
            aria-current={i === stepIdx ? "step" : undefined}
          >
            <span className="em-step-dot" aria-hidden>
              {i < stepIdx ? <Icon name="check" size={11} /> : i + 1}
            </span>
            <span className="em-step-label">{s.label}</span>
          </li>
        ))}
      </ol>

      {error && <FormNotice tone="danger">{error}</FormNotice>}

      {/* ── Step 1: Provider ── */}
      {step === "provider" && (
        <FormSection
          title={t("emailConfig.field.provider")}
          description={t("settingsUi.email.chooseProvider", { defaultValue: "Choose the email service to use for outbound delivery." })}
        >
          <ChoiceCards<EmailProvider>
            label={t("emailConfig.field.provider")}
            value={provider}
            onChange={setProvider}
            options={[
              {
                value: "smtp",
                icon: <BsEnvelopeFill />,
                title: providerLabel("smtp"),
                description: (
                  <>
                    {t("settingsUi.email.smtpDesc", { defaultValue: "Gmail, Outlook, Brevo, or any custom SMTP relay" })}
                    <span className="em-tags">
                      {["Gmail", "Outlook", "Brevo", "SendGrid"].map((tag) => (
                        <span key={tag} className="pill pill-neutral">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </>
                ),
              },
              {
                value: "microsoft_graph",
                icon: <BsCloudFill />,
                title: providerLabel("microsoft_graph"),
                description: t("settingsUi.email.graphDesc", { defaultValue: "Microsoft 365 / Azure with app credentials" }),
              },
            ]}
          />
        </FormSection>
      )}

      {/* ── Step 2: Credentials ── */}
      {step === "credentials" &&
        (provider === "smtp" ? (
          <FormSection
            title={t("settingsUi.email.stepSmtp", { defaultValue: "SMTP server" })}
            description={t("settingsUi.email.smtpIntro", {
              defaultValue: "Enter your SMTP relay server details. These are provided by your email service.",
            })}
          >
            <Field
              label={t("emailConfig.field.host")}
              required
              htmlFor="smtp-host"
              error={touched.host && !smtpHost.trim() ? requiredMsg : undefined}
            >
              <input
                id="smtp-host"
                className="input"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                onBlur={() => touch("host")}
                placeholder="smtp.example.com"
              />
            </Field>
            <Field label={t("emailConfig.field.port")} htmlFor="smtp-port">
              <input id="smtp-port" className="input" type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} placeholder="587" />
            </Field>
            <Field label={t("emailConfig.field.username")} htmlFor="smtp-user">
              <input id="smtp-user" className="input" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} autoComplete="off" placeholder="your@email.com" />
            </Field>
            <Field
              label={t("emailConfig.field.password")}
              htmlFor="smtp-pass"
              help={d.has_smtp_password ? t("emailConfig.hint.secretStored") : t("emailConfig.hint.passwordRequired")}
            >
              <input
                id="smtp-pass"
                className="input"
                type="password"
                value={smtpPassword}
                placeholder={d.has_smtp_password ? stored : t("settingsUi.email.enterPassword", { defaultValue: "Enter password" })}
                onChange={(e) => setSmtpPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <SwitchField
              id="smtp-tls"
              checked={smtpUseTls}
              onChange={setSmtpUseTls}
              label={t("emailConfig.field.useTls")}
              description={t("settingsUi.email.tlsHint", { defaultValue: "(recommended for port 587)" })}
            />
          </FormSection>
        ) : (
          <FormSection
            title={t("settingsUi.email.stepAzure", { defaultValue: "Azure credentials" })}
            description={t("settingsUi.email.graphIntro", {
              defaultValue: "Register an app in Azure Active Directory and paste the credentials below.",
            })}
          >
            <Field
              label={t("emailConfig.field.entraTenantId")}
              required
              htmlFor="graph-tenant"
              span={2}
              error={touched.tenant && !graphTenant.trim() ? requiredMsg : undefined}
            >
              <input
                id="graph-tenant"
                className="input mono"
                value={graphTenant}
                onChange={(e) => setGraphTenant(e.target.value)}
                onBlur={() => touch("tenant")}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </Field>
            <Field
              label={t("emailConfig.field.clientId")}
              required
              htmlFor="graph-client"
              span={2}
              error={touched.client && !graphClientId.trim() ? requiredMsg : undefined}
            >
              <input
                id="graph-client"
                className="input mono"
                value={graphClientId}
                onChange={(e) => setGraphClientId(e.target.value)}
                onBlur={() => touch("client")}
                autoComplete="off"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </Field>
            <Field
              label={t("emailConfig.field.clientSecret")}
              htmlFor="graph-secret"
              span={2}
              help={d.has_graph_client_secret ? t("emailConfig.hint.secretStored") : t("emailConfig.hint.clientSecret")}
            >
              <input
                id="graph-secret"
                className="input"
                type="password"
                value={graphClientSecret}
                placeholder={d.has_graph_client_secret ? stored : t("settingsUi.email.enterSecret", { defaultValue: "Enter client secret" })}
                onChange={(e) => setGraphClientSecret(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </FormSection>
        ))}

      {/* ── Step 3: Sender identity ── */}
      {step === "sender" && (
        <FormSection
          title={t("settingsUi.email.stepSender", { defaultValue: "Sender identity" })}
          description={t("settingsUi.email.senderIntro", { defaultValue: "The name and address that recipients will see in their inbox." })}
        >
          <Field
            label={t("emailConfig.field.fromAddress")}
            required
            htmlFor="from-address"
            error={touched.from && !fromAddress.trim() ? requiredMsg : undefined}
          >
            <input
              id="from-address"
              className="input"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              onBlur={() => touch("from")}
              placeholder="reports@your-domain.com"
            />
          </Field>
          <Field label={t("emailConfig.field.fromName")} htmlFor="from-name">
            <input id="from-name" className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Maugood Reports" />
          </Field>
          <Field
            label={t("settingsUi.email.bccLabel", { defaultValue: "BCC (monitoring address)" })}
            htmlFor="bcc-address"
            span={2}
            help={t("settingsUi.email.bccHelp", { defaultValue: "Optional. Every outbound email is also copied here." })}
          >
            <input id="bcc-address" className="input" type="email" value={bccAddress} onChange={(e) => setBccAddress(e.target.value)} placeholder="monitoring@your-company.com" />
          </Field>
          <SwitchField
            id="email-enabled"
            checked={enabled}
            onChange={setEnabled}
            label={t("settingsUi.email.enableSending", { defaultValue: "Enable email sending" })}
            description={t("settingsUi.email.enableSendingDesc", {
              defaultValue: "When off, nothing is sent and new emails are not queued.",
            })}
          />
          {!enabled && pendingCount > 0 && (
            <FormNotice tone="warning">{t("emailConfig.disableQueueNote", { count: pendingCount })}</FormNotice>
          )}
        </FormSection>
      )}
    </SettingsFormModal>
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
      setError(err instanceof ApiError ? err.message : (t("emailConfig.msg.testFailed") as string));
    }
  };

  if (cfg.isLoading) return <SkeletonPanel lines={5} />;
  if (cfg.error || !cfg.data)
    return (
      <LoadErrorPanel
        title={t("emailConfig.loadError")}
        {...(cfg.error?.message ? { body: cfg.error.message } : {})}
        onRetry={() => void cfg.refetch()}
      />
    );

  const d = cfg.data;
  const pendingCount = pending.data?.count ?? 0;

  // A provider is "configured" if its primary credential is non-empty
  const smtpConfigured = !!d.smtp_host;
  const graphConfigured = !!d.graph_tenant_id;
  const anyConfigured = smtpConfigured || graphConfigured;

  const onToggleEnabled = async () => {
    try {
      await patch.mutateAsync({ enabled: !d.enabled });
    } catch {
      /* banner shows error */
    }
  };

  const onDeleteProvider = async (p: EmailProvider) => {
    try {
      const updates: Parameters<typeof patch.mutateAsync>[0] =
        p === "smtp"
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
      setInfo(t("settingsUi.email.providerRemoved", { defaultValue: "{{provider}} configuration removed.", provider: providerLabel(p) }));
    } catch (err) {
      setDeleteConfirm(null);
      setError(err instanceof ApiError ? err.message : t("settingsUi.email.removeFailed", { defaultValue: "Failed to remove provider." }));
    }
  };

  const PROVIDERS: { key: EmailProvider; label: string; icon: React.ReactNode }[] = [
    { key: "smtp", label: "SMTP", icon: <BsEnvelopeFill /> },
    { key: "microsoft_graph", label: "Microsoft Graph", icon: <BsCloudFill /> },
  ];

  const configuredList = PROVIDERS.filter((p) => (p.key === "smtp" ? smtpConfigured : graphConfigured));
  const unconfiguredList = PROVIDERS.filter((p) => (p.key === "smtp" ? !smtpConfigured : !graphConfigured));

  const addButtons = unconfiguredList.map(({ key, label }) => (
    <button key={key} type="button" className="btn btn-sm" onClick={() => setEditingProvider(key)}>
      <Icon name="plus" size={12} />
      {t("settingsUi.email.addProvider", { defaultValue: "Add {{provider}}", provider: label })}
    </button>
  ));

  const fromFact = (
    <Fact label={t("emailConfig.field.fromAddress")} icon={<Icon name="mail" size={12} />}>
      {d.from_address ? (
        <>
          <strong>{d.from_address}</strong>
          {d.from_name && <div className="text-xs text-dim">{d.from_name}</div>}
        </>
      ) : (
        <span className="text-dim">—</span>
      )}
    </Fact>
  );
  const secretFact = (label: string, has: boolean) => (
    <Fact label={label} icon={<Icon name="shield" size={12} />}>
      {has ? (
        <>
          <span aria-hidden>••••••</span>{" "}
          <span className="text-xs text-dim">{t("settingsUi.email.stored", { defaultValue: "stored" })}</span>
        </>
      ) : (
        <span className="text-dim">{t("settingsUi.email.notSet", { defaultValue: "Not set" })}</span>
      )}
    </Fact>
  );

  return (
    <div className="st-stack">
      {/* ── Master switch banner (only when at least one provider is set) ── */}
      {anyConfigured && (
        <InlineAlert
          tone={d.enabled ? "success" : "warning"}
          title={
            d.enabled
              ? t("settingsUi.email.deliveryActive", { defaultValue: "Email delivery is active" })
              : t("settingsUi.email.deliveryPaused", { defaultValue: "Email delivery is paused" })
          }
          actions={
            <button type="button" className="btn btn-sm" disabled={patch.isPending} onClick={() => void onToggleEnabled()}>
              <Icon name={d.enabled ? "pause" : "play"} size={12} />
              {patch.isPending
                ? t("common.saving")
                : d.enabled
                  ? t("settingsUi.email.pauseDelivery", { defaultValue: "Pause delivery" })
                  : t("settingsUi.email.resumeDelivery", { defaultValue: "Resume delivery" })}
            </button>
          }
        >
          {d.enabled
            ? t("settingsUi.email.deliveryActiveBody", { defaultValue: "Attendance reports and scheduled emails are being delivered." })
            : pendingCount > 0
              ? t("settingsUi.email.deliveryPausedQueued", {
                  defaultValue: "Delivery paused · {{count}} email(s) queued but not yet sent.",
                  count: pendingCount,
                })
              : t("settingsUi.email.deliveryPausedBody", { defaultValue: "No emails will be sent until you re-enable delivery." })}
        </InlineAlert>
      )}

      {/* Feedback banners */}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {info && <InlineAlert tone="success">{info}</InlineAlert>}

      {/* ── Provider cards ─────────────────────────────────────────────────── */}
      <div className="st-inline" style={{ justifyContent: "space-between" }}>
        <h2 className="st-section-title" style={{ margin: 0 }}>
          {t("settingsUi.email.providersHeading", { defaultValue: "Email providers" })}
        </h2>
        {configuredList.length > 0 && unconfiguredList.length > 0 && <div className="st-inline">{addButtons}</div>}
      </div>

      {configuredList.length === 0 && (
        <div className="card st-card" style={CARD_W}>
          <EmptyPanel
            tone="accent"
            icon={<Icon name="mail" size={28} />}
            title={t("settingsUi.email.noProvidersTitle", { defaultValue: "No email provider yet" })}
            body={t("settingsUi.email.noProvidersBody", {
              defaultValue: "Connect an SMTP relay or Microsoft Graph so scheduled reports and notifications can be delivered.",
            })}
            actions={addButtons}
          />
        </div>
      )}

      {configuredList.map(({ key, label, icon }) => {
        const isActive = d.provider === key;
        return (
          <SettingsCard
            key={key}
            style={CARD_W}
            icon={icon}
            title={
              <span className="st-inline" style={{ gap: 8 }}>
                {label}
                {isActive ? (
                  <SoftPill tone="success">{t("settingsUi.email.active", { defaultValue: "Active" })}</SoftPill>
                ) : (
                  <SoftPill tone="neutral">{t("settingsUi.email.inactive", { defaultValue: "Inactive" })}</SoftPill>
                )}
              </span>
            }
            description={
              d.updated_at
                ? t("settingsUi.email.updatedAt", { defaultValue: "Updated {{when}}", when: new Date(d.updated_at).toLocaleString() })
                : undefined
            }
            actions={
              <>
                <button type="button" className="btn btn-sm" onClick={() => setEditingProvider(key)}>
                  <Icon name="edit" size={12} />
                  {t("emailConfig.edit")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost st-danger"
                  onClick={() => setDeleteConfirm(key)}
                  aria-label={t("settingsUi.email.removeProvider", { defaultValue: "Remove {{provider}}", provider: label })}
                >
                  <Icon name="trash" size={12} />
                  {t("settingsUi.email.remove", { defaultValue: "Remove" })}
                </button>
              </>
            }
          >
            <Facts>
              {key === "smtp" ? (
                <>
                  <Fact label={t("settingsUi.email.smtpServer", { defaultValue: "SMTP server" })} icon={<Icon name="database" size={12} />}>
                    {d.smtp_host ? (
                      <span className="st-inline" style={{ gap: 6 }}>
                        <span className="mono">
                          <strong>{d.smtp_host}</strong>
                          <span className="text-dim">:{d.smtp_port}</span>
                        </span>
                        {d.smtp_use_tls && (
                          <span className="pill pill-neutral">TLS</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-dim">{t("settingsUi.email.notConfigured", { defaultValue: "Not configured" })}</span>
                    )}
                  </Fact>
                  <Fact label={t("emailConfig.field.username")} icon={<Icon name="user" size={12} />}>
                    {d.smtp_username || <span className="text-dim">—</span>}
                  </Fact>
                  {secretFact(t("emailConfig.field.password"), d.has_smtp_password)}
                  {fromFact}
                </>
              ) : (
                <>
                  <Fact label={t("emailConfig.field.entraTenantId")} icon={<Icon name="globe" size={12} />} mono>
                    {d.graph_tenant_id || <span className="text-dim">—</span>}
                  </Fact>
                  <Fact label={t("emailConfig.field.clientId")} icon={<Icon name="user" size={12} />} mono>
                    {d.graph_client_id || <span className="text-dim">—</span>}
                  </Fact>
                  {secretFact(t("emailConfig.field.clientSecret"), d.has_graph_client_secret)}
                  {fromFact}
                </>
              )}
            </Facts>
          </SettingsCard>
        );
      })}

      {/* ── Provider config modal ──────────────────────────────────────────── */}
      {editingProvider !== null && (
        <ProviderConfigModal
          initialProvider={editingProvider}
          lockedProvider={editingProvider === "smtp" ? smtpConfigured : graphConfigured}
          configData={cfg.data}
          onClose={() => setEditingProvider(null)}
          onSaved={(msg) => {
            setInfo(msg);
            setEditingProvider(null);
          }}
        />
      )}

      {/* ── Delete confirm popup ───────────────────────────────────────────── */}
      {deleteConfirm !== null && (
        <ConfirmModal
          titleId="email-remove-title"
          title={t("settingsUi.email.removeTitle", { defaultValue: "Remove {{provider}}?", provider: providerLabel(deleteConfirm) })}
          subtitle={t("settingsUi.email.removeSubtitle", { defaultValue: "This will clear the stored credentials." })}
          confirmLabel={t("settingsUi.email.removeConfirm", { defaultValue: "Yes, remove" })}
          busy={patch.isPending}
          onConfirm={() => void onDeleteProvider(deleteConfirm)}
          onClose={() => setDeleteConfirm(null)}
        >
          <p className="st-confirm-text">
            {t("settingsUi.email.removeBody", {
              defaultValue: "Are you sure you want to remove the {{provider}} configuration? All stored credentials will be cleared and cannot be recovered.",
              provider: providerLabel(deleteConfirm),
            })}
          </p>
          {deleteConfirm === d.provider && configuredList.length === 1 && (
            <FormNotice tone="warning">
              {t("settingsUi.email.removeOnlyProvider", {
                defaultValue: "This is your only configured provider. Removing it will disable email delivery.",
              })}
            </FormNotice>
          )}
        </ConfirmModal>
      )}

      {/* ── Test email card (only when at least one provider is set) ─────── */}
      {anyConfigured && (
        <SettingsCard
          style={CARD_W}
          icon={<Icon name="send" size={17} />}
          title={t("emailConfig.test.title")}
          description={t("emailConfig.test.desc")}
          footer={
            <button type="button" className="btn" onClick={() => void onTest()} disabled={testMutation.isPending}>
              {testMutation.isPending ? (
                t("emailConfig.test.sending")
              ) : testSuccess ? (
                <>
                  <Icon name="check" size={12} />
                  {t("settingsUi.email.sent", { defaultValue: "Sent" })}
                </>
              ) : (
                <>
                  <Icon name="send" size={12} />
                  {t("emailConfig.test.send")}
                </>
              )}
            </button>
          }
        >
          <FormField label={t("settingsUi.email.recipient", { defaultValue: "Recipient email" })} htmlFor="test-to">
            <input
              id="test-to"
              className="input"
              type="email"
              value={testTo}
              onChange={(e) => {
                setTestTo(e.target.value);
                setTestSuccess(false);
              }}
              placeholder="you@your-domain.com"
              style={{ maxWidth: 420 }}
            />
          </FormField>
        </SettingsCard>
      )}
    </div>
  );
}

// ─── Attendance emails tab ────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function AttendanceEmailsPanel({ isAdmin, isHR }: { isAdmin: boolean; isHR: boolean }) {
  const { t } = useTranslation();
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
    const id = setTimeout(() => setDebouncedSearch(searchRaw), 300);
    return () => clearTimeout(id);
  }, [searchRaw]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, dateFrom, dateTo]);

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
      const msg = err instanceof ApiError ? err.message : t("emailConfig.msg.saveFailed");
      window.alert(msg);
    }
  };

  const items = log.data?.items ?? [];
  const total = log.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = !!(searchRaw || dateFrom || dateTo);
  const clearFilters = () => {
    setSearchRaw("");
    setDateFrom("");
    setDateTo("");
  };
  const queue = pendingCount.data?.count ?? 0;

  const statusLabel = (s: AttendanceEmailStatus) =>
    t(`settingsUi.email.status.${s}`, { defaultValue: s === "present" ? "Present" : s === "late" ? "Late" : "Absent" });

  return (
    <div className="st-stack st-stack-wide">
      {/* Cancellation notice — shown when queued emails were cancelled */}
      {cancelledBanner && cancelledBanner.cancelled_queue_rows > 0 && (
        <InlineAlert
          tone="warning"
          actions={
            <button type="button" className="btn btn-sm" onClick={() => setCancelledBanner(null)}>
              {t("common.dismiss")}
            </button>
          }
        >
          {t("settingsUi.email.queueCancelled", {
            defaultValue: "{{count}} pending email(s) in the queue were cancelled immediately.",
            count: cancelledBanner.cancelled_queue_rows,
          })}
        </InlineAlert>
      )}

      {/* Toggles — Admin only */}
      {isAdmin && (
        <SettingsCard
          style={CARD_W}
          icon={<Icon name="bell" size={17} />}
          title={t("settingsUi.email.triggersTitle", { defaultValue: "Email triggers" })}
          description={t("settingsUi.email.triggersDesc", {
            defaultValue: "When enabled, employees receive a status email on the day their attendance is processed.",
          })}
        >
          <div className="st-chips" role="group" aria-label={t("settingsUi.email.triggersTitle", { defaultValue: "Email triggers" })}>
            {ATT_STATUSES.map((s) => {
              const active = current[s];
              return (
                <button
                  key={s}
                  type="button"
                  className="st-chip"
                  aria-pressed={active}
                  disabled={config.isLoading || putConfig.isPending}
                  onClick={() => void onToggle(s, !active)}
                >
                  <SoftPill tone={active ? STATUS_TONE[s] : "neutral"}>{statusLabel(s)}</SoftPill>
                  <span className="text-xs text-dim">
                    {active ? t("settingsUi.email.on", { defaultValue: "On" }) : t("settingsUi.email.off", { defaultValue: "Off" })}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsCard>
      )}

      {/* Delivery log */}
      <SettingsCard
        icon={<Icon name="activity" size={17} />}
        title={t("settingsUi.email.recentTitle", { defaultValue: "Recent deliveries" })}
        description={t("settingsUi.email.recentDesc", { defaultValue: "All attendance email attempts — search by name, filter by date." })}
        actions={
          <SoftPill tone={queue > 0 ? "warning" : "neutral"} title={t("settingsUi.email.queueTitle", { defaultValue: "Emails waiting to be sent" })}>
            {queue > 0
              ? t("settingsUi.email.inQueue", { defaultValue: "{{count}} in queue", count: queue })
              : t("settingsUi.email.queueEmpty", { defaultValue: "Queue empty" })}
          </SoftPill>
        }
        flush
      >
        <div style={{ padding: "12px 20px 0" }}>
          <Toolbar>
            <SearchField
              value={searchRaw}
              onChange={setSearchRaw}
              placeholder={t("settingsUi.email.searchEmployee", { defaultValue: "Search employee name…" })}
              clearLabel={t("settingsUi.email.clearSearch", { defaultValue: "Clear search" })}
            />
            <label className="st-inline text-sm text-dim" style={{ gap: 6 }}>
              {t("settingsUi.email.from", { defaultValue: "From" })}
              <input type="date" className="input sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label={t("settingsUi.email.dateFrom", { defaultValue: "From date" })} />
            </label>
            <label className="st-inline text-sm text-dim" style={{ gap: 6 }}>
              {t("settingsUi.email.to", { defaultValue: "To" })}
              <input type="date" className="input sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label={t("settingsUi.email.dateTo", { defaultValue: "To date" })} />
            </label>
            <ResetButton active={filtersActive} label={t("settingsUi.email.reset", { defaultValue: "Reset" })} onClick={clearFilters} />
          </Toolbar>
        </div>

        {log.isError ? (
          <div style={{ padding: 12 }}>
            <LoadErrorPanel
              title={t("settingsUi.email.logLoadFailed", { defaultValue: "Couldn't load the delivery log" })}
              {...(log.error?.message ? { body: log.error.message } : {})}
              onRetry={() => void log.refetch()}
            />
          </div>
        ) : !log.isLoading && items.length === 0 ? (
          <div style={{ padding: 12 }}>
            {filtersActive ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="search" size={28} />}
                title={t("settingsUi.email.noResultsTitle", { defaultValue: "No results" })}
                body={t("settingsUi.email.noResultsBody", { defaultValue: "No deliveries match the current search or date range." })}
                actions={
                  <button type="button" className="btn" onClick={clearFilters}>
                    <Icon name="refresh" size={12} />
                    {t("settingsUi.email.clearFilters", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : (
              <EmptyPanel
                tone="accent"
                icon={<Icon name="mail" size={28} />}
                title={t("settingsUi.email.noLogTitle", { defaultValue: "No attendance emails sent yet" })}
                body={t("settingsUi.email.noLogBody", {
                  defaultValue: "Deliveries appear here once a trigger above is on and attendance is processed.",
                })}
              />
            )}
          </div>
        ) : (
          <div className="st-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("settingsUi.email.colEmployee", { defaultValue: "Employee" })}</th>
                  <th>{t("settingsUi.email.colDate", { defaultValue: "Date" })}</th>
                  <th>{t("settingsUi.email.colStatus", { defaultValue: "Status" })}</th>
                  <th>{t("settingsUi.email.colRecipient", { defaultValue: "Recipient" })}</th>
                  <th>{t("settingsUi.email.colDelivery", { defaultValue: "Delivery" })}</th>
                  <th>{t("settingsUi.email.colAttempts", { defaultValue: "Attempts" })}</th>
                </tr>
              </thead>
              <tbody>
                {log.isLoading && <SkeletonRows cols={6} />}
                {items.map((item) => {
                  const outcome = logOutcome(item);
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="row-person-name">{item.employee_name}</div>
                        <div className="row-person-meta mono">{item.employee_code}</div>
                      </td>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>
                        {item.date}
                      </td>
                      <td>
                        <span className="st-inline" style={{ gap: 4 }}>
                          <SoftPill tone={STATUS_TONE[item.status] ?? "neutral"}>{statusLabel(item.status)}</SoftPill>
                          {item.recipient_kind === "manager" && (
                            <span className="pill pill-neutral">{t("settingsUi.email.managerTag", { defaultValue: "Mgr" })}</span>
                          )}
                        </span>
                      </td>
                      <td className="text-sm text-dim">{item.recipient_email ?? "—"}</td>
                      <td>
                        <SoftPill tone={OUTCOME_TONE[outcome]} {...(item.last_error ? { title: item.last_error } : {})}>
                          {t(`settingsUi.email.outcome.${outcome}`, {
                            defaultValue: outcome === "sent" ? "Sent" : outcome === "skipped" ? "Skipped" : outcome === "failed" ? "Failed" : "Pending",
                          })}
                        </SoftPill>
                      </td>
                      <td className="mono text-sm">{item.attempts}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination strip */}
        {total > 0 && (
          <div className="st-card-foot">
            <span className="st-card-foot-note">
              {t("settingsUi.email.pageOf", {
                defaultValue: "Page {{page}} of {{pages}} · {{total}} total",
                page,
                pages: totalPages,
                total: total.toLocaleString(),
              })}
            </span>
            <button type="button" className="btn btn-sm" disabled={page <= 1 || log.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <Icon name="chevronLeft" size={11} />
              {t("common.previous")}
            </button>
            <button type="button" className="btn btn-sm" disabled={page >= totalPages || log.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              {t("common.next")}
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        )}
      </SettingsCard>
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
    { id: "provider", label: t("settingsUi.email.tabProvider", { defaultValue: "Provider" }) },
    { id: "attendance", label: t("settingsUi.email.tabAttendance", { defaultValue: "Attendance emails" }) },
  ];

  return (
    <SettingsPage title={t("emailConfig.title") as string} subtitle={t("emailConfig.subtitle") as string} wide>
      <InnerTabs value={activeTab} onChange={setActiveTab} tabs={tabs} />

      {activeTab === "provider" && <ProviderPanel />}
      {activeTab === "attendance" && <AttendanceEmailsPanel isAdmin={isAdmin} isHR={isHR} />}
    </SettingsPage>
  );
}
