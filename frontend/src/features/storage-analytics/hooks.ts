// TanStack Query hooks for storage analytics.

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { DaysWindow, StorageAnalyticsResponse } from "./types";

export interface StorageAnalyticsFilters {
  days: DaysWindow;
  camera_id: number | null;
}

export function useStorageAnalytics(
  filters: StorageAnalyticsFilters,
  options: { enabled?: boolean } = {},
): UseQueryResult<StorageAnalyticsResponse, Error> {
  const params = new URLSearchParams();
  params.set("days", String(filters.days));
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
