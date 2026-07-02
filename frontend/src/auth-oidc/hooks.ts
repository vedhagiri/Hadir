// TanStack Query hooks for the Entra ID OIDC flow.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import type {
  GoogleOidcConfigPatchInput,
  GoogleOidcConfigResponse,
  OidcConfigPatchInput,
  OidcConfigResponse,
  OidcStatusResponse,
} from "./types";

const STATUS_KEY = (slug: string) => ["oidc", "status", slug] as const;
const MY_CONFIG_KEY = ["oidc", "config", "me"] as const;
const GOOGLE_STATUS_KEY = (slug: string) =>
  ["google-oidc", "status", slug] as const;
const MY_GOOGLE_CONFIG_KEY = ["google-oidc", "config", "me"] as const;

/**
 * Anonymous probe — does the named tenant have OIDC enabled? The login
 * page calls this with whatever slug is in the URL / cookie / picker
 * to decide between rendering the Microsoft button or the local form.
 */
export function useOidcStatus(
  slug: string | null,
): UseQueryResult<OidcStatusResponse, Error> {
  return useQuery({
    queryKey: slug == null ? ["oidc", "status", "none"] : STATUS_KEY(slug),
    queryFn: async () =>
      api<OidcStatusResponse>(
        `/api/auth/oidc/status?tenant=${encodeURIComponent(slug ?? "")}`,
      ),
    enabled: slug != null && slug.length > 0,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useMyOidcConfig(): UseQueryResult<OidcConfigResponse | null, Error> {
  return useQuery({
    queryKey: MY_CONFIG_KEY,
    queryFn: async () => {
      try {
        return await api<OidcConfigResponse>("/api/auth/oidc/config");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30 * 1000,
    retry: false,
  });
}

export function usePutMyOidcConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: OidcConfigPatchInput,
    ): Promise<OidcConfigResponse> =>
      api<OidcConfigResponse>("/api/auth/oidc/config", {
        method: "PUT",
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(MY_CONFIG_KEY, data);
    },
  });
}

export function useDeleteMyOidcConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<OidcConfigResponse> =>
      api<OidcConfigResponse>("/api/auth/oidc/config", { method: "DELETE" }),
    onSuccess: (data) => {
      qc.setQueryData(MY_CONFIG_KEY, data);
    },
  });
}

// --- Google Sign-In (OIDC) ------------------------------------------------

/** Anonymous probe — does the named tenant have Google sign-in enabled? */
export function useGoogleStatus(
  slug: string | null,
): UseQueryResult<OidcStatusResponse, Error> {
  return useQuery({
    queryKey:
      slug == null ? ["google-oidc", "status", "none"] : GOOGLE_STATUS_KEY(slug),
    queryFn: async () =>
      api<OidcStatusResponse>(
        `/api/auth/google/status?tenant=${encodeURIComponent(slug ?? "")}`,
      ),
    enabled: slug != null && slug.length > 0,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useMyGoogleConfig(): UseQueryResult<
  GoogleOidcConfigResponse | null,
  Error
> {
  return useQuery({
    queryKey: MY_GOOGLE_CONFIG_KEY,
    queryFn: async () => {
      try {
        return await api<GoogleOidcConfigResponse>("/api/auth/google/config");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30 * 1000,
    retry: false,
  });
}

export function usePutMyGoogleConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: GoogleOidcConfigPatchInput,
    ): Promise<GoogleOidcConfigResponse> =>
      api<GoogleOidcConfigResponse>("/api/auth/google/config", {
        method: "PUT",
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(MY_GOOGLE_CONFIG_KEY, data);
    },
  });
}

export function useDeleteMyGoogleConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<GoogleOidcConfigResponse> =>
      api<GoogleOidcConfigResponse>("/api/auth/google/config", {
        method: "DELETE",
      }),
    onSuccess: (data) => {
      qc.setQueryData(MY_GOOGLE_CONFIG_KEY, data);
    },
  });
}
