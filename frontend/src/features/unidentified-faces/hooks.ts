import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type {
  MapToEmployeeBody,
  MapToEmployeeResponse,
  UnidentifiedEventsResponse,
  UnidentifiedFacesFilters,
  UnidentifiedFacesResponse,
} from "./types";

const LIST_KEY = ["unidentified-faces", "clusters"] as const;
const EVENTS_KEY = ["unidentified-faces", "events"] as const;

export function useUnidentifiedFaceClusters(
  filters: UnidentifiedFacesFilters,
): UseQueryResult<UnidentifiedFacesResponse, Error> {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start + "T00:00:00Z");
  if (filters.end) params.set("end", filters.end + "T23:59:59Z");
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  params.set("min_count", String(filters.min_count));
  params.set("threshold", String(filters.threshold));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));

  return useQuery({
    queryKey: [...LIST_KEY, filters],
    queryFn: () =>
      api<UnidentifiedFacesResponse>(`/api/unidentified-faces?${params.toString()}`),
    staleTime: 60_000,
    // Keep the last page visible while loading the next — eliminates flash to skeleton
    placeholderData: (prev) => prev,
  });
}

export function useClusterEvents(
  eventIds: number[],
  enabled: boolean,
): UseQueryResult<UnidentifiedEventsResponse, Error> {
  const joined = eventIds.join(",");
  return useQuery({
    queryKey: [...EVENTS_KEY, joined],
    queryFn: () =>
      api<UnidentifiedEventsResponse>(
        `/api/unidentified-faces/events?event_ids=${encodeURIComponent(joined)}`,
      ),
    enabled: enabled && eventIds.length > 0,
    staleTime: 120_000,
  });
}

export function useCameraList(): UseQueryResult<{ items: Camera[] }, Error> {
  return useQuery({
    queryKey: ["cameras", "list-all"],
    queryFn: () => api<{ items: Camera[] }>("/api/cameras?page_size=200"),
    staleTime: 5 * 60_000,
  });
}

export function useMapToEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MapToEmployeeBody) =>
      api<MapToEmployeeResponse>("/api/unidentified-faces/map-to-employee", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
