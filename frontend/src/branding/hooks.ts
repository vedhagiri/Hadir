// TanStack Query hooks for tenant + super-admin branding flows.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import type {
  BrandingOptions,
  BrandingPatchInput,
  BrandingResponse,
} from "./types";

const MY_BRANDING_KEY = ["branding", "me"] as const;
const OPTIONS_KEY = ["branding", "options"] as const;
const TENANT_BRANDING_KEY = (tenantId: number) =>
  ["super-admin", "branding", tenantId] as const;

// ---- Tenant-side ---------------------------------------------------------

export function useMyBranding(): UseQueryResult<BrandingResponse | null, Error> {
  return useQuery({
    queryKey: MY_BRANDING_KEY,
    queryFn: async () => {
      try {
        return await api<BrandingResponse>("/api/branding");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useBrandingOptions(): UseQueryResult<BrandingOptions, Error> {
  return useQuery({
    queryKey: OPTIONS_KEY,
    queryFn: async () => api<BrandingOptions>("/api/branding/options"),
    staleTime: 60 * 60 * 1000, // curated, ~immutable in this app version
  });
}

export function usePatchMyBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BrandingPatchInput): Promise<BrandingResponse> =>
      api<BrandingResponse>("/api/branding", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(MY_BRANDING_KEY, data);
    },
  });
}

export function useUploadMyLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<BrandingResponse> => {
      const fd = new FormData();
      fd.append("logo", file);
      return api<BrandingResponse>("/api/branding/logo", {
        method: "POST",
        body: fd,
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(MY_BRANDING_KEY, data);
    },
  });
}

export function useDeleteMyLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api<null>("/api/branding/logo", { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MY_BRANDING_KEY });
    },
  });
}

// ---- Super-admin (operate on a specific tenant) --------------------------

export function useTenantBranding(
  tenantId: number | null,
): UseQueryResult<BrandingResponse, Error> {
  return useQuery({
    queryKey:
      tenantId == null
        ? ["super-admin", "branding", "none"]
        : TENANT_BRANDING_KEY(tenantId),
    queryFn: async () =>
      api<BrandingResponse>(
        `/api/super-admin/tenants/${tenantId}/branding`,
      ),
    enabled: tenantId != null,
    staleTime: 30 * 1000,
  });
}

export function usePatchTenantBranding(tenantId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BrandingPatchInput): Promise<BrandingResponse> =>
      api<BrandingResponse>(
        `/api/super-admin/tenants/${tenantId}/branding`,
        { method: "PATCH", body: input },
      ),
    onSuccess: (data) => {
      qc.setQueryData(TENANT_BRANDING_KEY(tenantId), data);
    },
  });
}

export function useUploadTenantLogo(tenantId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<BrandingResponse> => {
      const fd = new FormData();
      fd.append("logo", file);
      return api<BrandingResponse>(
        `/api/super-admin/tenants/${tenantId}/branding/logo`,
        { method: "POST", body: fd },
      );
    },
    onSuccess: (data) => {
      qc.setQueryData(TENANT_BRANDING_KEY(tenantId), data);
    },
  });
}

export function useDeleteTenantLogo(tenantId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api<null>(
        `/api/super-admin/tenants/${tenantId}/branding/logo`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANT_BRANDING_KEY(tenantId) });
    },
  });
}
