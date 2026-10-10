import { useQueries, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type { DetectionEventFilters, DetectionEventListResponse } from "./types";

function buildParams(
  filters: Pick<DetectionEventFilters, "camera_id" | "employee_id" | "identified" | "start" | "end">,
  formerOnly: boolean,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.employee_id !== null) params.set("employee_id", String(filters.employee_id));
  if (filters.identified !== null) params.set("identified", String(filters.identified));
  if (formerOnly) params.set("former_only", "true");
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  return params;
}

export function useDetectionEvents(
  filters: DetectionEventFilters,
  options?: { formerOnly?: boolean },
): UseQueryResult<DetectionEventListResponse, Error> {
  const params = buildParams(filters, options?.formerOnly ?? false);
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/detection-events?${params.toString()}`;
  return useQuery({
    queryKey: ["detection-events", filters, options?.formerOnly ?? false],
    queryFn: () => api<DetectionEventListResponse>(path),
    // Capture workers run independently of any viewer (worker_enabled
    // gates the pipeline; live preview is a separate display surface).
    // Camera Logs needs to surface fresh rows without the user
    // navigating away — poll every 5 s, mirroring the Workers page
    // (P28.8). Pause when the tab is in the background.
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 5 * 1000,
  });
}

/** Count-only filter: the list endpoint with ``page_size=1`` — we only
 *  read ``total``. Used for the summary cards and the per-day headers
 *  (the API has no aggregate endpoint; no backend change needed). */
export interface CountFilter {
  camera_id: number | null;
  identified: boolean | null;
  formerOnly: boolean;
  start: string | null;
  end: string | null;
}

function countPath(f: CountFilter): string {
  const params = buildParams(
    { camera_id: f.camera_id, employee_id: null, identified: f.identified, start: f.start, end: f.end },
    f.formerOnly,
  );
  params.set("page", "1");
  params.set("page_size", "1");
  return `/api/detection-events?${params.toString()}`;
}

async function fetchCount(f: CountFilter): Promise<number> {
  const r = await api<DetectionEventListResponse>(countPath(f));
  return r.total;
}

/** Several counts at once (summary cards / day headers). Polls slower
 *  than the list — the numbers are context, not the live feed. */
export function useDetectionEventCounts(list: CountFilter[]): UseQueryResult<number, Error>[] {
  return useQueries({
    queries: list.map((f) => ({
      queryKey: ["detection-events", "count", f],
      queryFn: () => fetchCount(f),
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      staleTime: 10_000,
    })),
  });
}

export function useCameraOptions(): UseQueryResult<{ items: Camera[] }, Error> {
  return useQuery({
    queryKey: ["camera-logs", "camera-options"],
    queryFn: () => api<{ items: Camera[] }>("/api/cameras"),
    staleTime: 60 * 1000,
  });
}
