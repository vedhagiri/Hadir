// Top-level route tree. Two top-level paths: /login (public) and /*
// (authenticated shell). The authenticated subtree registers one route
// per NAV id across every role — so deep-linking to ``/cameras`` works
// for an Admin and returns a 403-equivalent-from-UI experience (just a
// placeholder for now) for other roles. The backend remains the source
// of truth for authorisation; the sidebar only hides links.

import { Navigate, Route, Routes } from "react-router-dom";

import { LoginPage } from "./auth/LoginPage";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AuthenticationPage } from "./auth-oidc/AuthenticationPage";
import { BrandingPage } from "./branding/BrandingPage";
import { CustomFieldsPage } from "./custom-fields/CustomFieldsPage";
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
import { DashboardRouter } from "./features/dashboard/DashboardRouter";
import { EmployeesPage } from "./features/employees/EmployeesPage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { SystemPage } from "./features/system/SystemPage";
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
        <Route path="system" element={<SystemPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="daily-attendance" element={<DailyAttendancePage />} />
        <Route path="team-attendance" element={<DailyAttendancePage />} />
        <Route path="my-attendance" element={<MyAttendancePage />} />
        <Route path="attendance/me" element={<MyAttendancePage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="mgr-assign" element={<ManagerAssignmentsPage />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="leave-policy" element={<LeaveCalendarPage />} />
        <Route path="settings" element={<Navigate to="/settings/branding" replace />} />
        <Route path="settings/branding" element={<BrandingPage />} />
        <Route path="settings/authentication" element={<AuthenticationPage />} />
        <Route path="settings/custom-fields" element={<CustomFieldsPage />} />
        <Route path="settings/reason-categories" element={<ReasonCategoriesPage />} />
        <Route path="settings/email" element={<EmailConfigPage />} />
        <Route path="settings/schedules" element={<SchedulesPage />} />
        <Route path="settings/erp-export" element={<ErpExportPage />} />
        <Route path="settings/notifications" element={<NotificationPreferencesPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="my-requests" element={<MyRequestsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        {ALL_PAGE_IDS.filter(
          (id) =>
            id !== "dashboard" &&
            id !== "employees" &&
            id !== "cameras" &&
            id !== "camera-logs" &&
            id !== "system" &&
            id !== "audit" &&
            id !== "daily-attendance" &&
            id !== "team-attendance" &&
            id !== "my-attendance" &&
            id !== "reports" &&
            id !== "settings" &&
            id !== "mgr-assign" &&
            id !== "policies" &&
            id !== "leave-policy" &&
            id !== "my-requests" &&
            id !== "approvals",
        ).map((id) => (
          <Route key={id} path={id} element={<Placeholder pageId={id} />} />
        ))}
        <Route path="*" element={<Placeholder pageId="dashboard" />} />
      </Route>
    </Routes>
  );
}
