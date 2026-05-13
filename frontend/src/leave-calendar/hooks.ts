// TanStack Query hooks for the Leave & Calendar page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  ApprovedLeave,
  ApprovedLeaveCreateInput,
  Holiday,
  HolidayCreateInput,
  HolidayImportResponse,
  LeaveType,
  LeaveTypeCreateInput,
  LeaveTypePatchInput,
  TenantSettings,
  TenantSettingsPatchInput,
} from "./types";

const LEAVE_TYPES_KEY = ["leave-calendar", "leave-types"] as const;
const HOLIDAYS_KEY = ["leave-calendar", "holidays"] as const;
const APPROVED_LEAVES_KEY = ["leave-calendar", "approved-leaves"] as const;
const SETTINGS_KEY = ["leave-calendar", "tenant-settings"] as const;

// ---- Leave types ---------------------------------------------------------

export function useLeaveTypes(): UseQueryResult<LeaveType[], Error> {
  return useQuery({
    queryKey: LEAVE_TYPES_KEY,
    queryFn: async () => api<LeaveType[]>("/api/leave-types"),
    staleTime: 60 * 1000,
  });
}

export function useCreateLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LeaveTypeCreateInput) =>
      api<LeaveType>("/api/leave-types", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEAVE_TYPES_KEY }),
  });
}

export function usePatchLeaveType(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LeaveTypePatchInput) =>
      api<LeaveType>(`/api/leave-types/${id}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEAVE_TYPES_KEY }),
  });
}

// BUG-043 — Leave Types had no delete option in the UI. Backend
// returns 409 when the type is still referenced by approved_leaves;
// the row caller surfaces that message.
export function useDeleteLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/leave-types/${id}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEAVE_TYPES_KEY }),
  });
}

// ---- Holidays ------------------------------------------------------------

export function useHolidays(year: number): UseQueryResult<Holiday[], Error> {
  return useQuery({
    queryKey: [...HOLIDAYS_KEY, year],
    queryFn: async () =>
      api<Holiday[]>(`/api/holidays?year=${encodeURIComponent(year)}`),
    staleTime: 30 * 1000,
  });
}

export function useCreateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: HolidayCreateInput) =>
      api<Holiday>("/api/holidays", { method: "POST", body: input }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: HOLIDAYS_KEY, exact: false }),
  });
}

export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/holidays/${id}`, { method: "DELETE" });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: HOLIDAYS_KEY, exact: false }),
  });
}

export function useImportHolidaysXlsx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<HolidayImportResponse> => {
      const fd = new FormData();
      fd.append("file", file);
      return api<HolidayImportResponse>("/api/holidays/import", {
        method: "POST",
        body: fd,
      });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: HOLIDAYS_KEY, exact: false }),
  });
}

// ---- Approved leaves -----------------------------------------------------

export function useApprovedLeaves(): UseQueryResult<ApprovedLeave[], Error> {
  return useQuery({
    queryKey: APPROVED_LEAVES_KEY,
    queryFn: async () => api<ApprovedLeave[]>("/api/approved-leaves"),
    staleTime: 30 * 1000,
  });
}

export function useCreateApprovedLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApprovedLeaveCreateInput) =>
      api<ApprovedLeave>("/api/approved-leaves", {
        method: "POST",
        body: input,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: APPROVED_LEAVES_KEY }),
  });
}

export function useDeleteApprovedLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/approved-leaves/${id}`, { method: "DELETE" });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: APPROVED_LEAVES_KEY }),
  });
}

// ---- Tenant settings -----------------------------------------------------

export function useTenantSettings(): UseQueryResult<TenantSettings, Error> {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => api<TenantSettings>("/api/tenant-settings"),
    staleTime: 60 * 1000,
  });
}

export function usePatchTenantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TenantSettingsPatchInput) =>
      api<TenantSettings>("/api/tenant-settings", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
}
