// Tenant detail (P3): branding placeholder + admin users + recent
// super-admin audit + Access as / Suspend toggles.

import { useNavigate, useParams } from "react-router-dom";

import {
  useAccessAs,
  useTenantDetail,
  useUpdateTenantStatus,
} from "./SuperAdminProvider";

export function TenantDetailPage() {
  const params = useParams();
  const tenantId = params.tenantId ? parseInt(params.tenantId, 10) : null;
  const detail = useTenantDetail(tenantId);
  const accessAs = useAccessAs();
  const updateStatus = useUpdateTenantStatus();
  const navigate = useNavigate();

  if (!tenantId || Number.isNaN(tenantId)) return <p>Invalid tenant id.</p>;
  if (detail.isLoading) return <p>Loading tenant…</p>;
  if (detail.error) return <p style={{ color: "var(--danger-text)" }}>Error loading tenant.</p>;
  const t = detail.data;
  if (!t) return <p>Tenant not found.</p>;

  const onAccessAs = async () => {
    if (t.status !== "active") return;
    try {
      await accessAs.mutateAsync(t.id);
      navigate("/", { replace: true });
    } catch {
      // surfaced
    }
  };

  const onToggleStatus = async () => {
    const next = t.status === "active" ? "suspended" : "active";
    if (
      !confirm(
        next === "suspended"
          ? `Suspend tenant ${t.name}? Logins will be blocked until you unsuspend.`
          : `Reactivate tenant ${t.name}?`,
      )
    ) {
      return;
    }
    try {
      await updateStatus.mutateAsync({ tenantId: t.id, status: next });
    } catch {
      // surfaced via mutation error
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, margin: 0, fontWeight: 400 }}>
          {t.name}
        </h1>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text-tertiary)",
            fontSize: 13,
          }}
        >
          {t.schema_name}
        </span>
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            background: t.status === "active" ? "var(--success-soft, #e6f4ea)" : "var(--danger-soft)",
            color: t.status === "active" ? "var(--success-text, #1d6b3a)" : "var(--danger-text)",
          }}
        >
          {t.status}
        </span>
        <div style={{ marginInlineStart: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={onAccessAs}
            disabled={t.status !== "active" || accessAs.isPending}
            style={{
              background: "#c0392b",
              color: "white",
              border: "none",
              padding: "8px 14px",
              borderRadius: "var(--radius-sm)",
              cursor: t.status === "active" ? "pointer" : "not-allowed",
              fontWeight: 600,
              opacity: t.status === "active" ? 1 : 0.4,
            }}
          >
            Access as
          </button>
          <button
            type="button"
            onClick={onToggleStatus}
            disabled={updateStatus.isPending}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              padding: "8px 14px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t.status === "active" ? "Suspend" : "Reactivate"}
          </button>
        </div>
      </header>

      <div style={cardStyle}>
        <h2 style={cardTitleStyle}>Stats</h2>
        <div style={{ display: "flex", gap: 32 }}>
          <Stat label="Admins" value={t.admin_count} />
          <Stat label="Active employees" value={t.employee_count} />
          <Stat label="Created" value={new Date(t.created_at).toLocaleDateString()} />
        </div>
      </div>

      <div style={cardStyle}>
        <h2 style={cardTitleStyle}>Branding</h2>
        <p style={{ color: "var(--text-tertiary)", fontSize: 13, margin: 0 }}>
          Per-tenant branding (logo, accent colour, font) lands in P4. Use
          &ldquo;Access as&rdquo; to view the tenant&apos;s current shell.
        </p>
      </div>

      <div style={cardStyle}>
        <h2 style={cardTitleStyle}>Admin users</h2>
        {t.admin_users.length === 0 ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No Admin users.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>Email</th>
                <th style={th}>Full name</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {t.admin_users.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={td}>{u.email}</td>
                  <td style={td}>{u.full_name}</td>
                  <td style={td}>{u.is_active ? "active" : "inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={cardStyle}>
        <h2 style={cardTitleStyle}>Recent operator audit (this tenant)</h2>
        {t.recent_super_admin_audit.length === 0 ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>
            No super-admin actions recorded for this tenant.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Action</th>
                <th style={th}>Entity</th>
                <th style={th}>Operator</th>
              </tr>
            </thead>
            <tbody>
              {t.recent_super_admin_audit.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={td}>{new Date(a.created_at).toLocaleString()}</td>
                  <td style={td}>
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {a.action}
                    </code>
                  </td>
                  <td style={td}>
                    {a.entity_type}
                    {a.entity_id ? ` #${a.entity_id}` : ""}
                  </td>
                  <td style={td}>#{a.super_admin_user_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-tertiary)" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

const cardStyle = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: 16,
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: 12,
};
const cardTitleStyle = {
  fontSize: 12,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
  margin: 0,
};
const th = {
  padding: "8px 10px",
  textAlign: "left" as const,
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};
const td = { padding: "8px 10px" };
