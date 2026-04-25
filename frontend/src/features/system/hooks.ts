import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { CamerasHealthResponse, SystemHealth } from "./types";

export function useSystemHealth(): UseQueryResult<SystemHealth, Error> {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: () => api<SystemHealth>("/api/system/health"),
    refetchInterval: 30 * 1000,
  });
}

export function useCamerasHealth(): UseQueryResult<CamerasHealthResponse, Error> {
  return useQuery({
    queryKey: ["system", "cameras-health"],
    queryFn: () => api<CamerasHealthResponse>("/api/system/cameras-health"),
    refetchInterval: 30 * 1000,
  });
}
