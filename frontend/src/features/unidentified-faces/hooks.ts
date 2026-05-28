import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type {
  MapToEmployeeBody,
  MapToEmployeeResponse,
  MappedClustersFilters,
  MappedEmployeesResponse,
  MappedFacesFilters,
  MappedFacesResponse,
  RawUnidentifiedFilters,
  RawUnidentifiedResponse,
  UnidentifiedEventsResponse,
  UnidentifiedFacesFilters,
  UnidentifiedFacesResponse,
} from "./types";

const LIST_KEY = ["unidentified-faces", "clusters"] as const;
const EVENTS_KEY = ["unidentified-faces", "events"] as const;
const RAW_KEY = ["unidentified-faces", "raw"] as const;
const MAPPED_KEY = ["unidentified-faces", "mapped"] as const;
const MAPPED_CLUSTERS_KEY = ["unidentified-faces", "mapped-clusters"] as const;

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

export function useRawUnidentifiedFaces(
  filters: RawUnidentifiedFilters,
): UseQueryResult<RawUnidentifiedResponse, Error> {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start + "T00:00:00Z");
  if (filters.end) params.set("end", filters.end + "T23:59:59Z");
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.has_embedding !== null) params.set("has_embedding", String(filters.has_embedding));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));

  return useQuery({
    queryKey: [...RAW_KEY, filters],
    queryFn: () =>
      api<RawUnidentifiedResponse>(`/api/unidentified-faces/raw?${params.toString()}`),
    staleTime: 30_000,
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
      // A newly-mapped event leaves the unidentified pool and enters
      // the mapped pool — refresh both views so the operator sees the
      // pivot immediately without a page reload.
      void queryClient.invalidateQueries({ queryKey: RAW_KEY });
      void queryClient.invalidateQueries({ queryKey: MAPPED_KEY });
      void queryClient.invalidateQueries({ queryKey: MAPPED_CLUSTERS_KEY });
    },
  });
}

export function useMappedFaces(
  filters: MappedFacesFilters,
): UseQueryResult<MappedFacesResponse, Error> {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start + "T00:00:00Z");
  if (filters.end) params.set("end", filters.end + "T23:59:59Z");
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  if (filters.employee_id !== null) params.set("employee_id", String(filters.employee_id));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));

  return useQuery({
    queryKey: [...MAPPED_KEY, filters],
    queryFn: () =>
      api<MappedFacesResponse>(`/api/unidentified-faces/mapped?${params.toString()}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useMappedClusters(
  filters: MappedClustersFilters,
): UseQueryResult<MappedEmployeesResponse, Error> {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start + "T00:00:00Z");
  if (filters.end) params.set("end", filters.end + "T23:59:59Z");
  if (filters.camera_id !== null) params.set("camera_id", String(filters.camera_id));
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));

  return useQuery({
    queryKey: [...MAPPED_CLUSTERS_KEY, filters],
    queryFn: () =>
      api<MappedEmployeesResponse>(
        `/api/unidentified-faces/mapped-clusters?${params.toString()}`,
      ),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
