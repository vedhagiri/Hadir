// TanStack Query hooks for the Entra ID OIDC flow.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import type {
  OidcConfigPatchInput,
  OidcConfigResponse,
  OidcStatusResponse,
} from "./types";

const STATUS_KEY = (slug: string) => ["oidc", "status", slug] as const;
const MY_CONFIG_KEY = ["oidc", "config", "me"] as const;

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
