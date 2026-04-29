// Super-Admin login page (P3). Separate URL from the tenant login so the
// red privileged context is obvious from the moment the operator types
// the URL. On success, lands on /super-admin.

import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import { useSuperLogin, useSuperMe } from "./SuperAdminProvider";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
type LoginValues = z.infer<typeof loginSchema>;

const zodResolver: Resolver<LoginValues> = async (values) => {
  const parsed = loginSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    if (!errors[path]) errors[path] = { type: issue.code, message: issue.message };
  }
  return { values: {} as LoginValues, errors };
};

export function SuperAdminLogin() {
  const navigate = useNavigate();
  const login = useSuperLogin();
  const { data: me, isLoading } = useSuperMe();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver,
    defaultValues: { email: "", password: "" },
  });

  if (isLoading) return null;
  if (me != null) return <Navigate to="/super-admin" replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      navigate("/super-admin", { replace: true });
    } catch {
      // surfaced through login.error
    }
  });

  const serverError = (() => {
    const err = login.error;
    if (!err) return null;
    if (err instanceof ApiError) {
      if (err.status === 401) return "Invalid Super-Admin credentials.";
      return "Login failed. Try again.";
    }
    return "Login failed. Try again.";
  })();

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
      {/* Red accent bar — same treatment as inside the console so the
          login surface signals the privileged context immediately. */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 6,
          background: "#c0392b",
        }}
      />
      <form
        onSubmit={onSubmit}
        noValidate
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--bg-elev)",
          border: "1px solid #c0392b",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow)",
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "#c0392b",
            fontWeight: 600,
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            fontSize: 11,
          }}
        >
          MTS Operator Console — Privileged
        </div>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: 0,
            fontWeight: 400,
            letterSpacing: "-0.01em",
          }}
        >
          Super-Admin sign in
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Maugood staff only. Every action you take here is audit-logged in the
          tenant&apos;s own log and the global operator log.
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
          disabled={isSubmitting || login.isPending}
          style={{
            justifyContent: "center",
            marginTop: 4,
            background: "#c0392b",
            color: "white",
            border: "none",
            padding: "8px 14px",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {isSubmitting || login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
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
  return <span style={{ color: "var(--danger-text)", fontSize: 11.5 }}>{message}</span>;
}
