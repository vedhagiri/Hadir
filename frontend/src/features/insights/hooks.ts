// TanStack Query hooks for the three Insights endpoints. Shared by the
// Overview, Departments and People pages.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  InsightsDepartment,
  InsightsEmployee,
  InsightsOverview,
  InsightsPeople,
  InsightsPeopleQuery,
} from "./types";

export interface InsightsRange {
  start: string;
  end: string;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const STALE = 60 * 1000;

export function useInsightsOverview(
  range: InsightsRange,
  departmentId: number | null,
): UseQueryResult<InsightsOverview, Error> {
  return useQuery({
    queryKey: ["insights", "overview", range.start, range.end, departmentId],
    queryFn: () =>
      api<InsightsOverview>(
        `/api/insights/overview${qs({ start: range.start, end: range.end, department_id: departmentId })}`,
      ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useInsightsDepartment(
  departmentId: number | null,
  range: InsightsRange,
): UseQueryResult<InsightsDepartment, Error> {
  return useQuery({
    queryKey: ["insights", "department", departmentId, range.start, range.end],
    queryFn: () =>
      api<InsightsDepartment>(
        `/api/insights/departments/${departmentId}${qs({ start: range.start, end: range.end })}`,
      ),
    enabled: departmentId !== null,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useInsightsEmployee(
  employeeId: number | null,
  range: InsightsRange,
): UseQueryResult<InsightsEmployee, Error> {
  return useQuery({
    queryKey: ["insights", "employee", employeeId, range.start, range.end],
    queryFn: () =>
      api<InsightsEmployee>(
        `/api/insights/employees/${employeeId}${qs({ start: range.start, end: range.end })}`,
      ),
    enabled: employeeId !== null,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

/** GET /api/insights/people — per-employee summary for the People picker.
 *  ``range`` may be null to let the server default (this month to date). */
export function useInsightsPeople(
  range: InsightsRange | null,
  query: InsightsPeopleQuery = {},
): UseQueryResult<InsightsPeople, Error> {
  const params = {
    start: range?.start,
    end: range?.end,
    department_id: query.departmentId ?? null,
    q: query.q?.trim() || null,
    sort: query.sort ?? null,
    page: query.page ?? null,
    page_size: query.pageSize ?? null,
  };
  return useQuery({
    queryKey: ["insights", "people", params],
    queryFn: () => api<InsightsPeople>(`/api/insights/people${qs(params)}`),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}
