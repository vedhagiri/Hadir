// TanStack Query hooks for the operations endpoints.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  CameraErrorsResponse,
  CameraMetadataPatch,
  RestartAllAndRecoverResult,
  RestartAllResult,
  RestartResult,
  WorkersListResponse,
} from "./types";

export function useWorkers(): UseQueryResult<WorkersListResponse, Error> {
  return useQuery({
    queryKey: ["operations", "workers"],
    queryFn: () => api<WorkersListResponse>("/api/operations/workers"),
    // Five-second poll keeps the page responsive without flooding
    // the backend (each refetch is a few KB).
    refetchInterval: 5000,
    staleTime: 4000,
  });
}

export function useRestartWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cameraId: number): Promise<RestartResult> => {
      return api<RestartResult>(
        `/api/operations/workers/${cameraId}/restart`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}

export function useRestartAllWorkers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RestartAllResult> => {
      return api<RestartAllResult>(
        "/api/operations/workers/restart-all",
        { method: "POST" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}

// Broader "Restart All Workers" — restarts capture workers + clip
// pipeline + reprocess worker AND triggers an immediate recovery
// sweep. Returns the recovery class A/B/C counts so the UI can
// surface what was reclaimed.
export function useRestartAllAndRecover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RestartAllAndRecoverResult> => {
      return api<RestartAllAndRecoverResult>(
        "/api/operations/workers/restart-all-and-recover",
        { method: "POST" },
      );
    },
    onSuccess: () => {
      // Invalidate every surface the operator might compare against
      // after a recovery sweep: worker dashboard, Pipeline Monitor,
      // person-clips list (recording_status flips), clip-pipeline
      // batches table.
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
      qc.invalidateQueries({ queryKey: ["pipeline-monitor"] });
      qc.invalidateQueries({ queryKey: ["person-clips"] });
      qc.invalidateQueries({ queryKey: ["clip-pipeline"] });
    },
  });
}

export function useWorkerErrors(
  cameraId: number | null,
): UseQueryResult<CameraErrorsResponse, Error> {
  return useQuery({
    queryKey: ["operations", "worker-errors", cameraId],
    queryFn: () =>
      api<CameraErrorsResponse>(
        `/api/operations/workers/${cameraId}/errors`,
      ),
    enabled: cameraId !== null,
  });
}

export function usePatchCameraMetadata() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      cameraId: number;
      patch: CameraMetadataPatch;
    }) => {
      return api(`/api/cameras/${args.cameraId}/metadata`, {
        method: "PATCH",
        body: args.patch,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
      qc.invalidateQueries({ queryKey: ["cameras", "list"] });
    },
  });
}
