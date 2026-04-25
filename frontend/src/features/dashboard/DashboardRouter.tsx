// Picks the correct per-role dashboard based on the user's highest
// role. Pilot uses the highest-only rule from PROJECT_CONTEXT §8 — a
// full role switcher is deferred to v1.0.

import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { AdminDashboard } from "./AdminDashboard";
import { EmployeeDashboard } from "./EmployeeDashboard";
import { HrDashboard } from "./HrDashboard";
import { ManagerDashboard } from "./ManagerDashboard";

export function DashboardRouter() {
  const me = useMe();
  if (!me.data) return null;
  const role = primaryRole(me.data.roles);
  switch (role) {
    case "Admin":
      return <AdminDashboard />;
    case "HR":
      return <HrDashboard />;
    case "Manager":
      return <ManagerDashboard />;
    default:
      return <EmployeeDashboard />;
  }
}
