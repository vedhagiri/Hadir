// Email + password login (P3) + Entra ID OIDC (P6).
//
// Single-screen form: workspace slug, email, and password live on the
// same card. The "Sign in with Microsoft" button appears below the
// local-credential submit when the entered workspace has OIDC enabled.
//
// Tenant resolution: subdomain-based routing (omran.maugood.example.com)
// will land here in production. For local dev the tenant slug comes
// from a ?tenant=… query param or the workspace field on the form.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import mtsLogo from "../assets/mts_logo.png";
import productMark from "../assets/mts_mark.png";
import loginHero from "../assets/login_hero.jpg";
import { useGoogleStatus, useOidcStatus } from "../auth-oidc/hooks";
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
  const [searchParams, setSearchParams] = useSearchParams();

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
    defaultValues: { email: "", password: "", tenant_slug: initialTenant || "" },
  });

  const watchedTenant = watch("tenant_slug") ?? "";
  const tenantSlug = watchedTenant.trim().toLowerCase();
  // Sign in stays disabled until every required field has a value;
  // the server still validates — this only prevents empty submits.
  const watchedEmail = (watch("email") ?? "").trim();
  const watchedPassword = watch("password") ?? "";
  const canSubmit = tenantSlug.length > 0 && watchedEmail.length > 0 && watchedPassword.length > 0;
  const tenantSlugValid = /^[a-z_][a-z0-9_]{0,62}$/.test(tenantSlug);

  const oidcStatus = useOidcStatus(tenantSlugValid ? tenantSlug : null);
  const oidcEnabled = !!oidcStatus.data?.enabled;
  const googleStatus = useGoogleStatus(tenantSlugValid ? tenantSlug : null);
  const googleEnabled = !!googleStatus.data?.enabled;

  // A failed SSO callback (Microsoft/Google) redirects back here with
  // ``?sso_error=<code>&provider=<name>`` instead of dumping raw JSON.
  // Map it to a friendly message shown in the login notice modal, then
  // strip the params so a refresh doesn't re-show it.
  const ssoErrorCode = searchParams.get("sso_error");
  const ssoProviderRaw = searchParams.get("provider");
  const ssoProviderName =
    ssoProviderRaw === "google"
      ? "Google"
      : ssoProviderRaw === "microsoft"
        ? "Microsoft"
        : "SSO";
  const SSO_ERROR_CODES = [
    "not_registered",
    "email_not_verified",
    "domain_not_allowed",
    "not_configured",
    "provider_error",
    "verify_failed",
    "session_expired",
  ];
  const ssoNotice = ssoErrorCode
    ? t(
        `login.ssoError.${
          SSO_ERROR_CODES.includes(ssoErrorCode) ? ssoErrorCode : "failed"
        }`,
        { provider: ssoProviderName },
      )
    : null;

  useEffect(() => {
    if (!ssoErrorCode) return;
    const next = new URLSearchParams(searchParams);
    next.delete("sso_error");
    next.delete("provider");
    setSearchParams(next, { replace: true });
    // Run once on mount — the notice message is already captured in
    // ``ssoNotice`` and seeded into the form's local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // The brand column is sized to the poster's own aspect ratio
        // (1160 x 1356) at full viewport height, so the artwork fills
        // it exactly with no letterbox bars; the form takes the rest.
        // Capped at half the width for very tall / narrow windows.
        gridTemplateColumns: "minmax(0, 1fr) min(50vw, calc(100vh * 1160 / 1356))",
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
          background:
            "radial-gradient(120% 90% at 0% 0%, #e8f1fb 0%, #f3f7fc 45%, #eef3f8 100%)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 440,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "0 18px 50px rgba(15, 23, 42, 0.10)",
            padding: "32px 30px",
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
            canSubmit={canSubmit}
            onSubmit={onSubmit}
            tenantSlug={tenantSlug}
            tenantSlugValid={tenantSlugValid}
            oidcEnabled={oidcEnabled}
            googleEnabled={googleEnabled}
            serverError={serverError}
            initialNotice={ssoNotice}
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
  // Right-hand panel: the "AI-powered attendance" banner (portrait,
  // 1160x1356, approved login banner), bundled locally — no network fetch, so it works on
  // air-gapped installs. The poster carries its own headline + feature
  // copy, so nothing is overlaid.
  return (
    <aside
      className="login-brand-panel"
      aria-label="AI-powered CCTV attendance"
      style={{
        // Pinned to the viewport height so the poster never makes the
        // page taller than the screen (no scrollbar); ``contain`` shows
        // the whole artwork on a backdrop matching its own edge colour.
        position: "sticky",
        top: 0,
        alignSelf: "start",
        height: "100vh",
        overflow: "hidden",
        background: "#f8fbfd",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <img
        src={loginHero}
        alt="AI-powered CCTV attendance — real people, real time. MaugoodAI by Muscat Tech Solutions"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          // The column matches the image ratio, so this is an exact fit;
          // when the 50vw cap kicks in (tall windows) the crop takes the
          // right-hand edge and keeps the headline + feature copy.
          objectFit: "cover",
          objectPosition: "left center",
          display: "block",
        }}
      />
    </aside>
  );
}

function LoginFooter() {
  const { t } = useTranslation();
  // Mirrors the sidebar footer: "Powered by <mark> Muscat Tech Solutions"
  // as a link to the vendor site. Nothing else — version lives in the
  // sidebar once signed in.
  return (
    <footer
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text-tertiary)",
      }}
    >
      <span>{t("login.footer.poweredBy")}</span>
      <a
        href="https://mts-om.com/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontWeight: 600,
          color: "var(--text-secondary)",
          textDecoration: "none",
        }}
      >
        <img src={productMark} alt="" aria-hidden style={{ height: 14, width: "auto", display: "block" }} />
        <span>Muscat Tech Solutions</span>
      </a>
    </footer>
  );
}

function RequiredMark() {
  const { t } = useTranslation();
  return (
    <span
      aria-label={t("login.required")}
      title={t("login.required")}
      style={{ color: "var(--danger-text, #c0392b)", marginInlineStart: 3, fontWeight: 700 }}
    >
      *
    </span>
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
  canSubmit: boolean;
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  tenantSlug: string;
  tenantSlugValid: boolean;
  oidcEnabled: boolean;
  googleEnabled: boolean;
  serverError: string | null;
  initialNotice: string | null;
}

function CombinedLoginForm({
  register,
  errors,
  isSubmitting,
  isPending,
  canSubmit,
  onSubmit,
  tenantSlug,
  tenantSlugValid,
  oidcEnabled,
  googleEnabled,
  serverError,
  initialNotice,
}: CombinedFormProps) {
  const { t } = useTranslation();
  // Provider-not-configured notice. Replaces the jarring native
  // window.alert with an in-card styled popup so the message reads as
  // part of the product, not a browser chrome dialog. Seeded from a
  // failed SSO callback's ``?sso_error`` when present.
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [showPassword, setShowPassword] = useState(false);
  const oidcUrl = tenantSlugValid
    ? `/api/auth/oidc/login?tenant=${encodeURIComponent(tenantSlug)}`
    : "";
  const googleUrl = tenantSlugValid
    ? `/api/auth/google/login?tenant=${encodeURIComponent(tenantSlug)}`
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
        <span style={labelStyle}>{t("login.tenantSlugLabel")}<RequiredMark /></span>
        <div style={fieldWrapStyle}>
          <span style={fieldIconStyle} aria-hidden="true"><BuildingIcon /></span>
          <input
            type="text"
            autoComplete="organization"
            autoFocus={!tenantSlug}
            placeholder={t("login.tenantSlugPlaceholder")}
            aria-invalid={!!errors.tenant_slug}
            {...register("tenant_slug")}
            style={inputStyle}
          />
        </div>
        {errors.tenant_slug && (
          <FieldError message={errors.tenant_slug.message ?? ""} />
        )}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.emailLabel")}<RequiredMark /></span>
        <div style={fieldWrapStyle}>
          <span style={fieldIconStyle} aria-hidden="true"><Icon name="mail" size={15} /></span>
          <input
            type="email"
            autoComplete="username"
            autoFocus={!!tenantSlug}
            placeholder={t("login.emailPlaceholder")}
            aria-invalid={!!errors.email}
            {...register("email")}
            style={inputStyle}
          />
        </div>
        {errors.email && <FieldError message={errors.email.message ?? ""} />}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("login.passwordLabel")}<RequiredMark /></span>
        <div style={fieldWrapStyle}>
          <span style={fieldIconStyle} aria-hidden="true"><LockIcon /></span>
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder={t("login.passwordPlaceholder")}
            aria-invalid={!!errors.password}
            {...register("password")}
            style={{ ...inputStyle, paddingInlineEnd: 40 }}
          />
          {/* Show / hide toggle. type="button" so it never submits the
              form; aria-pressed + label keep it readable for screen
              readers. The icon mirrors in RTL via the icon-* class. */}
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
            aria-pressed={showPassword}
            title={showPassword ? t("login.hidePassword") : t("login.showPassword")}
            style={eyeButtonStyle}
          >
            <Icon name={showPassword ? "eyeOff" : "eye"} size={15} />
          </button>
        </div>
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
        disabled={!canSubmit || isSubmitting || isPending}
        aria-disabled={!canSubmit || isSubmitting || isPending}
        style={{
          ...submitButtonStyle,
          ...(!canSubmit ? { opacity: 0.55, boxShadow: "none", cursor: "not-allowed" } : {}),
        }}
      >
        <ArrowRightIcon />
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
          method. Icon-only: the provider mark stands in for the label;
          accessible names come from aria-label + title (tooltip). The buttons short-circuit to a
          small notice when the active workspace hasn't enabled
          the provider — the backend route only responds when OIDC
          is configured for the tenant, so we surface the gating
          reason client-side rather than letting the browser
          navigate to a 404. */}
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "center",
          marginTop: 2,
        }}
      >
        <button
          type="button"
          aria-label={t("login.oidcButton")}
          title={t("login.oidcButton")}
          onClick={(e) => {
            e.preventDefault();
            if (!tenantSlugValid) {
              setNotice(
                t("login.enterWorkspaceFirst", {
                  defaultValue:
                    "Enter your workspace name above first, then choose a sign-in provider.",
                }),
              );
              return;
            }
            if (!oidcEnabled || !oidcUrl) {
              setNotice(
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
          <MicrosoftLogo size={22} />
        </button>

        <button
          type="button"
          aria-label={t("login.googleButton", {
            defaultValue: "Sign in with Google",
          })}
          title={t("login.googleButton", {
            defaultValue: "Sign in with Google",
          })}
          onClick={(e) => {
            e.preventDefault();
            if (!tenantSlugValid) {
              setNotice(
                t("login.enterWorkspaceFirst", {
                  defaultValue:
                    "Enter your workspace name above first, then choose a sign-in provider.",
                }),
              );
              return;
            }
            if (!googleEnabled || !googleUrl) {
              setNotice(
                t("login.providerNotEnabled", {
                  provider: "Google",
                  defaultValue:
                    "Google sign-in isn't enabled for this workspace yet. Ask your administrator to configure it under Settings → Authentication.",
                }),
              );
              return;
            }
            window.location.assign(googleUrl);
          }}
          style={ssoButtonStyle}
        >
          <GoogleLogo size={22} />
        </button>
      </div>

      {notice !== null && (
        <ProviderNoticeModal
          message={notice}
          onClose={() => setNotice(null)}
        />
      )}
    </form>
  );
}

// Styled "provider not configured" popup — a small centered modal that
// matches the product surface instead of the native browser alert().
// Esc or the backdrop or the OK button dismisses it.
function ProviderNoticeModal({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t("login.ssoUnavailableTitle", {
          defaultValue: "Sign-in unavailable",
        })}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 380,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md, 12px)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.25)",
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              flex: "0 0 auto",
              borderRadius: "50%",
              background: "var(--accent-soft, var(--bg-sunken))",
              color: "var(--accent)",
            }}
          >
            <Icon name="info" size={18} />
          </span>
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            {t("login.ssoUnavailableTitle", {
              defaultValue: "Sign-in unavailable",
            })}
          </h2>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--text-secondary)",
          }}
        >
          {message}
        </p>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
            autoFocus
            style={{ justifyContent: "center", minWidth: 88 }}
          >
            {t("common.done", { defaultValue: "OK" })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const ssoButtonStyle = {
  background: "var(--bg-elev)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  width: 48,
  height: 44,
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  fontFamily: "var(--font-sans)",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)",
};

// Teal gradient primary action with a leading arrow (approved login mock).
const submitButtonStyle = {
  justifyContent: "center",
  marginTop: 4,
  height: 42,
  fontSize: 14,
  fontWeight: 600,
  background: "linear-gradient(90deg, #0f766e 0%, #14867c 60%, #1f9b8f 100%)",
  border: "none",
  color: "#ffffff",
  boxShadow: "0 8px 20px rgba(15, 118, 110, 0.28)",
} as const;

// Input with a leading icon: wrapper is relative, the icon sits in the
// start padding, the eye toggle (password) in the end padding.
const fieldWrapStyle = { position: "relative", display: "flex" } as const;
const fieldIconStyle = {
  position: "absolute",
  insetInlineStart: 0,
  top: 0,
  bottom: 0,
  width: 40,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
  borderInlineEnd: "1px solid var(--border)",
  pointerEvents: "none",
} as const;

function BuildingIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg className="icon-arrow-right" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function GoogleLogo({ size = 14 }: { size?: number }) {
  // Multi-coloured Google "G" — official mark, public press-kit
  // viewBox + paths.
  return (
    <svg
      width={size}
      height={size}
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

function MicrosoftLogo({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

const eyeButtonStyle = {
  position: "absolute",
  insetInlineEnd: 4,
  top: "50%",
  transform: "translateY(-50%)",
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  borderRadius: "var(--radius-sm)",
} as const;

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  paddingInlineStart: 50,
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
