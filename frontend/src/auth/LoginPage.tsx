// Email + password login.
//
// Form validation uses React Hook Form with a small hand-written resolver
// that runs zod. The prompt-named deps are RHF + Zod; we don't pull in
// `@hookform/resolvers` for a one-liner.
//
// On success, we navigate to ``/`` — the role-default landing route. The
// login mutation's ``onSuccess`` already populates the TanStack Query
// cache with the user, so the next render of ProtectedRoute will let us
// through without a second network round-trip.

import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
import { useLogin, useMe } from "./AuthProvider";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
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

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver,
    defaultValues: { email: "", password: "" },
  });

  // If the user is already logged in, never show the form.
  if (meLoading) return null;
  if (me != null) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      navigate("/", { replace: true });
    } catch {
      // Error surfaces through the mutation state below; nothing to do.
    }
  });

  const serverError = (() => {
    const err = login.error;
    if (!err) return null;
    if (err instanceof ApiError) {
      if (err.status === 401) return "Invalid email or password.";
      if (err.status === 429) return "Too many attempts. Try again in a few minutes.";
      return "Login failed. Please try again.";
    }
    return "Login failed. Please try again.";
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
      <form
        onSubmit={onSubmit}
        noValidate
        style={{
          width: "100%",
          maxWidth: 380,
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
          <span className="brand-tag" style={{ marginInlineStart: "auto" }}>
            v0.1
          </span>
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
        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          Enter your Hadir credentials. SSO is available in v1.0.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-tertiary)",
            }}
          >
            Email
          </span>
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
          <span
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-tertiary)",
            }}
          >
            Password
          </span>
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
          disabled={isSubmitting || login.isPending}
          style={{ justifyContent: "center", marginTop: 4 }}
        >
          <Icon name="check" size={13} />
          {isSubmitting || login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
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

function FieldError({ message }: { message: string }) {
  return (
    <span style={{ color: "var(--danger-text)", fontSize: 11.5 }}>{message}</span>
  );
}
