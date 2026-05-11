import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type {
  ByClipFilters,
  ClipsProcessingStatus,
  FaceCropFilters,
  FaceCropListResponse,
  FaceCropStats,
  FaceCropsByClipResponse,
  ProcessResult,
} from "./types";

const LIST_KEY = ["face-crops", "list"] as const;
const BY_CLIP_KEY = ["face-crops", "by-clip"] as const;
const STATS_KEY = ["face-crops", "stats"] as const;
const CLIPS_STATUS_KEY = ["face-crops", "clips-status"] as const;

export function useFaceCrops(
  filters: FaceCropFilters,
): UseQueryResult<FaceCropListResponse, Error> {
  const params = new URLSearchParams();
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.person_clip_id !== null) params.set("person_clip_id", String(filters.person_clip_id));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/face-crops?${params.toString()}`;
  return useQuery({
    queryKey: [...LIST_KEY, filters],
    queryFn: () => api<FaceCropListResponse>(path),
    staleTime: 10 * 1000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useFaceCropsByClip(
  filters: ByClipFilters,
): UseQueryResult<FaceCropsByClipResponse, Error> {
  const params = new URLSearchParams();
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/face-crops/by-clip?${params.toString()}`;
  return useQuery({
    queryKey: [...BY_CLIP_KEY, filters],
    queryFn: () => api<FaceCropsByClipResponse>(path),
    staleTime: 10 * 1000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useFaceCropStats(): UseQueryResult<FaceCropStats, Error> {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn: () => api<FaceCropStats>("/api/face-crops/stats"),
    staleTime: 30 * 1000,
  });
}

export function useCameraOptions(): UseQueryResult<{ items: Camera[] }, Error> {
  return useQuery({
    queryKey: ["face-crops", "camera-options"],
    queryFn: () => api<{ items: Camera[] }>("/api/cameras"),
    staleTime: 60 * 1000,
  });
}

export function useClipsProcessingStatus(): UseQueryResult<ClipsProcessingStatus, Error> {
  return useQuery({
    queryKey: CLIPS_STATUS_KEY,
    queryFn: () => api<ClipsProcessingStatus>("/api/face-crops/clips-status"),
    staleTime: 5 * 1000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });
}

export function useStartProcessing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { camera_id?: number; reprocess?: boolean }) => {
      const search = new URLSearchParams();
      if (params.camera_id) search.set("camera_id", String(params.camera_id));
      if (params.reprocess) search.set("reprocess", "true");
      const qs = search.toString();
      return api<ProcessResult>(`/api/face-crops/process${qs ? `?${qs}` : ""}`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CLIPS_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: STATS_KEY });
      queryClient.invalidateQueries({ queryKey: LIST_KEY });
      queryClient.invalidateQueries({ queryKey: BY_CLIP_KEY });
    },
  });
}
