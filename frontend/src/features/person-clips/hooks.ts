import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type {
  ClipProcessingResultsResponse,
  FaceCropListResponse,
  PersonClipFilters,
  PersonClipListResponse,
  PersonClipStats,
  ReprocessFaceMatchRequest,
  ReprocessFaceMatchResponse,
  ReprocessFaceMatchStatus,
  SingleClipReprocessRequest,
  SingleClipReprocessResponse,
  SystemStatsResponse,
} from "./types";

const LIST_KEY = ["person-clips", "list"] as const;
const STATS_KEY = ["person-clips", "stats"] as const;
const REPROCESS_STATUS_KEY = ["person-clips", "reprocess-status"] as const;
const SYSTEM_STATS_KEY = ["person-clips", "system-stats"] as const;

export function usePersonClips(
  filters: PersonClipFilters,
): UseQueryResult<PersonClipListResponse, Error> {
  const params = new URLSearchParams();
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.employee_id !== null) params.set("employee_id", String(filters.employee_id));
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/person-clips?${params.toString()}`;
  return useQuery({
    queryKey: [...LIST_KEY, filters],
    queryFn: () => api<PersonClipListResponse>(path),
    staleTime: 10 * 1000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function usePersonClipStats(): UseQueryResult<PersonClipStats, Error> {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn: () => api<PersonClipStats>("/api/person-clips/stats"),
    staleTime: 30 * 1000,
  });
}

export function useClipProcessingResults(
  clipId: number | null,
  pollWhileProcessing = false,
): UseQueryResult<ClipProcessingResultsResponse, Error> {
  return useQuery({
    queryKey: ["person-clips", "processing-results", clipId],
    queryFn: () => api<ClipProcessingResultsResponse>(`/api/person-clips/${clipId}/processing-results`),
    enabled: clipId !== null,
    staleTime: 5 * 1000,
    refetchInterval: pollWhileProcessing
      ? (query) => {
          const data = query.state.data;
          if (!data) return 2000;
          const hasInProgress = data.results.some(
            (r) => r.status === "processing" || r.status === "pending",
          );
          return hasInProgress ? 2000 : false;
        }
      : false,
    refetchIntervalInBackground: false,
  });
}

export function useClipFaceCrops(
  clipId: number | null,
  useCase: string | null = null,
): UseQueryResult<FaceCropListResponse, Error> {
  const path = useCase
    ? `/api/person-clips/${clipId}/face-crops?use_case=${useCase}`
    : `/api/person-clips/${clipId}/face-crops`;
  return useQuery({
    queryKey: ["person-clips", "face-crops", clipId, useCase],
    queryFn: () => api<FaceCropListResponse>(path),
    enabled: clipId !== null,
    staleTime: 10 * 1000,
  });
}

export function useSingleClipReprocess(clipId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: SingleClipReprocessRequest) => {
      return api<SingleClipReprocessResponse>(`/api/person-clips/${clipId}/reprocess`, {
        method: "POST",
        body: req,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-clips", "processing-results", clipId] });
      qc.invalidateQueries({ queryKey: ["person-clips", "face-crops", clipId] });
    },
  });
}

export function useSystemStats(): UseQueryResult<SystemStatsResponse, Error> {
  return useQuery({
    queryKey: SYSTEM_STATS_KEY,
    queryFn: () => api<SystemStatsResponse>("/api/person-clips/system-stats"),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 4_000,
  });
}

export function useBulkDeletePersonClips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clipIds: number[]) => {
      await api<{ deleted_count: number; deleted_ids: number[] }>(
        "/api/person-clips/bulk-delete",
        {
          method: "POST",
          body: { clip_ids: clipIds },
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: STATS_KEY });
    },
  });
}

export function useDeletePersonClip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/person-clips/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: STATS_KEY });
    },
  });
}

export function useCameraOptions(): UseQueryResult<{ items: Camera[] }, Error> {
  return useQuery({
    queryKey: ["person-clips", "camera-options"],
    queryFn: () => api<{ items: Camera[] }>("/api/cameras"),
    staleTime: 60 * 1000,
  });
}

export function useReprocessFaceMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: ReprocessFaceMatchRequest) => {
      return api<ReprocessFaceMatchResponse>("/api/person-clips/reprocess-face-match", {
        method: "POST",
        body: req,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: REPROCESS_STATUS_KEY });
      qc.invalidateQueries({ queryKey: SYSTEM_STATS_KEY });
    },
  });
}

export function useReprocessStatus(): UseQueryResult<ReprocessFaceMatchStatus, Error> {
  return useQuery({
    queryKey: REPROCESS_STATUS_KEY,
    queryFn: () => api<ReprocessFaceMatchStatus>("/api/person-clips/reprocess-status"),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      if (data.status === "running" || data.status === "starting") return 2000;
      return false;
    },
    staleTime: 1000,
  });
}
