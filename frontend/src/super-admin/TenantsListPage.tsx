// Tenants list (P3). Name, slug, created, admin/employee counts, status.
// Each row links to the detail page; the "Access as" button on a row
// sets impersonation and forwards to the tenant shell.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { EmptyPanel, FilterSelect, ResetButton, SearchField, StatCard, StatGrid, Toolbar } from "../components/ListPageUi";
import { SkeletonCards, SkeletonTable } from "../components/Skeleton";
import { nowrap } from "../features/dashboard/DashUi";
import { Icon } from "../shell/Icon";
import { TenantStatusPill } from "./saUi";
import { useAccessAs, useTenants } from "./SuperAdminProvider";
import type { TenantSummary } from "./types";

export function TenantsListPage() {
  const tenants = useTenants();
  const accessAs = useAccessAs();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "suspended">("");

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

  const items = tenants.data ?? [];
  const counts = useMemo(
    () => ({
      total: items.length,
      active: items.filter((t) => t.status === "active").length,
      suspended: items.filter((t) => t.status === "suspended").length,
      employees: items.reduce((n, t) => n + t.employee_count, 0),
    }),
    [items],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (t) =>
        (!status || t.status === status) &&
        (!needle || t.name.toLowerCase().includes(needle) || t.schema_name.toLowerCase().includes(needle)),
    );
  }, [items, q, status]);
  const filtered = q !== "" || status !== "";

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tenants</h1>
          <p className="page-sub">Every organisation on this deployment — open one for details, or Access as to operate inside it.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate("/super-admin/provision")}>
            <Icon name="plus" size={13} />
            Provision tenant
          </button>
        </div>
      </div>

      {tenants.isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <SkeletonCards count={3} />
          <SkeletonTable rows={4} cols={6} />
        </div>
      ) : tenants.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title="Couldn't load tenants"
            body="The tenant registry did not respond. Check the backend and try again."
            actions={
              <button type="button" className="btn" onClick={() => void tenants.refetch()}>
                Retry
              </button>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<Icon name="plus" size={28} />}
            title="No tenants yet"
            body="Provision the first tenant to create its schema, default roles and first Admin user."
            actions={
              <button type="button" className="btn btn-primary" onClick={() => navigate("/super-admin/provision")}>
                Provision tenant
              </button>
            }
          />
        </div>
      ) : (
        <>
          <StatGrid>
            <StatCard
              tone="info"
              icon={<><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4" /></>}
              label="All tenants"
              value={counts.total}
              sub={`${counts.employees.toLocaleString()} employees in total`}
              active={status === ""}
              onClick={() => setStatus("")}
            />
            <StatCard
              tone="success"
              icon={<path d="M20 6 9 17l-5-5" />}
              label="Active"
              value={counts.active}
              sub="logins allowed"
              active={status === "active"}
              onClick={() => setStatus(status === "active" ? "" : "active")}
            />
            <StatCard
              tone="danger"
              icon={<><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>}
              label="Suspended"
              value={counts.suspended}
              sub="logins blocked"
              active={status === "suspended"}
              onClick={() => setStatus(status === "suspended" ? "" : "suspended")}
            />
          </StatGrid>

          <Toolbar>
            <SearchField value={q} onChange={setQ} placeholder="Search by name or slug" clearLabel="Clear search" />
            <FilterSelect
              label="Status"
              value={status}
              onChange={(v) => setStatus(v as typeof status)}
              options={[
                ["", "All status"],
                ["active", "Active"],
                ["suspended", "Suspended"],
              ]}
            />
            <ResetButton
              active={filtered}
              label="Reset"
              onClick={() => {
                setQ("");
                setStatus("");
              }}
            />
          </Toolbar>

          <div className="card">
            {shown.length === 0 ? (
              <EmptyPanel
                icon={<Icon name="search" size={28} />}
                title="No tenants match"
                body="Nothing matches the current search or status filter."
                actions={
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setQ("");
                      setStatus("");
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Slug</th>
                      <th>Created</th>
                      <th className="sa-end">Admins</th>
                      <th className="sa-end">Employees</th>
                      <th>Status</th>
                      <th className="sa-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((t) => (
                      <tr key={t.id}>
                        <td style={nowrap}>
                          <Link to={`/super-admin/tenants/${t.id}`} className="sa-link">
                            {t.name || <span className="sa-muted">(unnamed)</span>}
                          </Link>
                        </td>
                        <td className="mono text-sm sa-secondary" style={nowrap}>
                          {t.schema_name}
                        </td>
                        <td className="text-sm sa-secondary" style={nowrap}>
                          {new Date(t.created_at).toLocaleDateString()}
                        </td>
                        <td className="mono text-sm sa-end">{t.admin_count}</td>
                        <td className="mono text-sm sa-end">{t.employee_count.toLocaleString()}</td>
                        <td>
                          <TenantStatusPill status={t.status} />
                        </td>
                        <td className="sa-end" style={nowrap}>
                          <div className="sa-row-actions">
                            <Link to={`/super-admin/tenants/${t.id}`} className="btn btn-sm btn-ghost">
                              Details
                            </Link>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => onAccessAs(t)}
                              disabled={t.status !== "active" || accessAs.isPending}
                              title={
                                t.status !== "active"
                                  ? "Tenant is suspended — unsuspend before impersonating"
                                  : "Impersonate this tenant"
                              }
                            >
                              Access as
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
