// Shared hook: which clip-processing use cases are enabled for this
// tenant (Detection & Tracker → "Clip processing" checkboxes =
// ``clip_pipeline_use_cases``). Drives which UC columns / badges /
// panels the clip dashboards render, so a tenant running only UC1 never
// sees UC2 in the UI (and vice-versa). Both enabled → both shown.
//
// Shares the same query key as SystemSettings' ``useClipPipelineConfig``
// so there's a single cached fetch app-wide. Falls back to ALL when the
// value is loading / empty so the UI never blanks.

import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";

export type UseCaseCode = "uc1" | "uc2";

export const ALL_USE_CASE_CODES: UseCaseCode[] = ["uc1", "uc2"];

const CLIP_PIPELINE_KEY = ["system", "clip-pipeline-config"] as const;

interface ClipPipelineConfig {
  use_cases: string[];
}

export function useEnabledUseCases(): UseCaseCode[] {
  const { data } = useQuery<ClipPipelineConfig>({
    queryKey: CLIP_PIPELINE_KEY,
    queryFn: () =>
      api<ClipPipelineConfig>("/api/system/clip-pipeline-config"),
    staleTime: 5_000,
  });
  const enabled = (data?.use_cases ?? []).filter(
    (u): u is UseCaseCode => u === "uc1" || u === "uc2",
  );
  // Empty / loading → show everything (never blank the dashboards).
  return enabled.length ? enabled : ALL_USE_CASE_CODES;
}
