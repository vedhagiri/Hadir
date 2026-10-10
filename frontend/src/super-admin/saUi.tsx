// Small shared bits for the Super-Admin console pages. The console's
// red operator accent lives in ./sa.css (scoped to .sa-shell), so pages
// use the ordinary design classes (btn-primary, pills, stat cards).

import { SoftPill } from "../features/dashboard/DashUi";

import "./sa.css";

export function TenantStatusPill({ status }: { status: "active" | "suspended" }) {
  return status === "active" ? <SoftPill tone="success">Active</SoftPill> : <SoftPill tone="danger">Suspended</SoftPill>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sa-section-label">{children}</div>;
}
