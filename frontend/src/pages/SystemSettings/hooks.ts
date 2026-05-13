// TanStack Query hooks for the System Settings page (P28.5c). Two
// pairs (detection + tracker), each with its own GET / PUT.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import {
  CLIP_ENCODING_DEFAULTS,
  DETECTION_DEFAULTS,
  TRACKER_DEFAULTS,
  type ClipEncodingConfig,
  type DetectionConfig,
  type TrackerConfig,
} from "./types";

const DETECTION_KEY = ["system", "detection-config"] as const;
const TRACKER_KEY = ["system", "tracker-config"] as const;
const CLIP_ENCODING_KEY = ["system", "clip-encoding-config"] as const;

export function useDetectionConfig() {
  return useQuery<DetectionConfig>({
    queryKey: DETECTION_KEY,
    queryFn: () => api<DetectionConfig>("/api/system/detection-config"),
    initialData: DETECTION_DEFAULTS,
    staleTime: 5_000,
  });
}

export function usePutDetectionConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DetectionConfig) =>
      api<DetectionConfig>("/api/system/detection-config", {
        method: "PUT",
        body,
      }),
    onSuccess: (data) => {
      qc.setQueryData(DETECTION_KEY, data);
    },
  });
}

export function useTrackerConfig() {
  return useQuery<TrackerConfig>({
    queryKey: TRACKER_KEY,
    queryFn: () => api<TrackerConfig>("/api/system/tracker-config"),
    initialData: TRACKER_DEFAULTS,
    staleTime: 5_000,
  });
}

export function usePutTrackerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TrackerConfig) =>
      api<TrackerConfig>("/api/system/tracker-config", {
        method: "PUT",
        body,
      }),
    onSuccess: (data) => {
      qc.setQueryData(TRACKER_KEY, data);
    },
  });
}

export function useClipEncodingConfig() {
  return useQuery<ClipEncodingConfig>({
    queryKey: CLIP_ENCODING_KEY,
    queryFn: () =>
      api<ClipEncodingConfig>("/api/system/clip-encoding-config"),
    initialData: CLIP_ENCODING_DEFAULTS,
    staleTime: 5_000,
  });
}

export function usePutClipEncodingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ClipEncodingConfig) =>
      api<ClipEncodingConfig>("/api/system/clip-encoding-config", {
        method: "PUT",
        body,
      }),
    onSuccess: (data) => {
      qc.setQueryData(CLIP_ENCODING_KEY, data);
    },
  });
}
