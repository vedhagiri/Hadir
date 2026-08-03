// TanStack Query hooks for devices. Mirrors features/cameras/hooks.ts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  Device,
  DeviceCreateInput,
  DeviceListResponse,
  DevicePatchInput,
} from "./types";

const LIST_KEY = ["devices", "list"] as const;

export function useDevices(): UseQueryResult<DeviceListResponse, Error> {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api<DeviceListResponse>("/api/devices"),
    staleTime: 15 * 1000,
    // Poll every 30 s so the health pill tracks live reachability
    // instead of showing stale cached state.
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

// Pull the device's user list into ``device_users`` on demand. Invalidates
// the list so the "users synced" count refreshes.
export function useSyncDeviceUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<{ synced: number; unmapped: number; reachable: boolean }>(
        `/api/devices/${id}/sync-users`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
