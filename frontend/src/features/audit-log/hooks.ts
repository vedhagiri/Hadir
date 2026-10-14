import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AuditActorsResponse, AuditListResponse, AuditQuery, AuditSummary } from "./types";

/** URLSearchParams for the shared filter set. ``withKind=false`` drops
 *  the tile filter (the summary ignores it anyway). */
export function auditParams(q: AuditQuery, withKind = true): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q.trim()) {
    p.set("q", q.q.trim());
    for (const a of q.q_action) p.append("q_action", a);
  }
  for (const c of q.categories) p.append("category", c);
  if (q.actor === "system") p.set("actor", "system");
  else if (q.actor) p.set("actor_user_id", q.actor);
  if (q.start) p.set("start", q.start);
  if (q.end) p.set("end", q.end);
  if (q.hide_routine) p.set("hide_routine", "true");
  if (withKind && q.kind) p.set("kind", q.kind);
  return p;
}

export function useAuditLog(
  query: AuditQuery,
  page: number,
  pageSize: number,
): UseQueryResult<AuditListResponse, Error> {
  const p = auditParams(query);
  p.set("page", String(page));
  p.set("page_size", String(pageSize));
  const qs = p.toString();
  return useQuery({
    queryKey: ["audit-log", "list", qs],
    queryFn: () => api<AuditListResponse>(`/api/audit-log?${qs}`),
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useAuditSummary(query: AuditQuery): UseQueryResult<AuditSummary, Error> {
  const qs = auditParams(query, false).toString();
  return useQuery({
    queryKey: ["audit-log", "summary", qs],
    queryFn: () => api<AuditSummary>(`/api/audit-log/summary?${qs}`),
    staleTime: 15 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useAuditActors(): UseQueryResult<AuditActorsResponse, Error> {
  return useQuery({
    queryKey: ["audit-log", "actors"],
    queryFn: () => api<AuditActorsResponse>("/api/audit-log/actors"),
    staleTime: 5 * 60 * 1000,
  });
}

/** Fetch the CSV for the current filters and save it. Returns the row
 *  count + whether the server capped the export. */
export async function downloadAuditCsv(query: AuditQuery): Promise<{ rows: number; truncated: boolean }> {
  const resp = await fetch(`/api/audit-log/export.csv?${auditParams(query).toString()}`, {
    credentials: "same-origin",
  });
  if (!resp.ok) throw new Error(`export failed (${resp.status})`);
  const blob = await resp.blob();
  const cd = resp.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "maugood-audit-log.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return {
    rows: Number(resp.headers.get("X-Export-Rows") ?? "0"),
    truncated: resp.headers.get("X-Export-Truncated") === "true",
  };
}
