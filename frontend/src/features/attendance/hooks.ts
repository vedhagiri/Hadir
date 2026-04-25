import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { DetectionEventListResponse } from "../camera-logs/types";
import type { AttendanceListResponse } from "./types";

export function useAttendance(
  date: string | null,
  departmentId: number | null,
): UseQueryResult<AttendanceListResponse, Error> {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (departmentId !== null) params.set("department_id", String(departmentId));
  const path =
    params.toString().length > 0
      ? `/api/attendance?${params.toString()}`
      : "/api/attendance";
  return useQuery({
    queryKey: ["attendance", date, departmentId],
    queryFn: () => api<AttendanceListResponse>(path),
    staleTime: 30 * 1000,
  });
}

export function useMyRecentAttendance(
  days: number,
): UseQueryResult<AttendanceListResponse, Error> {
  return useQuery({
    queryKey: ["attendance", "me", days],
    queryFn: () =>
      api<AttendanceListResponse>(`/api/attendance/me/recent?days=${days}`),
    staleTime: 30 * 1000,
  });
}

export function useEmployeeDayEvents(
  employeeId: number | null,
  isoDate: string | null,
): UseQueryResult<DetectionEventListResponse, Error> {
  return useQuery({
    queryKey: ["detection-events", "by-employee-day", employeeId, isoDate],
    queryFn: () => {
      // Local-day window. The backend filters captured_at; we send the
      // start/end of the day in the user's local time as ISO strings —
      // the timezone offset comes through and Postgres compares
      // correctly.
      const start = `${isoDate}T00:00:00`;
      const end = `${isoDate}T23:59:59`;
      const params = new URLSearchParams({
        employee_id: String(employeeId),
        start,
        end,
        page_size: "200",
      });
      return api<DetectionEventListResponse>(
        `/api/detection-events?${params.toString()}`,
      );
    },
    enabled: employeeId !== null && isoDate !== null,
  });
}
