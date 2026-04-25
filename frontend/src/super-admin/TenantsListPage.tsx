// Tenants list (P3). Name, slug, created, admin/employee counts, status.
// Each row links to the detail page; the "Access as" button on a row
// sets impersonation and forwards to the tenant shell.

import { Link, useNavigate } from "react-router-dom";

import { useAccessAs, useTenants } from "./SuperAdminProvider";
import type { TenantSummary } from "./types";

export function TenantsListPage() {
  const tenants = useTenants();
  const accessAs = useAccessAs();
  const navigate = useNavigate();

  const onAccessAs = async (t: TenantSummary) => {
    if (t.status !== "active") return;
    try {
      await accessAs.mutateAsync(t.id);
      // Land on the tenant root — the impersonation banner mounts via
      // the shell layout once /api/auth/me returns is_super_admin_impersonation.
      navigate("/", { replace: true });
    } catch {
      // surfaced via accessAs.error
    }
  };

  if (tenants.isLoading) return <p>Loading tenants…</p>;
  if (tenants.error) return <p style={{ color: "var(--danger-text)" }}>Error loading tenants.</p>;
  const items = tenants.data ?? [];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, margin: 0, fontWeight: 400 }}>
          Tenants
        </h1>
        <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>
          {items.length} total
        </span>
      </div>

      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)" }}>
              <th style={th}>Name</th>
              <th style={th}>Slug</th>
              <th style={th}>Created</th>
              <th style={{ ...th, textAlign: "right" }}>Admins</th>
              <th style={{ ...th, textAlign: "right" }}>Employees</th>
              <th style={th}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>
                  <Link
                    to={`/super-admin/tenants/${t.id}`}
                    style={{ color: "var(--text)", fontWeight: 500 }}
                  >
                    {t.name}
                  </Link>
                </td>
                <td style={{ ...td, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                  {t.schema_name}
                </td>
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {new Date(t.created_at).toLocaleDateString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {t.admin_count}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {t.employee_count}
                </td>
                <td style={td}>
                  <StatusPill status={t.status} />
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button
                    type="button"
                    onClick={() => onAccessAs(t)}
                    disabled={t.status !== "active" || accessAs.isPending}
                    title={
                      t.status !== "active"
                        ? "Tenant is suspended — unsuspend before impersonating"
                        : "Impersonate this tenant"
                    }
                    style={{
                      background: "#c0392b",
                      color: "white",
                      border: "none",
                      padding: "4px 10px",
                      borderRadius: "var(--radius-sm)",
                      cursor: t.status === "active" ? "pointer" : "not-allowed",
                      fontSize: 12,
                      opacity: t.status === "active" ? 1 : 0.4,
                    }}
                  >
                    Access as
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}>
                  No tenants yet. Use{" "}
                  <Link to="/super-admin/provision" style={{ color: "#c0392b" }}>
                    Provision tenant
                  </Link>{" "}
                  to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "active" | "suspended" }) {
  const isActive = status === "active";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: isActive ? "var(--success-soft, #e6f4ea)" : "var(--danger-soft)",
        color: isActive ? "var(--success-text, #1d6b3a)" : "var(--danger-text)",
      }}
    >
      {status}
    </span>
  );
}

const th = {
  padding: "10px 12px",
  textAlign: "left" as const,
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

const td = { padding: "10px 12px", verticalAlign: "middle" as const };
