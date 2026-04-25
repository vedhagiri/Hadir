// Provision tenant form (P3). Wraps the in-process provisioning code
// behind the API endpoint. Slug regex matches the DB CHECK on
// public.tenants.schema_name (lowercase letters, digits, underscores;
// must start with a letter or underscore — no hyphens, no spaces).

import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import { useProvisionTenant } from "./SuperAdminProvider";

const provisionSchema = z.object({
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(63, "Slug too long")
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, "Lowercase letters, digits, underscores only"),
  name: z.string().min(1, "Name is required").max(200),
  admin_email: z.string().email("Enter a valid email"),
  admin_full_name: z.string().optional(),
  admin_password: z
    .string()
    .min(8, "Minimum 8 characters")
    .max(1024),
});
type ProvisionValues = z.infer<typeof provisionSchema>;

const zodResolver: Resolver<ProvisionValues> = async (values) => {
  const parsed = provisionSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    if (!errors[path]) errors[path] = { type: issue.code, message: issue.message };
  }
  return { values: {} as ProvisionValues, errors };
};

export function ProvisionTenantPage() {
  const navigate = useNavigate();
  const provision = useProvisionTenant();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<ProvisionValues>({
    resolver: zodResolver,
    defaultValues: {
      slug: "",
      name: "",
      admin_email: "",
      admin_full_name: "",
      admin_password: "",
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const payload: {
        slug: string;
        name: string;
        admin_email: string;
        admin_password: string;
        admin_full_name?: string;
      } = {
        slug: values.slug,
        name: values.name,
        admin_email: values.admin_email,
        admin_password: values.admin_password,
      };
      if (values.admin_full_name) {
        payload.admin_full_name = values.admin_full_name;
      }
      const result = await provision.mutateAsync(payload);
      reset();
      navigate(`/super-admin/tenants/${result.tenant_id}`, { replace: true });
    } catch {
      // surfaced via provision.error
    }
  });

  const serverError = (() => {
    const err = provision.error;
    if (!err) return null;
    if (err instanceof ApiError) {
      // Backend includes the underlying error class + message in detail.
      const body = err.body as { detail?: string } | string | null;
      if (typeof body === "object" && body !== null && body.detail) {
        return body.detail;
      }
      return `Provisioning failed (${err.status}).`;
    }
    return "Provisioning failed.";
  })();

  return (
    <div>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, margin: "0 0 16px 0", fontWeight: 400 }}>
        Provision tenant
      </h1>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
        Creates the schema, materialises every per-tenant table, seeds default
        roles, departments, and shift policy, and creates the first Admin
        user. Audited as <code>super_admin.tenant.provisioned</code>.
      </p>

      <form
        onSubmit={onSubmit}
        noValidate
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 540,
        }}
      >
        <Field label="Schema slug" hint="e.g. tenant_acme  •  lowercase, digits, underscores; no hyphens, no spaces" error={errors.slug?.message}>
          <input type="text" autoComplete="off" {...register("slug")} style={inputStyle} />
        </Field>
        <Field label="Display name" hint="e.g. Acme Corp" error={errors.name?.message}>
          <input type="text" autoComplete="off" {...register("name")} style={inputStyle} />
        </Field>
        <Field label="Admin email" error={errors.admin_email?.message}>
          <input type="email" autoComplete="off" {...register("admin_email")} style={inputStyle} />
        </Field>
        <Field label="Admin full name (optional)" error={errors.admin_full_name?.message}>
          <input type="text" autoComplete="off" {...register("admin_full_name")} style={inputStyle} />
        </Field>
        <Field
          label="Admin password"
          hint="Minimum 8 characters. Stored as Argon2id; never logged."
          error={errors.admin_password?.message}
        >
          <input
            type="password"
            autoComplete="new-password"
            {...register("admin_password")}
            style={inputStyle}
          />
        </Field>

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
          disabled={isSubmitting || provision.isPending}
          style={{
            justifyContent: "center",
            background: "#c0392b",
            color: "white",
            border: "none",
            padding: "8px 14px",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {isSubmitting || provision.isPending ? "Provisioning…" : "Provision tenant"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
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
      {hint && <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{hint}</span>}
      {error && <span style={{ color: "var(--danger-text)", fontSize: 11.5 }}>{error}</span>}
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
