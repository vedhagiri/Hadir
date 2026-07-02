// Admin-only "Settings → Authentication" page (P6 + Google Sign-In).
//
// Two single-sign-on providers — Microsoft (Entra ID) and Google —
// each rendered as a summary card (brand tile + status pill + a
// read-only details grid) with an "Edit" button that opens a config
// modal. Mirrors the Settings → Email page format (provider cards +
// config tiles + edit modal) so the two settings surfaces read the
// same way.
//
// Both client secrets are write-only: a stored secret shows "••••••
// stored" in the summary and the modal leaves it untouched unless the
// operator types a new value. Enabling a provider pings its OIDC
// discovery endpoint before persisting. Save is the black
// ``btn-primary`` per the design red line.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import type { IconName } from "../shell/Icon";
import { SettingsTabs } from "../settings/SettingsTabs";
import {
  useMyGoogleConfig,
  useMyOidcConfig,
  usePutMyGoogleConfig,
  usePutMyOidcConfig,
} from "./hooks";
import type { GoogleOidcConfigResponse, OidcConfigResponse } from "./types";

export function AuthenticationPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<string | null>(null);

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
          {t("authPage.title")}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("authPage.subtitle")}
        </p>
      </header>

      {info && (
        <div
          style={{
            background: "color-mix(in srgb, #0a8a52 8%, var(--bg))",
            border: "1px solid var(--success-border)",
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--success-text)",
            fontWeight: 500,
          }}
        >
          <Icon name="check" size={14} />
          {info}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "var(--text-secondary)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            paddingInlineStart: 2,
            marginBottom: 6,
          }}
        >
          {t("authPage.providersLabel")}
        </div>

        <MicrosoftCard onSaved={setInfo} />
        <GoogleCard onSaved={setInfo} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Microsoft (Entra ID)
// ---------------------------------------------------------------------------

function MicrosoftCard({ onSaved }: { onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const cfg = useMyOidcConfig();
  const [editing, setEditing] = useState(false);

  const d = cfg.data ?? null;
  const configured = !!d && (!!d.client_id || d.has_secret);

  return (
    <>
      <ProviderSummaryCard
        logo={<MicrosoftLogo size={20} />}
        name={t("authPage.microsoft.title")}
        subtitle={t("authPage.microsoft.subtitle")}
        loading={cfg.isLoading}
        loadError={cfg.error ? t("authPage.loadFailed") : null}
        enabled={d?.enabled ?? false}
        configured={configured}
        updatedAt={d?.updated_at ?? null}
        onEdit={() => setEditing(true)}
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
            value: <Mono value={d?.redirect_uri} small />,
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
  const [serverError, setServerError] = useState<string | null>(null);

  const onSave = async () => {
    setServerError(null);
    try {
      const payload: { [k: string]: unknown } = {
        entra_tenant_id: entraTenant.trim(),
        client_id: clientId.trim(),
        enabled,
      };
      if (clientSecret.length > 0) payload.client_secret = clientSecret;
      await put.mutateAsync(payload);
      onSaved(t("authPage.savedProvider", { provider: t("authPage.microsoft.title") }));
    } catch (err) {
      setServerError(readServerError(err, t));
    }
  };

  return (
    <EditModalShell
      logo={<MicrosoftLogo size={20} />}
      title={t("authPage.editProvider", { provider: t("authPage.microsoft.title") })}
      redirectUri={data.redirect_uri}
      onClose={onClose}
      onSave={onSave}
      saving={put.isPending}
      serverError={serverError}
    >
      <Field
        label={t("authPage.fields.entraTenantId")}
        hint={t("authPage.fields.entraTenantHint")}
      >
        <input
          className="input"
          type="text"
          value={entraTenant}
          onChange={(e) => setEntraTenant(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label={t("authPage.fields.clientId")} hint={t("authPage.fields.clientIdHint")}>
        <input
          className="input"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field
        label={t("authPage.fields.clientSecret")}
        hint={
          data.has_secret
            ? t("authPage.fields.clientSecretStored")
            : t("authPage.fields.clientSecretRequired")
        }
      >
        <input
          className="input"
          type="password"
          value={clientSecret}
          placeholder={data.has_secret ? "••••••••" : ""}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <ToggleRow
        checked={enabled}
        onChange={setEnabled}
        label={t("authPage.enableToggle")}
        hint={t("authPage.enableHint")}
      />
    </EditModalShell>
  );
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function GoogleCard({ onSaved }: { onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const cfg = useMyGoogleConfig();
  const [editing, setEditing] = useState(false);

  const d = cfg.data ?? null;
  const configured = !!d && (!!d.client_id || d.has_secret);

  return (
    <>
      <ProviderSummaryCard
        logo={<GoogleLogo size={20} />}
        name={t("authPage.google.title")}
        subtitle={t("authPage.google.subtitle")}
        loading={cfg.isLoading}
        loadError={cfg.error ? t("authPage.loadFailed") : null}
        enabled={d?.enabled ?? false}
        configured={configured}
        updatedAt={d?.updated_at ?? null}
        onEdit={() => setEditing(true)}
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
              <span style={{ color: "var(--text-tertiary)" }}>
                {t("authPage.anyDomain")}
              </span>
            ),
          },
          {
            icon: "globe",
            label: t("authPage.redirectUriLabel"),
            value: <Mono value={d?.redirect_uri} small />,
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
  const [serverError, setServerError] = useState<string | null>(null);

  const onSave = async () => {
    setServerError(null);
    try {
      const payload: { [k: string]: unknown } = {
        client_id: clientId.trim(),
        allowed_domain: allowedDomain.trim(),
        enabled,
      };
      if (clientSecret.length > 0) payload.client_secret = clientSecret;
      await put.mutateAsync(payload);
      onSaved(t("authPage.savedProvider", { provider: t("authPage.google.title") }));
    } catch (err) {
      setServerError(readServerError(err, t));
    }
  };

  return (
    <EditModalShell
      logo={<GoogleLogo size={20} />}
      title={t("authPage.editProvider", { provider: t("authPage.google.title") })}
      redirectUri={data.redirect_uri}
      onClose={onClose}
      onSave={onSave}
      saving={put.isPending}
      serverError={serverError}
    >
      <Field label={t("authPage.google.clientId")} hint={t("authPage.google.clientIdHint")}>
        <input
          className="input"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field
        label={t("authPage.fields.clientSecret")}
        hint={
          data.has_secret
            ? t("authPage.fields.clientSecretStored")
            : t("authPage.fields.clientSecretRequired")
        }
      >
        <input
          className="input"
          type="password"
          value={clientSecret}
          placeholder={data.has_secret ? "••••••••" : ""}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field
        label={t("authPage.google.allowedDomain")}
        hint={t("authPage.google.allowedDomainHint")}
      >
        <input
          className="input"
          type="text"
          value={allowedDomain}
          onChange={(e) => setAllowedDomain(e.target.value)}
          autoComplete="off"
          placeholder={t("authPage.google.allowedDomainPlaceholder")}
        />
      </Field>
      <ToggleRow
        checked={enabled}
        onChange={setEnabled}
        label={t("authPage.google.enableToggle")}
        hint={t("authPage.google.enableHint")}
      />
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
}

function ProviderSummaryCard({
  logo,
  name,
  subtitle,
  loading,
  loadError,
  enabled,
  configured,
  updatedAt,
  onEdit,
  tiles,
}: {
  logo: React.ReactNode;
  name: string;
  subtitle: string;
  loading: boolean;
  loadError: string | null;
  enabled: boolean;
  configured: boolean;
  updatedAt: string | null;
  onEdit: () => void;
  tiles: Tile[];
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        borderRadius: 14,
        border: `1.5px solid ${
          enabled
            ? "color-mix(in srgb, var(--accent, #0b6e4f) 30%, var(--border))"
            : "var(--border)"
        }`,
        background: enabled
          ? "color-mix(in srgb, var(--accent, #0b6e4f) 3%, var(--bg))"
          : "var(--bg)",
        overflow: "hidden",
        marginBottom: 10,
      }}
    >
      {/* Header */}
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "var(--bg-sunken)",
              border: "1px solid var(--border)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {logo}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
              {name}
              {!loading && !loadError && <StatusPill enabled={enabled} />}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-secondary)",
                marginTop: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {loadError
                ? loadError
                : updatedAt
                  ? t("authPage.updatedAt", {
                      when: new Date(updatedAt).toLocaleString(),
                    })
                  : subtitle}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onEdit}
          disabled={loading || !!loadError}
          style={{ flexShrink: 0 }}
        >
          <Icon name={configured ? "edit" : "plus"} size={13} />
          {configured ? t("authPage.edit") : t("authPage.configure")}
        </button>
      </div>

      {/* Detail tiles */}
      {loading ? (
        <div style={{ padding: "18px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>
          {t("authPage.loading")}
        </div>
      ) : loadError ? null : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 1,
            background: "var(--border)",
          }}
        >
          {tiles.map((tile) => (
            <ConfigTile key={tile.label} icon={tile.icon} label={tile.label}>
              {tile.value}
            </ConfigTile>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit modal shell
// ---------------------------------------------------------------------------

function EditModalShell({
  logo,
  title,
  redirectUri,
  onClose,
  onSave,
  saving,
  serverError,
  children,
}: {
  logo: React.ReactNode;
  title: string;
  redirectUri: string;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  serverError: string | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onClose}>
      <form
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 560,
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
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--bg-sunken)",
              border: "1px solid var(--border)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {logo}
          </span>
          <div style={{ flex: 1, fontWeight: 700, fontSize: 14.5 }}>{title}</div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("authPage.close")}
            onClick={onClose}
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 13,
          }}
        >
          {children}

          <div className="field" style={{ marginTop: 2 }}>
            <span className="field-label">{t("authPage.redirectUriLabel")}</span>
            <CopyField value={redirectUri} />
            <span className="field-help">{t("authPage.redirectUriHint")}</span>
          </div>

          {serverError && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                border: "1px solid var(--danger-border)",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
              }}
            >
              {serverError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-elev)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            {t("authPage.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t("authPage.saving") : t("authPage.saveChanges")}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function ConfigTile({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "14px 18px", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <span style={{ color: "var(--accent, #0b6e4f)", display: "flex" }}>
          <Icon name={icon} size={13} />
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, minHeight: 20 }}>{children}</div>
    </div>
  );
}

function StatusPill({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "2px 9px",
        borderRadius: 999,
        border: `1px solid ${enabled ? "var(--success-border)" : "var(--border)"}`,
        background: enabled ? "var(--success-soft)" : "var(--bg-sunken)",
        color: enabled ? "var(--success-text)" : "var(--text-tertiary)",
        whiteSpace: "nowrap",
        textTransform: "uppercase",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: enabled ? "var(--success-text)" : "var(--text-tertiary)",
        }}
      />
      {enabled ? t("authPage.statusEnabled") : t("authPage.statusDisabled")}
    </span>
  );
}

function Mono({ value, small }: { value?: string | null | undefined; small?: boolean }) {
  const { t } = useTranslation();
  if (!value) {
    return (
      <span style={{ color: "var(--text-tertiary)" }}>
        {t("authPage.notConfigured")}
      </span>
    );
  }
  return (
    <code
      className="mono"
      style={{ fontSize: small ? 11 : 12, wordBreak: "break-all", color: "var(--text)" }}
    >
      {value}
    </code>
  );
}

function SecretValue({ has }: { has: boolean }) {
  const { t } = useTranslation();
  if (!has) {
    return <span style={{ color: "var(--text-tertiary)" }}>{t("authPage.notSet")}</span>;
  }
  return (
    <span style={{ letterSpacing: 2 }}>
      ••••••
      <span
        style={{
          marginInlineStart: 6,
          fontSize: 11,
          color: "var(--text-secondary)",
          letterSpacing: 0,
        }}
      >
        {t("authPage.stored")}
      </span>
    </span>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="toggle-row" style={{ alignItems: "center", cursor: "default" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div className="field-help" style={{ marginTop: 3 }}>
          {hint}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          position: "relative",
          width: 40,
          height: 22,
          flexShrink: 0,
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          padding: 0,
          transition: "background 120ms ease",
          background: checked ? "var(--accent)" : "var(--border-strong)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            insetInlineStart: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "#fff",
            transition: "inset-inline-start 120ms ease",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
          }}
        />
      </button>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
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
    <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <input
        className="input mono"
        type="text"
        value={value}
        readOnly
        onFocusCapture={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
        style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)" }}
      />
      <button
        type="button"
        className="btn btn-sm"
        onClick={onCopy}
        style={{ whiteSpace: "nowrap" }}
      >
        <Icon name={copied ? "check" : "clipboard"} size={13} />
        {copied ? t("authPage.copied") : t("authPage.copy")}
      </button>
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
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-help">{hint}</span>}
    </label>
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
