// TanStack Query hooks for the attendance calendar (P28.6).

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  CompanyMonth,
  DayDetail,
  PersonMonth,
} from "./types";

export function useCompanyCalendar(
  month: string,
  enabled = true,
): UseQueryResult<CompanyMonth, Error> {
  return useQuery({
    queryKey: ["calendar", "company", month],
    queryFn: () =>
      api<CompanyMonth>(`/api/attendance/calendar/company?month=${month}`),
    enabled,
    staleTime: 60 * 1000,
  });
}

export function usePersonCalendar(
  employeeId: number | null,
  month: string,
): UseQueryResult<PersonMonth, Error> {
  return useQuery({
    queryKey: ["calendar", "person", employeeId, month],
    queryFn: () =>
      api<PersonMonth>(
        `/api/attendance/calendar/person/${employeeId}?month=${month}`,
      ),
    enabled: employeeId !== null,
    staleTime: 60 * 1000,
  });
}

export function useDayDetail(
  employeeId: number | null,
  isoDate: string | null,
): UseQueryResult<DayDetail, Error> {
  return useQuery({
    queryKey: ["calendar", "day", employeeId, isoDate],
    queryFn: () =>
      api<DayDetail>(`/api/attendance/calendar/day/${employeeId}/${isoDate}`),
    enabled: employeeId !== null && isoDate !== null,
    staleTime: 30 * 1000,
  });
}
