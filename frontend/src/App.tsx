// Top-level route tree. Two top-level paths: /login (public) and /*
// (authenticated shell). The authenticated subtree registers one route
// per NAV id across every role — so deep-linking to ``/cameras`` works
// for an Admin and returns a 403-equivalent-from-UI experience (just a
// placeholder for now) for other roles. The backend remains the source
// of truth for authorisation; the sidebar only hides links.

import { Navigate, Route, Routes } from "react-router-dom";

import { LoginPage } from "./auth/LoginPage";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AuditLogPage } from "./features/audit-log/AuditLogPage";
import { CameraLogsPage } from "./features/camera-logs/CameraLogsPage";
import { CamerasPage } from "./features/cameras/CamerasPage";
import { EmployeesPage } from "./features/employees/EmployeesPage";
import { SystemPage } from "./features/system/SystemPage";
import { Placeholder } from "./pages/Placeholder";
import { Layout } from "./shell/Layout";
import { ALL_PAGE_IDS } from "./shell/nav";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="cameras" element={<CamerasPage />} />
        <Route path="camera-logs" element={<CameraLogsPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        {ALL_PAGE_IDS.filter(
          (id) =>
            id !== "employees" &&
            id !== "cameras" &&
            id !== "camera-logs" &&
            id !== "system" &&
            id !== "audit",
        ).map((id) => (
          <Route key={id} path={id} element={<Placeholder pageId={id} />} />
        ))}
        <Route path="*" element={<Placeholder pageId="dashboard" />} />
      </Route>
    </Routes>
  );
}
