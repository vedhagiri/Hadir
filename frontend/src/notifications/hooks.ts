// TanStack Query hooks for the notifications subsystem.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  AttendanceEmailConfig,
  AttendanceEmailLogResponse,
  NotificationCategory,
  NotificationListResponse,
  PreferenceListResponse,
} from "./types";

const LIST_KEY = ["notifications"] as const;
const PREFS_KEY = ["notification-preferences"] as const;
const ATT_EMAIL_CONFIG_KEY = ["attendance-email-config"] as const;
const ATT_EMAIL_LOG_KEY = ["attendance-email-log"] as const;


export function useNotifications(
  limit = 20,
): UseQueryResult<NotificationListResponse, Error> {
  return useQuery({
    queryKey: [...LIST_KEY, limit],
    queryFn: () =>
      api<NotificationListResponse>(`/api/notifications?limit=${limit}`),
    // Light polling so the bell stays roughly accurate without
    // websockets. Pauses while the tab is hidden.
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
    refetchOnWindowFocus: true,
  });
}


export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/notifications/${id}/mark-read`, {
        method: "POST",
        body: {},
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}


export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ marked: number }>("/api/notifications/mark-all-read", {
        method: "POST",
        body: {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}


export function useNotificationPreferences(): UseQueryResult<
  PreferenceListResponse,
  Error
> {
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: () =>
      api<PreferenceListResponse>("/api/notification-preferences"),
    staleTime: 60 * 1000,
  });
}


export function usePatchPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      category: NotificationCategory;
      in_app: boolean;
      email: boolean;
    }) =>
      api<PreferenceListResponse>("/api/notification-preferences", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PREFS_KEY }),
  });
}


// --- Attendance status emails (0080) ---------------------------------------


export function useAttendanceEmailConfig(
  enabled: boolean,
): UseQueryResult<AttendanceEmailConfig, Error> {
  return useQuery({
    queryKey: ATT_EMAIL_CONFIG_KEY,
    queryFn: () => api<AttendanceEmailConfig>("/api/attendance-email-config"),
    staleTime: 60 * 1000,
    enabled,
  });
}


export function usePutAttendanceEmailConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AttendanceEmailConfig) =>
      api<AttendanceEmailConfig>("/api/attendance-email-config", {
        method: "PUT",
        body: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ATT_EMAIL_CONFIG_KEY });
      void qc.invalidateQueries({ queryKey: ATT_EMAIL_LOG_KEY });
    },
  });
}


export function useAttendanceEmailLog(
  enabled: boolean,
  pageSize = 25,
): UseQueryResult<AttendanceEmailLogResponse, Error> {
  return useQuery({
    queryKey: [...ATT_EMAIL_LOG_KEY, pageSize],
    queryFn: () =>
      api<AttendanceEmailLogResponse>(
        `/api/attendance-email-log?page=1&page_size=${pageSize}`,
      ),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
    enabled,
  });
}
