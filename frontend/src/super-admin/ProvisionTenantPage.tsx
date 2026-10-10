// Provision tenant form (P3). Wraps the in-process provisioning code
// behind the API endpoint. Slug regex matches the DB CHECK on
// public.tenants.schema_name (lowercase letters, digits, underscores;
// must start with a letter or underscore — no hyphens, no spaces).

import { useForm } from "react-hook-form";
import type { Resolver } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "../api/client";
import { Panel } from "../features/dashboard/DashUi";
import { Icon } from "../shell/Icon";
import "./sa.css";
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
      <div className="page-header">
        <div>
          <h1 className="page-title">Provision tenant</h1>
          <p className="page-sub">Create a new organisation with its own isolated schema and first Admin account.</p>
        </div>
      </div>

      <div className="sa-provision">
      <Panel title="Tenant details" sub="All fields except the Admin's full name are required">
      <form onSubmit={onSubmit} noValidate className="sa-form">
        <Field label="Schema slug" hint="e.g. tenant_acme  •  lowercase, digits, underscores; no hyphens, no spaces" error={errors.slug?.message}>
          <input type="text" autoComplete="off" className="input" {...register("slug")} />
        </Field>
        <Field label="Display name" hint="e.g. Acme Corp" error={errors.name?.message}>
          <input type="text" autoComplete="off" className="input" {...register("name")} />
        </Field>
        <Field label="Admin email" error={errors.admin_email?.message}>
          <input type="email" autoComplete="off" className="input" {...register("admin_email")} />
        </Field>
        <Field label="Admin full name (optional)" error={errors.admin_full_name?.message}>
          <input type="text" autoComplete="off" className="input" {...register("admin_full_name")} />
        </Field>
        <Field
          label="Admin password"
          hint="Minimum 8 characters. Stored as Argon2id; never logged."
          error={errors.admin_password?.message}
        >
          <input type="password" className="input" autoComplete="new-password" {...register("admin_password")} />
        </Field>

        {serverError && (
          <div role="alert" className="sa-alert">
            {serverError}
          </div>
        )}

        <div className="sa-form-foot">
          <button type="button" className="btn" onClick={() => navigate("/super-admin/tenants")}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSubmitting || provision.isPending}>
            {isSubmitting || provision.isPending ? "Provisioning…" : "Provision tenant"}
          </button>
        </div>
      </form>
      </Panel>

      <Panel title="What happens" sub="Runs in one transaction — any failure rolls everything back">
        <ol className="sa-steps">
          {[
            "Creates the tenant's Postgres schema and registers it in the tenant registry.",
            "Materialises every per-tenant table at the current migration head.",
            "Seeds the default roles, departments and shift policy.",
            "Creates the first Admin user with the password you set.",
          ].map((step, i) => (
            <li key={i} className="sa-step">
              <span aria-hidden className="sa-step-n">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="sa-note">
          <Icon name="shield" size={13} />
          <span>
            Audited as <code className="sa-code">super_admin.tenant.provisioned</code>. The password is stored as Argon2id and never
            logged.
          </span>
        </div>
      </Panel>
      </div>
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
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-help">{hint}</span>}
      {error && <span className="sa-field-error">{error}</span>}
    </label>
  );
}
