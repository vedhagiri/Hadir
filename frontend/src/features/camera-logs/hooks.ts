import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type { DetectionEventFilters, DetectionEventListResponse } from "./types";

export function useDetectionEvents(
  filters: DetectionEventFilters,
): UseQueryResult<DetectionEventListResponse, Error> {
  const params = new URLSearchParams();
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.employee_id !== null) params.set("employee_id", String(filters.employee_id));
  if (filters.identified !== null) params.set("identified", String(filters.identified));
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/detection-events?${params.toString()}`;
  return useQuery({
    queryKey: ["detection-events", filters],
    queryFn: () => api<DetectionEventListResponse>(path),
    staleTime: 15 * 1000,
  });
}

export function useCameraOptions(): UseQueryResult<{ items: Camera[] }, Error> {
  return useQuery({
    queryKey: ["camera-logs", "camera-options"],
    queryFn: () => api<{ items: Camera[] }>("/api/cameras"),
    staleTime: 60 * 1000,
  });
}
