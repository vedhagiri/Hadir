// Employee dashboard — own attendance today + last 7 days.
// Reuses the MyAttendancePage component verbatim so there's only one
// place to maintain "self-view" logic.

import { MyAttendancePage } from "../attendance/MyAttendancePage";

export function EmployeeDashboard() {
  return <MyAttendancePage />;
}
