// TanStack Query hooks for cameras.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  Camera,
  CameraCreateInput,
  CameraListResponse,
  CameraPatchInput,
} from "./types";

const LIST_KEY = ["cameras", "list"] as const;

export function useCameras(): UseQueryResult<CameraListResponse, Error> {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api<CameraListResponse>("/api/cameras"),
    staleTime: 15 * 1000,
    // Poll every 30 s so the StatusDot's freshness window
    // (3 minutes against ``last_seen_at``) tracks live state
    // instead of flipping red on stale cached data.
    refetchInterval: 30 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CameraCreateInput) =>
      api<Camera>("/api/cameras", { method: "POST", body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      // Toggling worker/display/detection from the cameras list
      // changes capture-manager state (workers start, stop, or
      // hot-reload). Cross-invalidate so the Worker Monitoring page
      // colours flip immediately instead of waiting on its 5 s poll.
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}

export function usePatchCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CameraPatchInput }) =>
      api<Camera>(`/api/cameras/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      // Toggling worker/display/detection from the cameras list
      // changes capture-manager state (workers start, stop, or
      // hot-reload). Cross-invalidate so the Worker Monitoring page
      // colours flip immediately instead of waiting on its 5 s poll.
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}

export function useDeleteCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/cameras/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      // Toggling worker/display/detection from the cameras list
      // changes capture-manager state (workers start, stop, or
      // hot-reload). Cross-invalidate so the Worker Monitoring page
      // colours flip immediately instead of waiting on its 5 s poll.
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}
