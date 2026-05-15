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
  UseCaseComparisonResponse,
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
  if (filters.detection_source !== "all") {
    params.set("detection_source", filters.detection_source);
  }
  if (filters.matched_status !== null) {
    params.set("matched_status", filters.matched_status);
  }
  if (filters.recording_status !== null) {
    params.set("recording_status", filters.recording_status);
  }
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/person-clips?${params.toString()}`;
  return useQuery({
    queryKey: [...LIST_KEY, filters],
    queryFn: () => api<PersonClipListResponse>(path),
    staleTime: 10 * 1000,
    // Migration 0054 / 0055 — speed up polling while any clip is
    // in-flight so the recording→finalizing→completed transitions
    // surface promptly. ``finalizing`` rows can take real wall-clock
    // minutes to encode for long native-resolution clips, so faster
    // polling is what makes the "Encoding…" pill flip to "Play" the
    // moment the encode lands.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 15_000;
      const anyInFlight = data.items.some(
        (c) =>
          c.recording_status === "recording" ||
          c.recording_status === "finalizing",
      );
      return anyInFlight ? 5_000 : 15_000;
    },
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

export function useUcComparison(): UseQueryResult<UseCaseComparisonResponse, Error> {
  return useQuery({
    queryKey: ["person-clips", "uc-comparison"],
    queryFn: () =>
      api<UseCaseComparisonResponse>("/api/person-clips/uc-comparison"),
    // Dashboard tab — refresh on tab focus is enough; comparison data
    // changes only when a new UC run completes.
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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


// Per-UC count of already-processed clips for the requested UCs. Powers
// the Identify Event overwrite-confirmation panel — the operator sees
// the actual blast radius before confirming.
export interface ProcessedClipCounts {
  use_cases: string[];
  per_uc: Record<string, number>;
  any_uc: number;
  total_completed_clips: number;
}

export function useProcessedClipCounts(
  useCases: string[],
  enabled: boolean,
): UseQueryResult<ProcessedClipCounts, Error> {
  const csv = [...useCases].sort().join(",");
  return useQuery({
    queryKey: ["person-clips", "processed-counts", csv],
    queryFn: () =>
      api<ProcessedClipCounts>(
        `/api/person-clips/processed-counts?use_cases=${encodeURIComponent(csv)}`,
      ),
    enabled: enabled && csv.length > 0,
    staleTime: 5_000,
  });
}


// ── New clip_pipeline batch path ────────────────────────────────────────────
// Replaces the legacy /api/person-clips/reprocess-face-match flow. The
// pipeline tracks per-(clip, uc) state so the modal can show what's
// queued / cropping / matching / completed / skipped / failed in real
// time as the worker drains the queue one job at a time.

export interface ClipPipelineSubmitAllRequest {
  use_cases: string[];
  skip_existing: boolean;
}

export interface ClipPipelineSubmitAllResponse {
  batch_id: string;
  total_clips: number;
  total_jobs: number;
  queued_jobs: number;
  skipped_jobs: number;
  deleted_prior: number;
}

export function useClipPipelineSubmitAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ClipPipelineSubmitAllRequest) =>
      api<ClipPipelineSubmitAllResponse>(
        "/api/clip-pipeline/submit-all",
        { method: "POST", body },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
      qc.invalidateQueries({ queryKey: ["clip-pipeline", "status"] });
    },
  });
}


// Status of one batch — the modal polls this aggressively while the
// batch is in flight so the operator sees jobs move from queued →
// cropping → matching → completed in real time.

export interface ClipPipelineBatchPerUc {
  total: number;
  queued: number;
  cropping: number;
  matching: number;
  completed: number;
  skipped: number;
  failed: number;
}

export interface ClipPipelineBatch {
  batch_id: string;
  submitted_at: string;
  total_jobs: number;
  queued_jobs: number;
  cropping_now: number;
  matching_now: number;
  completed_jobs: number;
  skipped_jobs: number;
  failed_jobs: number;
  remaining_jobs: number;
  use_cases: string[];
  skip_existing: boolean;
  per_uc: Record<string, ClipPipelineBatchPerUc>;
  completed_at: string | null;
}

export interface ClipPipelineStatusResponse {
  running: boolean;
  batches: ClipPipelineBatch[];
}

export function useClipPipelineBatch(
  batchId: string | null,
): UseQueryResult<ClipPipelineBatch | null, Error> {
  return useQuery<ClipPipelineBatch | null>({
    queryKey: ["clip-pipeline", "batch", batchId ?? ""],
    queryFn: async () => {
      if (!batchId) return null;
      const res = await api<ClipPipelineStatusResponse>(
        `/api/clip-pipeline/status?batch_id=${encodeURIComponent(batchId)}`,
      );
      return res.batches[0] ?? null;
    },
    enabled: batchId !== null,
    // Keep polling while in flight — completed_at non-null means done.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      return data.completed_at ? false : 1500;
    },
    staleTime: 500,
  });
}
