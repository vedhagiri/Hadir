// TanStack Query hooks for the email config + report schedules pages.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  EmailConfig,
  EmailConfigUpdate,
  ReportRun,
  ReportSchedule,
  ReportScheduleCreateInput,
  ReportSchedulePatchInput,
} from "./types";

const EMAIL_KEY = ["email-config"] as const;
const SCHEDULES_KEY = ["report-schedules"] as const;
const RUNS_KEY = ["report-runs"] as const;

// ---- Email config --------------------------------------------------------

export function useEmailConfig(): UseQueryResult<EmailConfig, Error> {
  return useQuery({
    queryKey: EMAIL_KEY,
    queryFn: () => api<EmailConfig>("/api/email-config"),
    staleTime: 60 * 1000,
  });
}

export function usePatchEmailConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailConfigUpdate) =>
      api<EmailConfig>("/api/email-config", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: EMAIL_KEY }),
  });
}

export function useSendTestEmail() {
  return useMutation({
    mutationFn: (to: string) =>
      api<{ ok: boolean }>("/api/email-config/test", {
        method: "POST",
        body: { to },
      }),
  });
}

// ---- Schedules -----------------------------------------------------------

export function useReportSchedules(): UseQueryResult<
  ReportSchedule[],
  Error
> {
  return useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => api<ReportSchedule[]>("/api/report-schedules"),
    staleTime: 30 * 1000,
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReportScheduleCreateInput) =>
      api<ReportSchedule>("/api/report-schedules", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function usePatchSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: ReportSchedulePatchInput;
    }) =>
      api<ReportSchedule>(`/api/report-schedules/${id}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await api<null>(`/api/report-schedules/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      qc.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
}

export function useRunNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<ReportRun>(`/api/report-schedules/${id}/run-now`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      qc.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
}

// ---- Runs ---------------------------------------------------------------

export function useReportRuns(scheduleId?: number | null) {
  const qs = scheduleId ? `?schedule_id=${scheduleId}` : "";
  return useQuery({
    queryKey: [...RUNS_KEY, scheduleId ?? "all"],
    queryFn: () => api<ReportRun[]>(`/api/report-runs${qs}`),
    staleTime: 30 * 1000,
  });
}
