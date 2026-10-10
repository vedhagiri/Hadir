// Admin-only "Settings → Authentication" page (P6 + Google Sign-In).
//
// Two single-sign-on providers — Microsoft (Entra ID) and Google —
// each rendered as a sectioned SettingsCard (brand tile + status pill
// + a read-only facts grid) with an "Edit" button that opens a config
// modal. Mirrors the Settings → Email page format so the two settings
// surfaces read the same way.
//
// Both client secrets are write-only: a stored secret shows "••••••
// stored" in the summary and the modal leaves it untouched unless the
// operator types a new value. Enabling a provider pings its OIDC
// discovery endpoint before persisting (server side).

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { EmptyPanel } from "../components/ListPageUi";
import { Field, FormFooter, FormNotice, FormSection, SwitchField } from "../components/FormKit";
import { SkeletonLines } from "../components/Skeleton";
import {
  ConfirmModal,
  Fact,
  Facts,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
  SettingsFormModal,
  SettingsPage,
  SoftPill,
} from "../settings/settingsUi";
import { Icon } from "../shell/Icon";
import type { IconName } from "../shell/Icon";
import {
  useDeleteMyGoogleConfig,
  useDeleteMyOidcConfig,
  useMyGoogleConfig,
  useMyOidcConfig,
  usePutMyGoogleConfig,
  usePutMyOidcConfig,
} from "./hooks";
import type { GoogleOidcConfigResponse, OidcConfigResponse } from "./types";

import "./auth-forms.css";

export function AuthenticationPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<string | null>(null);

  return (
    <SettingsPage title={t("authPage.title")} subtitle={t("authPage.subtitle")}>
      {info && (
        <InlineAlert tone="success" role="status">
          {info}
        </InlineAlert>
      )}

      <MicrosoftCard onSaved={setInfo} />
      <GoogleCard onSaved={setInfo} />
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Microsoft (Entra ID)
// ---------------------------------------------------------------------------

function MicrosoftCard({ onSaved }: { onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const cfg = useMyOidcConfig();
  const del = useDeleteMyOidcConfig();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const d = cfg.data ?? null;
  const configured = !!d && (!!d.client_id || d.has_secret);
  const providerName = t("authPage.microsoft.title");

  return (
    <>
      <ProviderSummaryCard
        logo={<MicrosoftLogo size={20} />}
        name={providerName}
        subtitle={t("authPage.microsoft.subtitle")}
        loading={cfg.isLoading}
        loadError={cfg.error ? t("authPage.loadFailed") : null}
        onRetry={() => void cfg.refetch()}
        enabled={d?.enabled ?? false}
        configured={configured}
        updatedAt={d?.updated_at ?? null}
        onEdit={() => setEditing(true)}
        onRemove={configured ? () => setConfirming(true) : undefined}
        tiles={[
          {
            icon: "shield",
            label: t("authPage.fields.entraTenantId"),
            value: <Mono value={d?.entra_tenant_id} />,
          },
          {
            icon: "user",
            label: t("authPage.fields.clientId"),
            value: <Mono value={d?.client_id} />,
          },
          {
            icon: "eyeOff",
            label: t("authPage.fields.clientSecret"),
            value: <SecretValue has={d?.has_secret ?? false} />,
          },
          {
            icon: "globe",
            label: t("authPage.redirectUriLabel"),
            value: <RedirectUriValue value={d?.redirect_uri} />,
            full: true,
          },
        ]}
      />
      {editing && d && (
        <MicrosoftEditModal
          data={d}
          onClose={() => setEditing(false)}
          onSaved={(msg) => {
            setEditing(false);
            onSaved(msg);
          }}
        />
      )}
      {confirming && (
        <ConfirmRemoveModal
          provider={providerName}
          pending={del.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await del.mutateAsync();
            setConfirming(false);
            onSaved(t("authPage.removedProvider", { provider: providerName }));
          }}
        />
      )}
    </>
  );
}

function MicrosoftEditModal({
  data,
  onClose,
  onSaved,
}: {
  data: OidcConfigResponse;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const put = usePutMyOidcConfig();

  const [entraTenant, setEntraTenant] = useState(data.entra_tenant_id);
  const [clientId, setClientId] = useState(data.client_id);
  const [clientSecret, setClientSecret] = useState("");
  const [enabled, setEnabled] = useState(data.enabled);
  const [redirectUri, setRedirectUri] = useState(data.redirect_uri);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, touch] = useTouched();

  const onSave = async () => {
    setServerError(null);
    try {
      const payload: { [k: string]: unknown } = {
        entra_tenant_id: entraTenant.trim(),
        client_id: clientId.trim(),
        enabled,
        redirect_uri: redirectUri.trim(),
      };
      if (clientSecret.length > 0) payload.client_secret = clientSecret;
      await put.mutateAsync(payload);
      onSaved(t("authPage.savedProvider", { provider: t("authPage.microsoft.title") }));
    } catch (err) {
      setServerError(readServerError(err, t));
    }
  };

  const requiredSatisfied =
    !!entraTenant.trim() &&
    !!clientId.trim() &&
    (clientSecret.length > 0 || data.has_secret);
  const dirty =
    entraTenant !== data.entra_tenant_id ||
    clientId !== data.client_id ||
    clientSecret !== "" ||
    enabled !== data.enabled ||
    redirectUri !== data.redirect_uri;
  const requiredMsg = t("authPage.form.fieldRequired", { defaultValue: "This field is required." });

  return (
    <EditModalShell
      formId="auth-ms-form"
      icon={<MicrosoftLogo size={20} />}
      title={t("authPage.editProvider", { provider: t("authPage.microsoft.title") })}
      subtitle={t("authPage.microsoft.subtitle")}
      redirectUri={redirectUri}
      onRedirectUriChange={setRedirectUri}
      redirectUriDefault={data.redirect_uri_default}
      dirty={dirty}
      canSave={requiredSatisfied}
      requiredWarning={!requiredSatisfied ? t("authPage.requiredWarning") : null}
      onClose={onClose}
      onSave={onSave}
      saving={put.isPending}
      serverError={serverError}
      enableToggle={
        <SwitchField
          id="auth-ms-enabled"
          checked={enabled}
          onChange={setEnabled}
          label={t("authPage.enableToggle")}
          description={t("authPage.enableHint")}
        />
      }
    >
      <Field
        label={t("authPage.fields.entraTenantId")}
        required
        help={t("authPage.fields.entraTenantHint")}
        error={touched.tenant && !entraTenant.trim() ? requiredMsg : undefined}
        htmlFor="auth-ms-tenant"
      >
        <input
          id="auth-ms-tenant"
          className="input mono"
          type="text"
          value={entraTenant}
          onChange={(e) => setEntraTenant(e.target.value)}
          onBlur={() => touch("tenant")}
          autoComplete="off"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
      </Field>
      <Field
        label={t("authPage.fields.clientId")}
        required
        help={t("authPage.fields.clientIdHint")}
        error={touched.client && !clientId.trim() ? requiredMsg : undefined}
        htmlFor="auth-ms-client"
      >
        <input
          id="auth-ms-client"
          className="input mono"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          onBlur={() => touch("client")}
          autoComplete="off"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
      </Field>
      <Field
        label={t("authPage.fields.clientSecret")}
        required
        help={
          data.has_secret
            ? t("authPage.fields.clientSecretStored")
            : t("authPage.fields.clientSecretRequired")
        }
        error={touched.secret && !clientSecret && !data.has_secret ? requiredMsg : undefined}
        htmlFor="auth-ms-secret"
        span={2}
      >
        <input
          id="auth-ms-secret"
          className="input"
          type="password"
          value={clientSecret}
          placeholder={data.has_secret ? storedSecretPlaceholder(t) : ""}
          onChange={(e) => setClientSecret(e.target.value)}
          onBlur={() => touch("secret")}
          autoComplete="new-password"
        />
      </Field>
    </EditModalShell>
  );
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function GoogleCard({ onSaved }: { onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const cfg = useMyGoogleConfig();
  const del = useDeleteMyGoogleConfig();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const d = cfg.data ?? null;
  const configured = !!d && (!!d.client_id || d.has_secret);
  const providerName = t("authPage.google.title");

  return (
    <>
      <ProviderSummaryCard
        logo={<GoogleLogo size={20} />}
        name={providerName}
        subtitle={t("authPage.google.subtitle")}
        loading={cfg.isLoading}
        loadError={cfg.error ? t("authPage.loadFailed") : null}
        onRetry={() => void cfg.refetch()}
        enabled={d?.enabled ?? false}
        configured={configured}
        updatedAt={d?.updated_at ?? null}
        onEdit={() => setEditing(true)}
        onRemove={configured ? () => setConfirming(true) : undefined}
        tiles={[
          {
            icon: "user",
            label: t("authPage.google.clientId"),
            value: <Mono value={d?.client_id} />,
          },
          {
            icon: "eyeOff",
            label: t("authPage.fields.clientSecret"),
            value: <SecretValue has={d?.has_secret ?? false} />,
          },
          {
            icon: "globe",
            label: t("authPage.google.allowedDomain"),
            value: d?.allowed_domain ? (
              <Mono value={d.allowed_domain} />
            ) : (
              <span className="text-dim">{t("authPage.anyDomain")}</span>
            ),
          },
          {
            icon: "globe",
            label: t("authPage.redirectUriLabel"),
            value: <RedirectUriValue value={d?.redirect_uri} />,
            full: true,
          },
        ]}
      />
      {editing && d && (
        <GoogleEditModal
          data={d}
          onClose={() => setEditing(false)}
          onSaved={(msg) => {
            setEditing(false);
            onSaved(msg);
          }}
        />
      )}
      {confirming && (
        <ConfirmRemoveModal
          provider={providerName}
          pending={del.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await del.mutateAsync();
            setConfirming(false);
            onSaved(t("authPage.removedProvider", { provider: providerName }));
          }}
        />
      )}
    </>
  );
}

function GoogleEditModal({
  data,
  onClose,
  onSaved,
}: {
  data: GoogleOidcConfigResponse;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const put = usePutMyGoogleConfig();

  const [clientId, setClientId] = useState(data.client_id);
  const [clientSecret, setClientSecret] = useState("");
  const [allowedDomain, setAllowedDomain] = useState(data.allowed_domain);
  const [enabled, setEnabled] = useState(data.enabled);
  const [redirectUri, setRedirectUri] = useState(data.redirect_uri);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, touch] = useTouched();

  const onSave = async () => {
    setServerError(null);
    try {
      const payload: { [k: string]: unknown } = {
        client_id: clientId.trim(),
        allowed_domain: allowedDomain.trim(),
        enabled,
        redirect_uri: redirectUri.trim(),
      };
      if (clientSecret.length > 0) payload.client_secret = clientSecret;
      await put.mutateAsync(payload);
      onSaved(t("authPage.savedProvider", { provider: t("authPage.google.title") }));
    } catch (err) {
      setServerError(readServerError(err, t));
    }
  };

  const requiredSatisfied =
    !!clientId.trim() && (clientSecret.length > 0 || data.has_secret);
  const dirty =
    clientId !== data.client_id ||
    clientSecret !== "" ||
    allowedDomain !== data.allowed_domain ||
    enabled !== data.enabled ||
    redirectUri !== data.redirect_uri;
  const requiredMsg = t("authPage.form.fieldRequired", { defaultValue: "This field is required." });

  return (
    <EditModalShell
      formId="auth-google-form"
      icon={<GoogleLogo size={20} />}
      title={t("authPage.editProvider", { provider: t("authPage.google.title") })}
      subtitle={t("authPage.google.subtitle")}
      redirectUri={redirectUri}
      onRedirectUriChange={setRedirectUri}
      redirectUriDefault={data.redirect_uri_default}
      dirty={dirty}
      canSave={requiredSatisfied}
      requiredWarning={!requiredSatisfied ? t("authPage.requiredWarning") : null}
      onClose={onClose}
      onSave={onSave}
      saving={put.isPending}
      serverError={serverError}
      enableToggle={
        <SwitchField
          id="auth-google-enabled"
          checked={enabled}
          onChange={setEnabled}
          label={t("authPage.google.enableToggle")}
          description={t("authPage.google.enableHint")}
        />
      }
    >
      <Field
        label={t("authPage.google.clientId")}
        required
        help={t("authPage.google.clientIdHint")}
        error={touched.client && !clientId.trim() ? requiredMsg : undefined}
        htmlFor="auth-google-client"
        span={2}
      >
        <input
          id="auth-google-client"
          className="input mono"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          onBlur={() => touch("client")}
          autoComplete="off"
          placeholder="123456789-abc.apps.googleusercontent.com"
        />
      </Field>
      <Field
        label={t("authPage.fields.clientSecret")}
        required
        help={
          data.has_secret
            ? t("authPage.fields.clientSecretStored")
            : t("authPage.fields.clientSecretRequired")
        }
        error={touched.secret && !clientSecret && !data.has_secret ? requiredMsg : undefined}
        htmlFor="auth-google-secret"
      >
        <input
          id="auth-google-secret"
          className="input"
          type="password"
          value={clientSecret}
          placeholder={data.has_secret ? storedSecretPlaceholder(t) : ""}
          onChange={(e) => setClientSecret(e.target.value)}
          onBlur={() => touch("secret")}
          autoComplete="new-password"
        />
      </Field>
      <Field
        label={t("authPage.google.allowedDomain")}
        help={t("authPage.google.allowedDomainHint")}
        htmlFor="auth-google-domain"
      >
        <input
          id="auth-google-domain"
          className="input"
          type="text"
          value={allowedDomain}
          onChange={(e) => setAllowedDomain(e.target.value)}
          autoComplete="off"
          placeholder={t("authPage.google.allowedDomainPlaceholder")}
        />
      </Field>
    </EditModalShell>
  );
}

// ---------------------------------------------------------------------------
// Provider summary card (read-only view)
// ---------------------------------------------------------------------------

interface Tile {
  icon: IconName;
  label: string;
  value: React.ReactNode;
  full?: boolean;
}

function ProviderSummaryCard({
  logo,
  name,
  subtitle,
  loading,
  loadError,
  onRetry,
  enabled,
  configured,
  updatedAt,
  onEdit,
  onRemove,
  tiles,
}: {
  logo: React.ReactNode;
  name: string;
  subtitle: string;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  enabled: boolean;
  configured: boolean;
  updatedAt: string | null;
  onEdit: () => void;
  onRemove?: (() => void) | undefined;
  tiles: Tile[];
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard
      icon={logo}
      title={
        <span className="st-inline">
          {name}
          {!loading && !loadError && (
            <SoftPill tone={enabled ? "success" : "neutral"}>
              {enabled ? t("authPage.statusEnabled") : t("authPage.statusDisabled")}
            </SoftPill>
          )}
        </span>
      }
      description={
        updatedAt
          ? t("authPage.updatedAt", { when: new Date(updatedAt).toLocaleString() })
          : subtitle
      }
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onEdit}
            disabled={loading || !!loadError}
          >
            <Icon name={configured ? "edit" : "plus"} size={13} />
            {configured ? t("authPage.edit") : t("authPage.configure")}
          </button>
          {onRemove && (
            <button
              type="button"
              className="btn btn-sm btn-ghost st-danger"
              onClick={onRemove}
              aria-label={t("authPage.remove")}
            >
              <Icon name="trash" size={13} />
              {t("authPage.remove")}
            </button>
          )}
        </>
      }
    >
      {loading ? (
        <SkeletonLines lines={4} />
      ) : loadError ? (
        <LoadErrorPanel title={loadError} onRetry={onRetry} />
      ) : configured ? (
        <Facts>
          {tiles.map((tile) => (
            <Fact
              key={tile.label}
              icon={<Icon name={tile.icon} size={12} />}
              label={tile.label}
              {...(tile.full ? { full: true } : {})}
            >
              {tile.value}
            </Fact>
          ))}
        </Facts>
      ) : (
        <EmptyPanel
          tone="accent"
          icon={<Icon name="shield" size={28} />}
          title={t("settingsUi.auth.notConfiguredTitle", {
            defaultValue: "Connect {{provider}}",
            provider: name,
          })}
          body={t("authPage.emptyState", { provider: name })}
          actions={
            <button type="button" className="btn" onClick={onEdit}>
              <Icon name="plus" size={13} />
              {t("authPage.configure")}
            </button>
          }
        />
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Edit modal shell
// ---------------------------------------------------------------------------

function EditModalShell({
  formId,
  icon,
  title,
  subtitle,
  redirectUri,
  onRedirectUriChange,
  redirectUriDefault,
  dirty,
  canSave,
  requiredWarning,
  onClose,
  onSave,
  saving,
  serverError,
  enableToggle,
  children,
}: {
  formId: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  redirectUri: string;
  onRedirectUriChange: (v: string) => void;
  redirectUriDefault: string;
  dirty: boolean;
  canSave: boolean;
  requiredWarning: string | null;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  serverError: string | null;
  enableToggle: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [discardOpen, setDiscardOpen] = useState(false);
  // Closing with unsaved edits prompts a discard confirmation; a clean
  // form closes immediately.
  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };
  return (
    <>
      <SettingsFormModal
        icon={icon}
        title={title}
        subtitle={subtitle}
        onClose={requestClose}
        onSubmit={() => {
          if (!saving && canSave) void onSave();
        }}
        size="lg"
        titleId={`${formId}-title`}
        footer={
          <FormFooter
            onCancel={requestClose}
            submitLabel={t("authPage.saveChanges")}
            submittingLabel={t("authPage.saving")}
            submitting={saving}
            canSubmit={canSave}
          />
        }
      >
        {serverError && <FormNotice tone="danger">{serverError}</FormNotice>}
        {requiredWarning && <FormNotice tone="warning">{requiredWarning}</FormNotice>}

        <FormSection
          step={1}
          title={t("authPage.form.credentialsTitle", { defaultValue: "App credentials" })}
          description={t("authPage.form.credentialsDesc", {
            defaultValue: "Copy these from the app registration in the provider's console.",
          })}
        >
          {children}
        </FormSection>

        <FormSection
          step={2}
          title={t("authPage.form.redirectTitle", { defaultValue: "Redirect URI" })}
          description={t("authPage.form.redirectDesc", {
            defaultValue: "Register this exact URL with the provider so it can send users back here.",
          })}
          columns={1}
        >
          <Field
            label={t("authPage.redirectUriLabel")}
            htmlFor={`${formId}-redirect`}
            help={t("authPage.redirectUriEditHint")}
          >
            <div className="au-redirect-row">
              <input
                id={`${formId}-redirect`}
                className="input mono"
                type="text"
                value={redirectUri}
                onChange={(e) => onRedirectUriChange(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <CopyButton value={redirectUri} />
              {redirectUri.trim() !== redirectUriDefault && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onRedirectUriChange(redirectUriDefault)}
                >
                  {t("authPage.resetToDefault")}
                </button>
              )}
            </div>
          </Field>
        </FormSection>

        <FormSection
          step={3}
          title={t("authPage.form.statusTitle", { defaultValue: "Sign-in status" })}
          description={t("authPage.form.statusDesc", {
            defaultValue: "Turn the button on the login page on or off.",
          })}
          columns={1}
        >
          {enableToggle}
        </FormSection>
      </SettingsFormModal>

      {discardOpen && (
        <ConfirmModal
          icon={<Icon name="info" size={18} />}
          title={t("authPage.discardTitle")}
          subtitle={t("authPage.discardBody")}
          confirmLabel={t("authPage.discard")}
          onConfirm={() => {
            setDiscardOpen(false);
            onClose();
          }}
          onClose={() => setDiscardOpen(false)}
          titleId={`${formId}-discard-title`}
        >
          <p className="st-confirm-text">
            {t("authPage.form.discardHint", {
              defaultValue: "Choose Cancel to keep editing.",
            })}
          </p>
        </ConfirmModal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Confirm-remove modal
// ---------------------------------------------------------------------------

function ConfirmRemoveModal({
  provider,
  pending,
  onCancel,
  onConfirm,
}: {
  provider: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmModal
      title={t("authPage.removeTitle", { provider })}
      subtitle={t("authPage.form.removeSubtitle", {
        defaultValue: "Users will no longer see this sign-in option.",
      })}
      confirmLabel={t("authPage.removeConfirm")}
      busy={pending}
      onConfirm={() => void onConfirm()}
      onClose={onCancel}
      titleId="auth-remove-title"
    >
      <p className="st-confirm-text">{t("authPage.removeBody", { provider })}</p>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** Tracks which fields lost focus, so required errors only show after
 *  the operator has visited the field. */
function useTouched(): [Record<string, boolean>, (k: string) => void] {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  return [touched, (k) => setTouched((p) => (p[k] ? p : { ...p, [k]: true }))];
}

function storedSecretPlaceholder(t: ReturnType<typeof useTranslation>["t"]): string {
  return t("authPage.form.secretStoredPlaceholder", { defaultValue: "•••••• stored — type to replace" });
}

function Mono({ value }: { value?: string | null | undefined }) {
  const { t } = useTranslation();
  if (!value) {
    return <span className="text-dim">{t("authPage.notConfigured")}</span>;
  }
  return (
    <code className="mono text-sm" style={{ wordBreak: "break-all" }}>
      {value}
    </code>
  );
}

function RedirectUriValue({ value }: { value?: string | null | undefined }) {
  if (!value) return <Mono value={value} />;
  return (
    <span className="st-inline">
      <Mono value={value} />
      <CopyButton value={value} />
    </span>
  );
}

function SecretValue({ has }: { has: boolean }) {
  const { t } = useTranslation();
  if (!has) {
    return <span className="text-dim">{t("authPage.notSet")}</span>;
  }
  return (
    <span className="st-inline">
      <span aria-hidden style={{ letterSpacing: 2 }}>
        ••••••
      </span>
      <span className="text-xs text-dim">{t("authPage.stored")}</span>
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={onCopy} style={{ whiteSpace: "nowrap" }}>
      <Icon name={copied ? "check" : "clipboard"} size={13} />
      {copied ? t("authPage.copied") : t("authPage.copy")}
    </button>
  );
}

function readServerError(
  err: unknown,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | null;
    return typeof body?.detail === "string"
      ? body.detail
      : t("authPage.errSaveStatus", { status: err.status });
  }
  return t("authPage.errSave");
}

// Brand marks — local copies of the login-page SVGs (self-contained,
// official press-kit paths).
function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.1l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.1z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C40.9 35.3 44 30 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function MicrosoftLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}
