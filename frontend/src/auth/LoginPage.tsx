// Email + password login (P3) + Entra ID OIDC (P6).
//
// Single-screen form: workspace slug, email, and password live on the
// same card. The "Sign in with Microsoft" button appears below the
// local-credential submit when the entered workspace has OIDC enabled.
//
// Tenant resolution: subdomain-based routing (omran.maugood.example.com)
// will land here in production. For local dev the tenant slug comes
// from a ?tenant=… query param or the workspace field on the form.

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

  // Tenant slug — pulled from ?tenant=… and kept in form state. Drives
  // the OIDC probe so the Microsoft button renders only when the
  // entered workspace actually has OIDC enabled.
  const initialTenant = searchParams.get("tenant") ?? "";

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
  } = useForm<LoginValues>({
    resolver: zodResolver,
    defaultValues: { email: "", password: "", tenant_slug: initialTenant },
  });

  const watchedTenant = watch("tenant_slug") ?? "";
  const tenantSlug = watchedTenant.trim().toLowerCase();
  const tenantSlugValid = /^[a-z_][a-z0-9_]{0,62}$/.test(tenantSlug);

  const oidcStatus = useOidcStatus(tenantSlugValid ? tenantSlug : null);
  const oidcEnabled = !!oidcStatus.data?.enabled;

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

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        // Two-column split on >=900px: form half + brand half. Below
        // that we stack into a single column so the form stays
        // usable on phones and the brand panel slides above it.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        background: "var(--bg)",
        color: "var(--text)",
      }}
      className="login-grid"
    >
      {/* Left half — sign-in options */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
          // Slightly tinted surface to push the white form card off
          // the page background — gives the split a clearer divide
          // without going all the way to the brand-panel darkness.
          background: "var(--bg-sunken, #eef0f4)",
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

          <CombinedLoginForm
            register={register}
            errors={errors}
            isSubmitting={isSubmitting}
            isPending={login.isPending}
            onSubmit={onSubmit}
            tenantSlug={tenantSlug}
            tenantSlugValid={tenantSlugValid}
            oidcEnabled={oidcEnabled}
            serverError={serverError}
          />
        </div>

        <LoginFooter />
      </section>

      {/* Right half — brand panel with background image. Hidden on
          narrow viewports via the inline media-query stylesheet
          mounted just below. */}
      <BrandPanel />

      <style>{`
        @media (max-width: 899px) {
          .login-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .login-brand-panel { display: none !important; }
        }
      `}</style>
    </main>
  );
}

function BrandPanel() {
  // Background image: an Unsplash editorial shot of a modern office
  // hallway. We layer a deep gradient over it so the white headline
  // copy stays legible regardless of the underlying photo.
  const bgUrl =
    "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80";
  return (
    <aside
      className="login-brand-panel"
      style={{
        position: "relative",
        overflow: "hidden",
        backgroundImage: `linear-gradient(135deg, rgba(15, 23, 42, 0.78) 0%, rgba(30, 41, 59, 0.62) 60%, rgba(15, 23, 42, 0.85) 100%), url("${bgUrl}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        color: "white",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "64px 56px",
        gap: 24,
      }}
    >
      <div style={{ maxWidth: 460, display: "flex", flexDirection: "column", gap: 16 }}>
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "rgba(255,255,255,0.78)",
          }}
        >
          Maugood · Attendance Platform
        </span>
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 38,
            lineHeight: 1.15,
            margin: 0,
            fontWeight: 500,
            letterSpacing: "-0.01em",
          }}
        >
          Camera-driven attendance that thinks like an HR team.
        </h2>
        <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: 0, color: "rgba(255,255,255,0.82)" }}>
          Face-recognition cameras handle clock-in. Policies, leave, holidays
          and exceptions handle the rest. Spend your days approving requests
          and reading reports — not chasing biometric devices.
        </p>
      </div>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          maxWidth: 460,
        }}
      >
        {[
          { title: "Always-on capture", body: "RTSP cameras stream directly into the pipeline." },
          { title: "Multi-tenant", body: "One platform, isolated workspaces, branded per client." },
          { title: "PDPL-ready", body: "Encryption at rest, audit trail, retention sweeps." },
          { title: "Arabic + RTL", body: "Every operator sees their language end-to-end." },
        ].map((f) => (
          <li
            key={f.title}
            style={{
              background: "rgba(15, 23, 42, 0.55)",
              border: "1px solid rgba(255,255,255,0.28)",
              borderRadius: 12,
              padding: "14px 16px",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                marginBottom: 6,
                color: "#ffffff",
                letterSpacing: "-0.005em",
              }}
            >
              {f.title}
            </div>
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.55,
                color: "rgba(255,255,255,0.92)",
              }}
            >
              {f.body}
            </div>
          </li>
        ))}
      </ul>

      <div
        style={{
          marginTop: "auto",
          fontSize: 11,
          color: "rgba(255,255,255,0.6)",
          letterSpacing: "0.04em",
        }}
      >
        Built in Oman by Muscat Tech Solutions
      </div>
    </aside>
  );
}

function LoginFooter() {
  const year = new Date().getFullYear();
  return (
    <footer
      style={{
        textAlign: "center",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--text-tertiary)",
        maxWidth: 400,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          🇴🇲
        </span>
        <span>Made with ♥ in Oman</span>
      </div>
      <div>
        Powered by{" "}
        <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
          Muscat Tech Solutions
        </span>
      </div>
      <div style={{ marginTop: 2, opacity: 0.85 }}>
        © {year} Muscat Tech Solutions. All rights reserved.
      </div>
    </footer>
  );
}

function Header({ tenantSlug }: { tenantSlug: string | null }) {
  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
          position: "relative",
        }}
      >
        <img
          src={mtsLogo}
          alt="Muscat Tech Solutions"
          style={{ height: 56, width: "auto", objectFit: "contain" }}
        />
        {tenantSlug && (
          <span
            style={{
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
        textAlign: "center",
      }}
    >
      {t("login.title")}
    </h1>
  );
}

interface CombinedFormProps {
  register: ReturnType<typeof useForm<LoginValues>>["register"];
  errors: ReturnType<typeof useForm<LoginValues>>["formState"]["errors"];
  isSubmitting: boolean;
  isPending: boolean;
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  tenantSlug: string;
  tenantSlugValid: boolean;
  oidcEnabled: boolean;
  serverError: string | null;
}

function CombinedLoginForm({
  register,
  errors,
  isSubmitting,
  isPending,
  onSubmit,
  tenantSlug,
  tenantSlugValid,
  oidcEnabled,
  serverError,
}: CombinedFormProps) {
  const { t } = useTranslation();
  const oidcUrl = tenantSlugValid
    ? `/api/auth/oidc/login?tenant=${encodeURIComponent(tenantSlug)}`
    : "";
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
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
        <span style={labelStyle}>{t("login.tenantSlugLabel")}</span>
        <input
          type="text"
          autoComplete="organization"
          autoFocus={!tenantSlug}
          placeholder={t("login.tenantSlugPlaceholder")}
          aria-invalid={!!errors.tenant_slug}
          {...register("tenant_slug")}
          style={inputStyle}
        />
        {errors.tenant_slug && (
          <FieldError message={errors.tenant_slug.message ?? ""} />
        )}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.emailLabel")}</span>
        <input
          type="email"
          autoComplete="username"
          autoFocus={!!tenantSlug}
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
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        <span>{t("common.or", { defaultValue: "or" })}</span>
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>

      {/* Microsoft + Google buttons render unconditionally so the
          login surface always advertises every supported sign-in
          method. The buttons short-circuit to a small notice modal
          when the active workspace hasn't enabled the provider — the
          backend route only responds when OIDC is configured for the
          tenant, so we surface the gating reason client-side rather
          than letting the browser navigate to a 404. */}
      <button
        type="button"
        onClick={(e) => {
          if (!oidcEnabled || !oidcUrl) {
            e.preventDefault();
            window.alert(
              t("login.providerNotEnabled", {
                provider: "Microsoft",
                defaultValue:
                  "Microsoft sign-in isn't enabled for this workspace yet. Ask your administrator to configure it under Settings → Authentication.",
              }),
            );
            return;
          }
          window.location.assign(oidcUrl);
        }}
        style={ssoButtonStyle}
      >
        <MicrosoftLogo />
        {t("login.oidcButton")}
      </button>

      <button
        type="button"
        onClick={() => {
          window.alert(
            t("login.providerNotEnabled", {
              provider: "Google",
              defaultValue:
                "Google sign-in isn't enabled for this workspace yet. Ask your administrator to configure it under Settings → Authentication.",
            }),
          );
        }}
        style={ssoButtonStyle}
      >
        <GoogleLogo />
        {t("login.googleButton", { defaultValue: "Sign in with Google" })}
      </button>
    </form>
  );
}

const ssoButtonStyle = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "10px 14px",
  borderRadius: "var(--radius-sm)",
  textAlign: "center" as const,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 14,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  fontFamily: "var(--font-sans)",
};

function GoogleLogo() {
  // Multi-coloured Google "G" — official mark, public press-kit
  // viewBox + paths.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
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

function MicrosoftLogo() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 23 23"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
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
