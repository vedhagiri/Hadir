// Tenant detail (P3 + P4 branding tab): admin users + recent
// super-admin audit + Access as / Suspend toggles, plus the
// per-tenant branding editor that targets this tenant's id.

import { Link, useNavigate, useParams } from "react-router-dom";

import { SuperAdminBrandingTab } from "../branding/SuperAdminBrandingTab";
import { EmptyPanel } from "../components/ListPageUi";
import { SkeletonCards, SkeletonLine, SkeletonPanel } from "../components/Skeleton";
import { Panel, PanelEmpty, SoftPill, Tile, TileGrid, nowrap } from "../features/dashboard/DashUi";
import { Icon } from "../shell/Icon";
import { TenantStatusPill } from "./saUi";
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

  const back = (
    <Link to="/super-admin/tenants" className="sa-back">
      <Icon name="chevronLeft" size={13} />
      All tenants
    </Link>
  );

  if (!tenantId || Number.isNaN(tenantId) || detail.error || (!detail.isLoading && !detail.data)) {
    return (
      <div>
        {back}
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title={detail.error ? "Couldn't load this tenant" : "Tenant not found"}
            body={
              detail.error
                ? "The tenant registry did not respond. Check the backend and try again."
                : "There is no tenant with this id. It may have been deprovisioned."
            }
            actions={
              <button type="button" className="btn" onClick={() => navigate("/super-admin/tenants")}>
                Back to tenants
              </button>
            }
          />
        </div>
      </div>
    );
  }
  if (detail.isLoading || !detail.data) {
    return (
      <div role="status" aria-label="Loading tenant" className="sa-stack">
        {back}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonLine width={240} height={26} />
          <SkeletonLine width={160} height={12} />
        </div>
        <SkeletonCards count={3} />
        <SkeletonPanel lines={4} />
        <SkeletonPanel lines={4} />
      </div>
    );
  }
  const t = detail.data;

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
    <div className="sa-stack">
      <div>
        {back}
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h1 className="page-title sa-title-row">
              {t.name || t.schema_name}
              <TenantStatusPill status={t.status} />
            </h1>
            <p className="page-sub">
              Schema <span className="mono">{t.schema_name}</span> · tenant #{t.id}
            </p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn" onClick={onToggleStatus} disabled={updateStatus.isPending}>
              {t.status === "active" ? "Suspend" : "Reactivate"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onAccessAs}
              disabled={t.status !== "active" || accessAs.isPending}
              title={t.status !== "active" ? "Tenant is suspended — unsuspend before impersonating" : "Impersonate this tenant"}
            >
              Access as
            </button>
          </div>
        </div>
      </div>

      <TileGrid>
        <Tile tone="info" icon="shield" label="Admins" value={t.admin_count} sub="users with the Admin role" />
        <Tile tone="success" icon="users" label="Active employees" value={t.employee_count.toLocaleString()} sub="on the employee register" />
        <Tile
          tone="neutral"
          icon="calendar"
          label="Created"
          value={new Date(t.created_at).toLocaleDateString()}
          sub={new Date(t.created_at).toLocaleTimeString()}
        />
      </TileGrid>

      <Panel title="Branding" sub="Accent colour, font and logo this tenant's users see">
        <SuperAdminBrandingTab tenantId={t.id} />
      </Panel>

      <Panel title="Admin users" sub={`${t.admin_users.length} account(s) with the Admin role`} bodyPadding={0}>
        {t.admin_users.length === 0 ? (
          <PanelEmpty icon="user" title="No Admin users" body="This tenant has no Admin account. Access as the tenant to create one." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Full name</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {t.admin_users.map((u) => (
                <tr key={u.id}>
                  <td className="text-sm" style={nowrap}>{u.email}</td>
                  <td className="text-sm sa-strong">{u.full_name}</td>
                  <td>
                    {u.is_active ? <SoftPill tone="success">Active</SoftPill> : <SoftPill tone="neutral">Inactive</SoftPill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent operator audit" sub="Super-admin actions recorded against this tenant" bodyPadding={0}>
        {t.recent_super_admin_audit.length === 0 ? (
          <PanelEmpty icon="clipboard" title="No operator actions yet" body="No super-admin actions recorded for this tenant." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {t.recent_super_admin_audit.map((a) => (
                <tr key={a.id}>
                  <td className="text-sm sa-secondary" style={nowrap}>
                    {new Date(a.created_at).toLocaleString()}
                  </td>
                  <td>
                    <code className="sa-code">{a.action}</code>
                  </td>
                  <td className="text-sm">
                    {a.entity_type}
                    {a.entity_id ? ` #${a.entity_id}` : ""}
                  </td>
                  <td className="mono text-sm">#{a.super_admin_user_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
