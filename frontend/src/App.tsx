// Top-level route tree. Two top-level paths: /login (public) and /*
// (authenticated shell). The authenticated subtree registers one route
// per NAV id across every role — so deep-linking to ``/cameras`` works
// for an Admin and returns a 403-equivalent-from-UI experience (just a
// placeholder for now) for other roles. The backend remains the source
// of truth for authorisation; the sidebar only hides links.

import { Navigate, Route, Routes } from "react-router-dom";

import { LoginPage } from "./auth/LoginPage";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { useMe } from "./auth/AuthProvider";
import { ApiDocsPage } from "./features/api-docs/ApiDocsPage";
import { PipelinePage } from "./features/pipeline/PipelinePage";
import { AuthenticationPage } from "./auth-oidc/AuthenticationPage";
import { BrandingPage } from "./branding/BrandingPage";
import { CustomFieldsPage } from "./custom-fields/CustomFieldsPage";
import { DepartmentsPage } from "./settings/DepartmentsPage";
import { DivisionsPage } from "./settings/DivisionsPage";
import { SectionsPage } from "./settings/SectionsPage";
import { DisplaySettingsPage } from "./settings/DisplaySettingsPage";
import { WorkspacePage } from "./settings/WorkspacePage";
import { ErpExportPage } from "./erp-export/ErpExportPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { NotificationPreferencesPage } from "./notifications/PreferencesPage";
import { ApprovalsPage } from "./requests/ApprovalsPage";
import { MyRequestsPage } from "./requests/MyRequestsPage";
import { ReasonCategoriesPage } from "./requests/ReasonCategoriesPage";
import { EmailConfigPage } from "./scheduled-reports/EmailConfigPage";
import { SchedulesPage } from "./scheduled-reports/SchedulesPage";
import { AuditLogPage } from "./features/audit-log/AuditLogPage";
import { DailyAttendancePage } from "./features/attendance/DailyAttendancePage";
import { MyAttendancePage } from "./features/attendance/MyAttendancePage";
import { CameraLogsPage } from "./features/camera-logs/CameraLogsPage";
import { CamerasPage } from "./features/cameras/CamerasPage";
import { FaceCropsPage } from "./features/face-crops/FaceCropsPage";
import { PersonClipsPage } from "./features/person-clips/PersonClipsPage";
import { ClipAnalyticsPage } from "./features/clip-analytics/ClipAnalyticsPage";
import { DashboardRouter } from "./features/dashboard/DashboardRouter";
import { EmployeesPage } from "./features/employees/EmployeesPage";
import { MyProfilePage } from "./features/employees/MyProfilePage";
import { MyTeamPage } from "./features/employees/MyTeamPage";
import { PhotoApprovalsPage } from "./features/employees/PhotoApprovalsPage";
import { CalendarPage } from "./features/calendar/CalendarPage";
import { WorkersPage } from "./features/operations/WorkersPage";
import { EmployeeReportPage } from "./features/reports/EmployeeReportPage";
import { FormerEmployeesSeenReport } from "./features/reports/FormerEmployeesSeenReport";
import { ReportsPage } from "./features/reports/ReportsPage";
import { SystemPage as SuperAdminSystemPage } from "./super-admin/SystemPage";
import { SystemPage } from "./features/system/SystemPage";
import { LiveCapturePage } from "./pages/LiveCapture/LiveCapture";
import { PipelineMonitor } from "./pages/PipelineMonitor/PipelineMonitor";
import { SystemSettingsPage } from "./pages/SystemSettings/SystemSettingsPage";
import { LeaveCalendarPage } from "./leave-calendar/LeaveCalendarPage";
import { ManagerAssignmentsPage } from "./manager-assignments/ManagerAssignmentsPage";
import { Placeholder } from "./pages/Placeholder";
import { PoliciesPage } from "./policies/PoliciesPage";
import { Layout } from "./shell/Layout";
import { ALL_PAGE_IDS } from "./shell/nav";
import { ProvisionTenantPage } from "./super-admin/ProvisionTenantPage";
import { SuperAdminLayout } from "./super-admin/SuperAdminLayout";
import { SuperAdminLogin } from "./super-admin/SuperAdminLogin";
import { SuperAdminProtectedRoute } from "./super-admin/SuperAdminProtectedRoute";
import { TenantDetailPage } from "./super-admin/TenantDetailPage";
import { TenantsListPage } from "./super-admin/TenantsListPage";

/** P22: Admin-only gate for the API Reference page. The backend
 *  serves /api/docs to anyone authenticated, so the gate here is a
 *  UX guard, not a security boundary — operators on Manager / HR /
 *  Employee shouldn't reach this URL through the sidebar.
 */
function AdminOnly({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return null;
  if (me.data?.active_role !== "Admin") {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

/** Role-aware redirect for the Settings hub: Admin → workspace,
 *  HR → divisions, Manager/Employee → display preferences.
 *  BUG-050 — previously Manager/Employee got redirected back to the
 *  dashboard which made the topbar "Settings" link look broken. */
function SettingsRedirect() {
  const me = useMe();
  if (me.isLoading) return null;
  const role = me.data?.active_role;
  if (role === "Admin") return <Navigate to="/settings/workspace" replace />;
  if (role === "HR") return <Navigate to="/settings/divisions" replace />;
  // Manager + Employee land on Display — the only per-user settings
  // page they can access (theme / density / language). The Settings
  // sub-nav (SettingsTabs) hides admin-only tabs for them.
  return <Navigate to="/settings/display" replace />;
}

/** Settings tabs that stay Admin-only — branding, OIDC, email
 *  credentials, schedules, ERP export, notifications config,
 *  display defaults, custom fields, reason categories, workspace.
 *  HR navigating to these via direct URL gets bounced back to
 *  the dashboard. */
function SettingsAdminOnly({ children }: { children: React.ReactNode }) {
  return <AdminOnly>{children}</AdminOnly>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/super-admin/login" element={<SuperAdminLogin />} />
      <Route
        path="/super-admin"
        element={
          <SuperAdminProtectedRoute>
            <SuperAdminLayout />
          </SuperAdminProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/super-admin/tenants" replace />} />
        <Route path="tenants" element={<TenantsListPage />} />
        <Route path="system" element={<SuperAdminSystemPage />} />
        <Route path="tenants/:tenantId" element={<TenantDetailPage />} />
        <Route path="provision" element={<ProvisionTenantPage />} />
      </Route>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardRouter />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="cameras" element={<CamerasPage />} />
        <Route path="camera-logs" element={<CameraLogsPage />} />
        <Route path="person-clips" element={<PersonClipsPage />} />
        <Route path="clip-analytics" element={<ClipAnalyticsPage />} />
        <Route path="face-crops" element={<FaceCropsPage />} />
        <Route path="live" element={<LiveCapturePage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="system-settings" element={<SystemSettingsPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="daily-attendance" element={<DailyAttendancePage />} />
        <Route path="team-attendance" element={<DailyAttendancePage />} />
        <Route path="my-attendance" element={<MyAttendancePage />} />
        <Route path="attendance/me" element={<MyAttendancePage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="employee-report" element={<EmployeeReportPage />} />
        <Route path="former-employees" element={<FormerEmployeesSeenReport />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="operations/workers" element={<WorkersPage />} />
        <Route path="pipeline-monitor" element={<AdminOnly><PipelineMonitor /></AdminOnly>} />
        <Route path="mgr-assign" element={<ManagerAssignmentsPage />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="leave-policy" element={<LeaveCalendarPage />} />
        <Route path="settings" element={<SettingsRedirect />} />
        <Route path="settings/workspace" element={<SettingsAdminOnly><WorkspacePage /></SettingsAdminOnly>} />
        <Route path="settings/branding" element={<SettingsAdminOnly><BrandingPage /></SettingsAdminOnly>} />
        <Route path="settings/authentication" element={<SettingsAdminOnly><AuthenticationPage /></SettingsAdminOnly>} />
        <Route path="settings/departments" element={<DepartmentsPage />} />
        <Route path="settings/divisions" element={<DivisionsPage />} />
        <Route path="settings/sections" element={<SectionsPage />} />
        <Route path="settings/custom-fields" element={<SettingsAdminOnly><CustomFieldsPage /></SettingsAdminOnly>} />
        <Route path="settings/reason-categories" element={<SettingsAdminOnly><ReasonCategoriesPage /></SettingsAdminOnly>} />
        <Route path="settings/email" element={<SettingsAdminOnly><EmailConfigPage /></SettingsAdminOnly>} />
        <Route path="settings/schedules" element={<SettingsAdminOnly><SchedulesPage /></SettingsAdminOnly>} />
        <Route path="settings/erp-export" element={<SettingsAdminOnly><ErpExportPage /></SettingsAdminOnly>} />
        {/* BUG-050 — Display + Notifications are per-user preferences,
            not admin surfaces. Allow Manager / Employee through so the
            topbar Settings link doesn't bounce them to the dashboard. */}
        <Route path="settings/notifications" element={<NotificationPreferencesPage />} />
        <Route path="settings/display" element={<DisplaySettingsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="my-requests" element={<MyRequestsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="my-team" element={<MyTeamPage />} />
        <Route path="my-profile" element={<MyProfilePage />} />
        <Route path="photo-approvals" element={<PhotoApprovalsPage />} />
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="api-docs" element={<AdminOnly><ApiDocsPage /></AdminOnly>} />
        {ALL_PAGE_IDS.filter(
          (id) =>
            id !== "dashboard" &&
            id !== "employees" &&
            id !== "my-team" &&
            id !== "my-profile" &&
            id !== "photo-approvals" &&
            id !== "cameras" &&
            id !== "camera-logs" &&
            id !== "person-clips" &&
            id !== "clip-analytics" &&
            id !== "face-crops" &&
            id !== "live" &&
            id !== "system" &&
            id !== "audit" &&
            id !== "daily-attendance" &&
            id !== "team-attendance" &&
            id !== "my-attendance" &&
            id !== "reports" &&
            id !== "employee-report" &&
            id !== "calendar" &&
            id !== "former-employees" &&
            id !== "operations/workers" &&
            id !== "pipeline-monitor" &&
            id !== "settings" &&
            id !== "mgr-assign" &&
            id !== "policies" &&
            id !== "leave-policy" &&
            id !== "my-requests" &&
            id !== "approvals" &&
            id !== "pipeline" &&
            id !== "api-docs",
        ).map((id) => (
          <Route key={id} path={id} element={<Placeholder pageId={id} />} />
        ))}
        <Route path="*" element={<Placeholder pageId="dashboard" />} />
      </Route>
    </Routes>
  );
}
