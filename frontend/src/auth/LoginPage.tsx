// Email + password login (P3) + Entra ID OIDC (P6).
//
// When the active tenant has OIDC enabled, "Sign in with Microsoft" is
// the primary CTA and the local password form collapses behind a
// "Use local account" link — break-glass only. When OIDC is disabled
// or the tenant has no config, the local form is the primary surface.
//
// Tenant resolution: subdomain-based routing (omran.maugood.example.com)
// will land here in production. For local dev the tenant slug comes
// from a ?tenant=… query param the user types in (or the picker below).

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import mtsLogo from "../assets/mts_logo.png";
import { useOidcStatus } from "../auth-oidc/hooks";
import { Icon } from "../shell/Icon";
import { useLogin, useMe } from "./AuthProvider";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  tenant_slug: z
    .string()
    .max(63)
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, {
      message: "Lowercase letters, digits, underscores; start with a letter",
    })
    .optional()
    .or(z.literal("")),
});

type LoginValues = z.infer<typeof loginSchema>;

const zodResolver: Resolver<LoginValues> = async (values) => {
  const parsed = loginSchema.safeParse(values);
  if (parsed.success) {
    return { values: parsed.data, errors: {} };
  }
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    if (!errors[path]) {
      errors[path] = { type: issue.code, message: issue.message };
    }
  }
  return { values: {} as LoginValues, errors };
};

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useLogin();
  const { data: me, isLoading: meLoading } = useMe();
  const [searchParams] = useSearchParams();

  // Tenant slug — pulled from ?tenant=… or the picker we expose
  // below. We persist whatever the user typed for the duration of the
  // page so a failed login doesn't ask twice.
  const [tenantSlug, setTenantSlug] = useState<string>(
    searchParams.get("tenant") ?? "",
  );
  const [showLocal, setShowLocal] = useState<boolean>(false);

  const oidcStatus = useOidcStatus(tenantSlug || null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setValue,
  } = useForm<LoginValues>({
    resolver: zodResolver,
    defaultValues: { email: "", password: "", tenant_slug: tenantSlug },
  });

  useEffect(() => {
    setValue("tenant_slug", tenantSlug);
  }, [tenantSlug, setValue]);

  if (meLoading) return null;
  if (me != null) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      const payload: { email: string; password: string; tenant_slug?: string } = {
        email: values.email,
        password: values.password,
      };
      if (values.tenant_slug) payload.tenant_slug = values.tenant_slug;
      await login.mutateAsync(payload);
      navigate("/", { replace: true });
    } catch {
      // surfaces via login.error
    }
  });

  const serverError = (() => {
    const err = login.error;
    if (!err) return null;
    if (err instanceof ApiError) {
      if (err.status === 401) return t("login.wrongCredentials");
      if (err.status === 429) return t("login.rateLimited");
      if (err.status === 403)
        return "Tenant is suspended. Contact your administrator.";
      return t("common.error");
    }
    return t("common.error");
  })();

  // Decide which surface to render. Order:
  //   1. No tenant slug → ask for one (the picker)
  //   2. Tenant has OIDC enabled → primary "Sign in with Microsoft"
  //   3. Otherwise → local email + password form
  const showPicker = !tenantSlug;
  const oidcEnabled = !!oidcStatus.data?.enabled;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        color: "var(--text)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow)",
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Header tenantSlug={tenantSlug || null} />

        {showPicker ? (
          <TenantPicker onPick={setTenantSlug} />
        ) : oidcEnabled && !showLocal ? (
          <OidcPanel
            tenantSlug={tenantSlug}
            onUseLocal={() => setShowLocal(true)}
          />
        ) : (
          <LocalLoginForm
            register={register}
            errors={errors}
            isSubmitting={isSubmitting}
            isPending={login.isPending}
            onSubmit={onSubmit}
            tenantSlug={tenantSlug}
            onChangeTenant={() => {
              setTenantSlug("");
              setShowLocal(false);
            }}
            oidcEnabled={oidcEnabled}
            onUseOidc={() => setShowLocal(false)}
            serverError={serverError}
          />
        )}
      </div>
    </main>
  );
}

function Header({ tenantSlug }: { tenantSlug: string | null }) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <img
          src={mtsLogo}
          alt="Muscat Tech Solutions"
          style={{ height: 32, width: "auto", objectFit: "contain" }}
        />
        {tenantSlug && (
          <span
            style={{
              marginInlineStart: "auto",
              fontSize: 11,
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {tenantSlug}
          </span>
        )}
      </div>
      <H1Title />
    </>
  );
}

function H1Title() {
  const { t } = useTranslation();
  return (
    <h1
      style={{
        fontFamily: "var(--font-display)",
        fontSize: 32,
        margin: 0,
        fontWeight: 400,
        letterSpacing: "-0.01em",
      }}
    >
      {t("login.title")}
    </h1>
  );
}

function TenantPicker({ onPick }: { onPick: (slug: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const slug = value.trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(slug)) {
      setError("Lowercase letters, digits, underscores; start with a letter.");
      return;
    }
    onPick(slug);
  };
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
        {t("login.subtitle")}
      </p>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.tenantSlugLabel")}</span>
        <input
          type="text"
          autoFocus
          autoComplete="off"
          placeholder={t("login.tenantSlugPlaceholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={inputStyle}
        />
        {error && (
          <span style={{ color: "var(--danger-text)", fontSize: 11.5 }}>
            {error}
          </span>
        )}
      </label>
      <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }}>
        {t("login.submit")}
      </button>
    </form>
  );
}

function OidcPanel({
  tenantSlug,
  onUseLocal,
}: {
  tenantSlug: string;
  onUseLocal: () => void;
}) {
  const { t } = useTranslation();
  const oidcUrl = `/api/auth/oidc/login?tenant=${encodeURIComponent(tenantSlug)}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
        {t("login.subtitle")}
      </p>
      <a
        href={oidcUrl}
        style={{
          background: "var(--accent)",
          color: "white",
          padding: "10px 14px",
          borderRadius: "var(--radius-sm)",
          textAlign: "center",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {t("login.oidcButton")}
      </a>
      <button
        type="button"
        onClick={onUseLocal}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontSize: 12.5,
          textDecoration: "underline",
        }}
      >
        {t("login.oidcOrLocal")}
      </button>
    </div>
  );
}

interface LocalFormProps {
  register: ReturnType<typeof useForm<LoginValues>>["register"];
  errors: ReturnType<typeof useForm<LoginValues>>["formState"]["errors"];
  isSubmitting: boolean;
  isPending: boolean;
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  tenantSlug: string;
  onChangeTenant: () => void;
  oidcEnabled: boolean;
  onUseOidc: () => void;
  serverError: string | null;
}

function LocalLoginForm({
  register,
  errors,
  isSubmitting,
  isPending,
  onSubmit,
  tenantSlug,
  onChangeTenant,
  oidcEnabled,
  onUseOidc,
  serverError,
}: LocalFormProps) {
  const { t } = useTranslation();
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <input
        type="hidden"
        value={tenantSlug}
        {...register("tenant_slug")}
      />
      <p
        style={{
          margin: 0,
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {t("login.subtitle")}
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.emailLabel")}</span>
        <input
          type="email"
          autoComplete="username"
          autoFocus
          placeholder={t("login.emailPlaceholder")}
          aria-invalid={!!errors.email}
          {...register("email")}
          style={inputStyle}
        />
        {errors.email && <FieldError message={errors.email.message ?? ""} />}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.passwordLabel")}</span>
        <input
          type="password"
          autoComplete="current-password"
          placeholder={t("login.passwordPlaceholder")}
          aria-invalid={!!errors.password}
          {...register("password")}
          style={inputStyle}
        />
        {errors.password && <FieldError message={errors.password.message ?? ""} />}
      </label>

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

      <button
        type="submit"
        className="btn btn-primary"
        disabled={isSubmitting || isPending}
        style={{ justifyContent: "center", marginTop: 4 }}
      >
        <Icon name="check" size={13} />
        {isSubmitting || isPending ? t("login.submitting") : t("login.submit")}
      </button>

      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 12,
          color: "var(--text-tertiary)",
          justifyContent: "space-between",
        }}
      >
        <button
          type="button"
          onClick={onChangeTenant}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            textDecoration: "underline",
            padding: 0,
          }}
        >
          {t("login.tenantSlugLabel")}
        </button>
        {oidcEnabled && (
          <button
            type="button"
            onClick={onUseOidc}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            {t("login.oidcButton")}
          </button>
        )}
      </div>
    </form>
  );
}

const labelStyle = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

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

function FieldError({ message }: { message: string }) {
  return (
    <span style={{ color: "var(--danger-text)", fontSize: 11.5 }}>{message}</span>
  );
}
