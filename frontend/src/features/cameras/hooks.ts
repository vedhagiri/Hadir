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
  });
}

export function useCreateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CameraCreateInput) =>
      api<Camera>("/api/cameras", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function usePatchCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CameraPatchInput }) =>
      api<Camera>(`/api/cameras/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useDeleteCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/cameras/${id}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}
