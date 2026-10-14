// Clip Analytics data hook: the clip list (``GET /api/person-clips``),
// polled every 10 s while the page is open.

import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { PersonClipListResponse } from "../person-clips/types";

export const LIST_KEY = ["clip-analytics", "list"] as const;

export function useClipList(qs: string) {
  return useQuery({
    queryKey: [...LIST_KEY, qs],
    queryFn: () => api<PersonClipListResponse>(`/api/person-clips?${qs}`),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
}
