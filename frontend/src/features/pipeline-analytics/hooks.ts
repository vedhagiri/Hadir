import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { dayBound } from "../../util/datetime";
import type {
  PipelineClipsResponse,
  PipelineFilters,
  PipelineSummaryResponse,
} from "./types";

// Expand the date-only From/To to inclusive day bounds in the viewer's
// local timezone (matches how clip times are rendered).
function applyDateBounds(p: URLSearchParams, f: PipelineFilters): void {
  if (f.start) p.set("start", dayBound(f.start, "00:00:00"));
  if (f.end) p.set("end", dayBound(f.end, "23:59:59"));
}

function summaryParams(f: PipelineFilters): string {
  const p = new URLSearchParams();
  if (f.useCase) p.set("use_case", f.useCase);
  p.set("status", f.status);
  applyDateBounds(p, f);
  return p.toString();
}

function clipParams(f: PipelineFilters, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  if (f.useCase) p.set("use_case", f.useCase);
  if (f.status !== "all") p.set("status", f.status);
  applyDateBounds(p, f);
  p.set("page", String(page));
  p.set("page_size", String(pageSize));
  return p.toString();
}

export function usePipelineSummary(filters: PipelineFilters) {
  const qs = summaryParams(filters);
  return useQuery({
    queryKey: ["pipeline-analytics", "summary", qs],
    queryFn: () =>
      api<PipelineSummaryResponse>(`/api/pipeline-analytics/summary?${qs}`),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function usePipelineClips(
  filters: PipelineFilters,
  page: number,
  pageSize: number,
) {
  const qs = clipParams(filters, page, pageSize);
  return useQuery({
    queryKey: ["pipeline-analytics", "clips", qs],
    queryFn: () =>
      api<PipelineClipsResponse>(`/api/pipeline-analytics/clips?${qs}`),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

// Generic export — fetch the blob with credentials and trigger a
// download. ``kind`` picks CSV vs the (clips-bundled) ZIP; ``useCase``
// (when passed) overrides the current filter so UC1/UC2 can be pulled
// separately regardless of the on-screen toggle.
export async function downloadPipelineExport(
  filters: PipelineFilters,
  opts: { kind: "csv" | "zip"; useCase?: "uc1" | "uc2" | null },
): Promise<void> {
  const p = new URLSearchParams();
  const uc = opts.useCase !== undefined ? opts.useCase : filters.useCase;
  if (uc) p.set("use_case", uc);
  if (filters.status !== "all") p.set("status", filters.status);
  applyDateBounds(p, filters);
  const path = opts.kind === "zip" ? "export.zip" : "export.csv";
  const res = await fetch(`/api/pipeline-analytics/${path}?${p.toString()}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="([^"]+)"/.exec(cd);
  a.download = m?.[1] ?? `pipeline-analytics.${opts.kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
