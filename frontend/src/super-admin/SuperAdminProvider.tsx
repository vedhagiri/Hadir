// TanStack Query hooks for the Super-Admin console. Mirrors the shape
// of ``auth/AuthProvider.tsx`` but keeps the cache keys disjoint so
// the tenant + super-admin sessions can coexist in the same browser.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import type {
  AccessAsResponse,
  ProvisionInput,
  ProvisionResponse,
  SuperAdminMe,
  TenantDetail,
  TenantSummary,
} from "./types";

const SUPER_ME_KEY = ["super-admin", "me"] as const;
const TENANTS_KEY = ["super-admin", "tenants"] as const;
const TENANT_DETAIL_KEY = (id: number) =>
  ["super-admin", "tenant", id] as const;

async function fetchSuperMe(): Promise<SuperAdminMe | null> {
  try {
    return await api<SuperAdminMe>("/api/super-admin/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function useSuperMe(): UseQueryResult<SuperAdminMe | null, Error> {
  return useQuery({
    queryKey: SUPER_ME_KEY,
    queryFn: fetchSuperMe,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export interface SuperLoginInput {
  email: string;
  password: string;
}

export function useSuperLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SuperLoginInput): Promise<SuperAdminMe> =>
      api<SuperAdminMe>("/api/super-admin/login", {
        method: "POST",
        body: input,
      }),
    onSuccess: (me) => {
      qc.setQueryData(SUPER_ME_KEY, me);
    },
  });
}

export function useSuperLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api<null>("/api/super-admin/logout", { method: "POST" });
    },
    onSuccess: () => {
      qc.setQueryData(SUPER_ME_KEY, null);
      qc.removeQueries({ queryKey: TENANTS_KEY });
    },
  });
}

export function useTenants(): UseQueryResult<TenantSummary[], Error> {
  return useQuery({
    queryKey: TENANTS_KEY,
    queryFn: async () => api<TenantSummary[]>("/api/super-admin/tenants"),
    staleTime: 30 * 1000,
  });
}

export function useTenantDetail(
  tenantId: number | null,
): UseQueryResult<TenantDetail, Error> {
  return useQuery({
    queryKey: tenantId == null ? ["super-admin", "tenant", "none"] : TENANT_DETAIL_KEY(tenantId),
    queryFn: async () =>
      api<TenantDetail>(`/api/super-admin/tenants/${tenantId}`),
    enabled: tenantId != null,
    staleTime: 15 * 1000,
  });
}

export function useProvisionTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProvisionInput): Promise<ProvisionResponse> =>
      api<ProvisionResponse>("/api/super-admin/tenants", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANTS_KEY });
    },
  });
}

export function useAccessAs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: number): Promise<AccessAsResponse> =>
      api<AccessAsResponse>(
        `/api/super-admin/tenants/${tenantId}/access-as`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUPER_ME_KEY });
    },
  });
}

export function useExitImpersonation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api<null>("/api/super-admin/exit-impersonation", {
        method: "POST",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SUPER_ME_KEY });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useUpdateTenantStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tenantId,
      status,
    }: {
      tenantId: number;
      status: "active" | "suspended";
    }): Promise<TenantSummary> =>
      api<TenantSummary>(`/api/super-admin/tenants/${tenantId}/status`, {
        method: "POST",
        body: { status },
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: TENANTS_KEY });
      qc.invalidateQueries({ queryKey: TENANT_DETAIL_KEY(vars.tenantId) });
    },
  });
}
