// Email + password login (P3) + Entra ID OIDC (P6).
//
// When the active tenant has OIDC enabled, "Sign in with Microsoft" is
// the primary CTA and the local password form collapses behind a
// "Use local account" link — break-glass only. When OIDC is disabled
// or the tenant has no config, the local form is the primary surface.
//
// Tenant resolution: subdomain-based routing (omran.hadir.example.com)
// will land here in production. For local dev the tenant slug comes
// from a ?tenant=… query param the user types in (or the picker below).

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
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
      if (err.status === 401) return "Invalid credentials for this tenant.";
      if (err.status === 429)
        return "Too many attempts. Try again in a few minutes.";
      if (err.status === 403)
        return "Tenant is suspended. Contact your administrator.";
      return "Login failed. Please try again.";
    }
    return "Login failed. Please try again.";
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
        <div className="brand-mark" style={{ width: 28, height: 28, fontSize: 14 }}>
          ح
        </div>
        <div style={{ fontWeight: 600, letterSpacing: "-0.01em" }}>Hadir</div>
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
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 32,
          margin: 0,
          fontWeight: 400,
          letterSpacing: "-0.01em",
        }}
      >
        Sign in
      </h1>
    </>
  );
}

function TenantPicker({ onPick }: { onPick: (slug: string) => void }) {
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
        Enter your tenant slug. In production this comes from your subdomain
        (e.g. <code>omran</code> for <code>omran.hadir.example.com</code>).
      </p>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Tenant slug</span>
        <input
          type="text"
          autoFocus
          autoComplete="off"
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
        Continue
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
  const oidcUrl = `/api/auth/oidc/login?tenant=${encodeURIComponent(tenantSlug)}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
        Sign in with your Microsoft account. Your administrator must register
        you in Hadir before your first sign-in.
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
        Sign in with Microsoft
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
        Use local account (break-glass)
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
        Enter your Hadir credentials.
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Email</span>
        <input
          type="email"
          autoComplete="username"
          autoFocus
          aria-invalid={!!errors.email}
          {...register("email")}
          style={inputStyle}
        />
        {errors.email && <FieldError message={errors.email.message ?? ""} />}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Password</span>
        <input
          type="password"
          autoComplete="current-password"
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
        {isSubmitting || isPending ? "Signing in…" : "Sign in"}
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
          Change tenant
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
            Sign in with Microsoft
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
