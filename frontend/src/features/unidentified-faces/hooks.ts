import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Camera } from "../cameras/types";
import type {
  FaceClusterOut,
  MapAsAttendanceBody,
  MapAsAttendanceResponse,
  MapAsReferenceBody,
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
  UnmapByEmployeeBody,
  UnmapEventsBody,
  UnmapEventsResponse,
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

/**
 * Common cache-coherency logic for every Map-to-Employee mutation.
 *
 * Both workflows (Reference + Attendance) attribute events to an
 * employee AND recompute attendance for the affected tenant-local
 * dates server-side, so every downstream surface that reads off
 * ``detection_events.employee_id`` or ``attendance_records`` needs
 * to refresh. This helper:
 *
 *   1. Optimistically strips the just-mapped event IDs out of every
 *      cached unidentified query so the UI removes them instantly —
 *      bypassing the `placeholderData: (prev) => prev` window that
 *      otherwise keeps stale rows on screen during the refetch.
 *   2. Invalidates the unidentified + mapped grids so the canonical
 *      server result reconciles any optimistic drift (clusters may
 *      regroup once events leave the pool; similarity ranges may
 *      shift; the mapped views need to refresh).
 *   3. Invalidates the downstream surfaces — attendance grid +
 *      calendar + detection-events. The Day Detail Drawer (evidence
 *      crops + day timeline), Daily Attendance page, Calendar
 *      person view, and Camera Logs all live behind those keys and
 *      would otherwise keep showing pre-map data until their stale
 *      timers expire.
 *
 * Called from `onSuccess` of each mutation hook below.
 */
function applyMapSuccess(
  queryClient: ReturnType<typeof useQueryClient>,
  mappedEventIds: number[],
): void {
  const mappedIds = new Set<number>(mappedEventIds);

  // 1. Raw events grid — drop the matching items.
  queryClient.setQueriesData<RawUnidentifiedResponse>(
    { queryKey: RAW_KEY },
    (old) => {
      if (!old) return old;
      const items = old.items.filter((it) => !mappedIds.has(it.id));
      if (items.length === old.items.length) return old;
      return {
        ...old,
        items,
        total: Math.max(0, old.total - (old.items.length - items.length)),
      };
    },
  );

  // 2. Cluster grid — peel mapped events out of each cluster and
  //    drop clusters that empty out.
  queryClient.setQueriesData<UnidentifiedFacesResponse>(
    { queryKey: LIST_KEY },
    (old) => {
      if (!old) return old;
      let totalRemoved = 0;
      const clusters: FaceClusterOut[] = [];
      for (const c of old.clusters) {
        const keptEventIds: number[] = [];
        const keptSims: number[] = [];
        const keptQualities: typeof c.event_qualities = [];
        const keptFaceTypes: typeof c.event_face_types = [];
        for (let i = 0; i < c.event_ids.length; i += 1) {
          const id = c.event_ids[i];
          if (id === undefined || mappedIds.has(id)) {
            if (id !== undefined) totalRemoved += 1;
            continue;
          }
          keptEventIds.push(id);
          keptSims.push(c.event_similarities[i] ?? 0);
          keptQualities.push(c.event_qualities[i] ?? "unknown");
          keptFaceTypes.push(c.event_face_types[i] ?? "unknown");
        }
        if (keptEventIds.length === 0) continue;
        clusters.push({
          ...c,
          event_ids: keptEventIds,
          crop_event_ids: c.crop_event_ids.filter((id) => !mappedIds.has(id)),
          count: keptEventIds.length,
          event_similarities: keptSims,
          event_qualities: keptQualities,
          event_face_types: keptFaceTypes,
        });
      }
      return {
        ...old,
        clusters,
        total_clusters: clusters.length,
        total_unidentified_events: Math.max(
          0,
          old.total_unidentified_events - totalRemoved,
        ),
        events_with_embedding: Math.max(
          0,
          old.events_with_embedding - totalRemoved,
        ),
      };
    },
  );

  // 3. Invalidate so a fresh fetch reconciles any drift.
  void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  void queryClient.invalidateQueries({ queryKey: RAW_KEY });
  void queryClient.invalidateQueries({ queryKey: MAPPED_KEY });
  void queryClient.invalidateQueries({ queryKey: MAPPED_CLUSTERS_KEY });

  // 4. Downstream surfaces — attendance grid, calendar (Day Detail
  //    Drawer reads from here), and the detection-events feed that
  //    backs Camera Logs + the evidence crops in the day drawer.
  //    The server has already recomputed; we just need the cached
  //    reads to refetch.
  void queryClient.invalidateQueries({ queryKey: ["attendance"] });
  void queryClient.invalidateQueries({ queryKey: ["attendance-calendar"] });
  void queryClient.invalidateQueries({ queryKey: ["detection-events"] });
}

export function useMapToEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MapToEmployeeBody) =>
      api<MapToEmployeeResponse>("/api/unidentified-faces/map-to-employee", {
        method: "POST",
        body,
      }),
    onSuccess: (_result, variables) => {
      applyMapSuccess(queryClient, variables.event_ids);
    },
  });
}

/**
 * Reference Image Mapping — adds crops to the employee's training set
 * and attributes the events. Use when curating the recognition dataset.
 *
 * Endpoint: ``POST /api/unidentified-faces/map-as-reference``.
 * Body: ``{employee_id, event_ids, photo_assignments}``.
 *
 * The backend invalidates the matcher cache so future captures match
 * against the new reference vectors immediately. No attendance
 * recompute fires; use ``useMapAsAttendance`` for that workflow.
 */
export function useMapAsReference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MapAsReferenceBody) =>
      api<MapToEmployeeResponse>("/api/unidentified-faces/map-as-reference", {
        method: "POST",
        body,
      }),
    onSuccess: (_result, variables) => {
      applyMapSuccess(queryClient, variables.event_ids);
    },
  });
}

/**
 * Attendance Event Mapping — corrects a missed live match. Attributes
 * events to the employee and recomputes the attendance_records row for
 * every tenant-local date covered by the event timestamps.
 *
 * Endpoint: ``POST /api/unidentified-faces/map-as-attendance``.
 * Body: ``{employee_id, event_ids}`` (no photo_assignments).
 *
 * Camera Logs / Matched Clips / Day Detail Drawer pivot immediately
 * because they read straight off ``detection_events.employee_id``. The
 * additional attendance-table refresh is invalidated below so the
 * daily attendance page reflects the new in/out times right away.
 */
export function useMapAsAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MapAsAttendanceBody) =>
      api<MapAsAttendanceResponse>(
        "/api/unidentified-faces/map-as-attendance",
        { method: "POST", body },
      ),
    onSuccess: (_result, variables) => {
      // ``applyMapSuccess`` already invalidates attendance,
      // attendance-calendar, and detection-events for every Map-to-
      // Employee mutation (the server recomputes attendance in both
      // workflows), so we don't need to duplicate them here.
      applyMapSuccess(queryClient, variables.event_ids);
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

/**
 * Revert a Map-to-Employee operation. Clears ``employee_id`` (and
 * ``former_employee_match`` / ``former_match_employee_id``) on the
 * supplied detection events so they return to the unidentified pool.
 *
 * Endpoint: ``POST /api/unidentified-faces/unmap-events``
 * Body: ``{event_ids: number[]}`` (server caps at 200/request).
 *
 * Side effects on the server (handled atomically):
 *   - Audit row ``unidentified_face.unmapped`` with the affected
 *     event IDs + previously-attributed employee IDs.
 *   - Attendance recompute for every (prev_employee, local_date)
 *     pair the unmapped events covered (in/out times shift).
 *   - matcher_cache.invalidate_employee for each previously-mapped
 *     employee — next live capture re-evaluates from scratch.
 *   - Cluster cache eviction for the tenant.
 *
 * Cache hygiene on the client (this hook):
 *   - Optimistically strips the affected event IDs from MAPPED_KEY +
 *     MAPPED_CLUSTERS_KEY so they disappear from the Mapped views
 *     instantly without waiting for refetch.
 *   - Invalidates RAW_KEY + LIST_KEY so the events reappear in
 *     Unknown Faces + Similarity Groups on the next render.
 *   - Invalidates attendance + calendar + detection-events queries
 *     so downstream surfaces refresh from the post-recompute state.
 */
export function useUnmapEvents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UnmapEventsBody) =>
      api<UnmapEventsResponse>("/api/unidentified-faces/unmap-events", {
        method: "POST",
        body,
      }),
    onSuccess: (_result, variables) => {
      const unmappedIds = new Set<number>(variables.event_ids);

      // Optimistic update: drop the unmapped events from every
      // cached Mapped query so the UI removes them immediately.
      queryClient.setQueriesData<MappedFacesResponse>(
        { queryKey: MAPPED_KEY },
        (old) => {
          if (!old) return old;
          const items = old.items.filter((it) => !unmappedIds.has(it.id));
          if (items.length === old.items.length) return old;
          return {
            ...old,
            items,
            total: Math.max(0, old.total - (old.items.length - items.length)),
          };
        },
      );

      // Mapped clusters need a refetch — the per-employee aggregates
      // (count, first_seen, last_seen, sample_event_ids) depend on the
      // full event set, and we don't have that here. Invalidate and
      // let the server reaggregate.
      void queryClient.invalidateQueries({ queryKey: MAPPED_KEY });
      void queryClient.invalidateQueries({ queryKey: MAPPED_CLUSTERS_KEY });

      // Unidentified views need a full refetch so the now-back-in-pool
      // events appear there (they would re-cluster server-side).
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: RAW_KEY });

      // Attendance + downstream surfaces — recompute already ran on
      // the server, just refresh the cached reads.
      void queryClient.invalidateQueries({ queryKey: ["attendance"] });
      void queryClient.invalidateQueries({ queryKey: ["attendance-calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["detection-events"] });
    },
  });
}

/**
 * Per-employee bulk revert. Same server-side side-effects as
 * ``useUnmapEvents`` but the server picks the rows from a
 * (employee_id + date/camera) filter — used by the "Unmap" button
 * on each MappedEmployeeCard so the entire mapping for that
 * employee within the visible filter is reverted in one round trip.
 */
export function useUnmapByEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UnmapByEmployeeBody) =>
      api<UnmapEventsResponse>(
        "/api/unidentified-faces/unmap-by-employee",
        { method: "POST", body },
      ),
    onSuccess: () => {
      // We don't know which event IDs server-side touched, so just
      // invalidate every relevant cache and let the refetch land
      // canonical data.
      void queryClient.invalidateQueries({ queryKey: MAPPED_KEY });
      void queryClient.invalidateQueries({ queryKey: MAPPED_CLUSTERS_KEY });
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: RAW_KEY });
      void queryClient.invalidateQueries({ queryKey: ["attendance"] });
      void queryClient.invalidateQueries({ queryKey: ["attendance-calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["detection-events"] });
    },
  });
}
