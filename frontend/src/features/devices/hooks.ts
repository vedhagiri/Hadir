// TanStack Query hooks for devices. Mirrors features/cameras/hooks.ts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  AutoMapResult,
  Device,
  DeviceCreateInput,
  DeviceEventListResponse,
  DeviceListResponse,
  DevicePatchInput,
  DeviceUserListResponse,
  MapDeviceUserResult,
} from "./types";

const LIST_KEY = ["devices", "list"] as const;
const usersKey = (id: number) => ["devices", "users", id] as const;
const eventsKey = (id: number) => ["devices", "events", id] as const;

export function useDevices(): UseQueryResult<DeviceListResponse, Error> {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api<DeviceListResponse>("/api/devices"),
    staleTime: 15 * 1000,
    // Poll so a terminal that just went live flips to Online without the
    // operator reloading the page.
    refetchInterval: 30 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceCreateInput) =>
      api<Device>("/api/devices", { method: "POST", body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function usePatchDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: DevicePatchInput }) =>
      api<Device>(`/api/devices/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api<null>(`/api/devices/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

// Issue a new token. The old URL stops working immediately, stranding any
// terminal still configured with it.
//
// Deliberately NOT wired to any control: a device's token is its permanent
// identity, and an operator who rotates it by accident has to walk to the
// terminal to fix it. This stays available for the one case that justifies
// the cost — a leaked URL — and whoever adds a control for it should make
// that consequence explicit in the UI.
export function useRegenerateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<Device>(`/api/devices/${id}/regenerate-token`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

// --- people the device reported --------------------------------------------

export function useDeviceUsers(
  id: number | null,
): UseQueryResult<DeviceUserListResponse, Error> {
  return useQuery({
    queryKey: usersKey(id ?? 0),
    queryFn: () => api<DeviceUserListResponse>(`/api/devices/${id}/users`),
    enabled: id !== null,
    staleTime: 10 * 1000,
  });
}

export function useMapDeviceUser(deviceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      deviceUserId,
      employeeId,
    }: {
      deviceUserId: string;
      employeeId: number | null;
    }) =>
      api<MapDeviceUserResult>(
        `/api/devices/${deviceId}/users/${encodeURIComponent(deviceUserId)}/map`,
        { method: "POST", body: { employee_id: employeeId } },
      ),
    onSuccess: () => {
      // Mapping replays held taps into attendance, so the event list and
      // the device's unmapped count both move.
      qc.invalidateQueries({ queryKey: usersKey(deviceId) });
      qc.invalidateQueries({ queryKey: eventsKey(deviceId) });
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useAutoMapDeviceUsers(deviceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<AutoMapResult>(`/api/devices/${deviceId}/users/auto-map`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: usersKey(deviceId) });
      qc.invalidateQueries({ queryKey: eventsKey(deviceId) });
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

// --- raw taps ---------------------------------------------------------------

export function useDeviceEvents(
  id: number | null,
): UseQueryResult<DeviceEventListResponse, Error> {
  return useQuery({
    queryKey: eventsKey(id ?? 0),
    queryFn: () => api<DeviceEventListResponse>(`/api/devices/${id}/events?limit=100`),
    enabled: id !== null,
    staleTime: 5 * 1000,
    refetchInterval: 15 * 1000,
    refetchIntervalInBackground: false,
  });
}
