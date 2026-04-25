// Admin-only "Settings → Authentication" page (P6).
// Lets the tenant Admin paste their Entra tenant id, client id, client
// secret, and toggle OIDC on/off. The secret is write-only — when one
// is already stored, the form shows ``***`` as a placeholder and the
// PUT call sends an empty ``client_secret`` to leave it untouched.
//
// Save → backend pings Entra's discovery URL before persisting and
// refuses if it fails (mirrors the RTSP "test connection" pattern
// from pilot P7).

import { useEffect, useState } from "react";

import { ApiError } from "../api/client";
import { useMyOidcConfig, usePutMyOidcConfig } from "./hooks";

export function AuthenticationPage() {
  const cfg = useMyOidcConfig();
  const put = usePutMyOidcConfig();

  const [entraTenant, setEntraTenant] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Hydrate local form state when the query resolves. We never
  // pre-fill the secret — the user opts in to rotating it explicitly.
  useEffect(() => {
    if (cfg.data) {
      setEntraTenant(cfg.data.entra_tenant_id);
      setClientId(cfg.data.client_id);
      setEnabled(cfg.data.enabled);
      setClientSecret(""); // never auto-fill
    }
  }, [cfg.data]);

  if (cfg.isLoading) return <p>Loading authentication settings…</p>;
  if (cfg.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load authentication settings.
      </p>
    );
  if (!cfg.data) return <p>Sign in to manage authentication settings.</p>;

  const onSave = async () => {
    setServerError(null);
    try {
      const payload: { [k: string]: unknown } = {
        entra_tenant_id: entraTenant.trim(),
        client_id: clientId.trim(),
        enabled,
      };
      // Only include the secret when the operator has typed one.
      // Empty string means "leave alone" per the API contract.
      if (clientSecret.length > 0) {
        payload.client_secret = clientSecret;
      }
      await put.mutateAsync(payload);
      setClientSecret(""); // clear the in-memory copy after save
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setServerError(
          typeof body?.detail === "string"
            ? body.detail
            : `Save failed (${err.status}).`,
        );
      } else {
        setServerError("Save failed.");
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Authentication
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Sign in with Microsoft (Entra ID OIDC). Users must already exist in
          Hadir — Hadir does not auto-provision from claims, and roles are
          managed only inside Hadir (BRD FR-AUTH-006).
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 600,
        }}
      >
        <Field
          label="Entra tenant ID"
          hint="GUID or verified domain. From Microsoft Entra admin centre → Identity → Overview."
        >
          <input
            type="text"
            value={entraTenant}
            onChange={(e) => setEntraTenant(e.target.value)}
            autoComplete="off"
            style={inputStyle}
          />
        </Field>
        <Field label="Client ID" hint="The application id of your Entra app registration.">
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            style={inputStyle}
          />
        </Field>
        <Field
          label="Client secret"
          hint={
            cfg.data.has_secret
              ? "Stored. Type a new secret only to rotate it."
              : "Required to enable OIDC."
          }
        >
          <input
            type="password"
            value={clientSecret}
            placeholder={cfg.data.has_secret ? "***" : ""}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
            style={inputStyle}
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enable OIDC for this tenant</span>
        </label>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0 }}>
          When enabled, the login page shows &ldquo;Sign in with Microsoft&rdquo; as
          the primary action. Local password sign-in remains as a break-glass
          fallback labelled &ldquo;Use local account&rdquo;.
        </p>

        {serverError && (
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
            {serverError}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="submit"
            disabled={put.isPending}
            style={{
              background: "var(--accent)",
              color: "white",
              border: "none",
              padding: "8px 14px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {put.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
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
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{hint}</span>
      )}
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
