// Super-Admin login page (P3). Separate URL from the tenant login so the
// red privileged context is obvious from the moment the operator types
// the URL. On success, lands on /super-admin.

import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import { APP_VERSION_FULL } from "../config";
import { useSuperLogin, useSuperMe } from "./SuperAdminProvider";

import "./sa.css";

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
    <main className="sa-shell sa-login">
      {/* Red accent bar — same treatment as inside the console so the
          login surface signals the privileged context immediately. */}
      <div className="sa-bar" aria-hidden style={{ position: "fixed", top: 0, insetInline: 0 }} />
      <div>
        <form onSubmit={onSubmit} noValidate className="card sa-login-card">
          <div className="sa-brand">
            <span className="sa-brand-dot" aria-hidden />
            MTS Operator Console — Privileged
          </div>
          <h1 className="sa-login-title">Super-Admin sign in</h1>
          <p className="sa-login-sub">
            Maugood staff only. Every action you take here is audit-logged in the tenant&apos;s own log and the global
            operator log.
          </p>

          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" className="input" autoComplete="username" autoFocus aria-invalid={!!errors.email} {...register("email")} />
            {errors.email && <FieldError message={errors.email.message ?? ""} />}
          </label>

          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              className="input"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            {errors.password && <FieldError message={errors.password.message ?? ""} />}
          </label>

          {serverError && (
            <div role="alert" className="sa-alert">
              {serverError}
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={isSubmitting || login.isPending}>
            {isSubmitting || login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* Product version — same source as the sidebar version chip.
            A support ticket carrying "Super-Admin login on v1.1.9"
            spares the operator a shell session to read .version. */}
        <div className="sa-login-version mono">Maugood v{APP_VERSION_FULL}</div>
      </div>
    </main>
  );
}

function FieldError({ message }: { message: string }) {
  return <span className="sa-field-error">{message}</span>;
}
