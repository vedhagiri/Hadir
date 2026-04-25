import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AuditFilters, AuditListResponse } from "./types";

export function useAuditLog(
  filters: AuditFilters,
): UseQueryResult<AuditListResponse, Error> {
  const params = new URLSearchParams();
  if (filters.actor_user_id !== null)
    params.set("actor_user_id", String(filters.actor_user_id));
  if (filters.action) params.set("action", filters.action);
  if (filters.entity_type) params.set("entity_type", filters.entity_type);
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  return useQuery({
    queryKey: ["audit-log", filters],
    queryFn: () => api<AuditListResponse>(`/api/audit-log?${params.toString()}`),
    staleTime: 15 * 1000,
  });
}
