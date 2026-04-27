// TanStack Query hooks for the operations endpoints.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  CameraErrorsResponse,
  CameraMetadataPatch,
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
