// TanStack Query hooks for storage analytics.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  AutoDeleteSetting,
  ClipCleanupFilter,
  ClipCleanupPreviewResponse,
  ClipCleanupRunResponse,
  ClipRetentionSetting,
  StorageAnalyticsResponse,
} from "./types";

export interface StorageAnalyticsFilters {
  days: number; // 0 = overall / all-time. Ignored when start+end are set.
  camera_id: number | null;
  start?: string; // YYYY-MM-DD — custom range start (requires end)
  end?: string; // YYYY-MM-DD — custom range end (requires start)
}

export function useStorageAnalytics(
  filters: StorageAnalyticsFilters,
  options: { enabled?: boolean } = {},
): UseQueryResult<StorageAnalyticsResponse, Error> {
  const params = new URLSearchParams();
  if (filters.start && filters.end) {
    params.set("start", filters.start);
    params.set("end", filters.end);
  } else {
    params.set("days", String(filters.days));
  }
  if (filters.camera_id !== null) {
    params.set("camera_id", String(filters.camera_id));
  }
  const path = `/api/storage-analytics?${params.toString()}`;

  return useQuery({
    queryKey: ["storage-analytics", filters],
    queryFn: () => api<StorageAnalyticsResponse>(path),
    staleTime: 60 * 1000,
    enabled: options.enabled ?? true,
  });
}

// ── Clip cleanup ─────────────────────────────────────────────────────────

export function useClipCleanupPreview(): UseMutationResult<
  ClipCleanupPreviewResponse,
  Error,
  ClipCleanupFilter
> {
  return useMutation({
    mutationFn: (filter) =>
      api<ClipCleanupPreviewResponse>(
        "/api/storage-analytics/clip-cleanup/preview",
        { method: "POST", body: filter },
      ),
  });
}

export function useRunClipCleanup(): UseMutationResult<
  ClipCleanupRunResponse,
  Error,
  ClipCleanupFilter
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filter) =>
      api<ClipCleanupRunResponse>("/api/storage-analytics/clip-cleanup", {
        method: "POST",
        body: filter,
      }),
    onSuccess: () => {
      // Refresh the aggregate so the overview cards reflect the new state.
      void qc.invalidateQueries({ queryKey: ["storage-analytics"] });
    },
  });
}

export function useClipRetentionSetting(
  options: { enabled?: boolean } = {},
): UseQueryResult<ClipRetentionSetting, Error> {
  return useQuery({
    queryKey: ["storage-analytics", "clip-retention"],
    queryFn: () =>
      api<ClipRetentionSetting>("/api/storage-analytics/clip-retention"),
    staleTime: 60 * 1000,
    enabled: options.enabled ?? true,
  });
}

export function useUpdateClipRetentionSetting(): UseMutationResult<
  ClipRetentionSetting,
  Error,
  { clip_retention_days: number | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      api<ClipRetentionSetting>("/api/storage-analytics/clip-retention", {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["storage-analytics", "clip-retention"],
      });
    },
  });
}

export function useAutoDeleteSetting(
  options: { enabled?: boolean } = {},
): UseQueryResult<AutoDeleteSetting, Error> {
  return useQuery({
    queryKey: ["storage-analytics", "auto-delete-setting"],
    queryFn: () =>
      api<AutoDeleteSetting>("/api/storage-analytics/auto-delete-setting"),
    staleTime: 60 * 1000,
    enabled: options.enabled ?? true,
  });
}

export function useUpdateAutoDeleteSetting(): UseMutationResult<
  AutoDeleteSetting,
  Error,
  { auto_delete_clip_after_processing: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      api<AutoDeleteSetting>("/api/storage-analytics/auto-delete-setting", {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["storage-analytics", "auto-delete-setting"],
      });
    },
  });
}
