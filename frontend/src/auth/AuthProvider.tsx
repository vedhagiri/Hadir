// Auth hooks. There's no React context here — TanStack Query's cache is
// the single source of truth for "who is the logged-in user". Components
// read the current user via `useMe()`; mutations are `useLogin()` /
// `useLogout()`.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import type { MeResponse } from "../types";

const ME_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>("/api/auth/me");
  } catch (err) {
    // Treat 401 as "not logged in" — the caller decides whether to
    // redirect. Anything else is a real error and should bubble.
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

export function useMe(): UseQueryResult<MeResponse | null, Error> {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    // Keep the session fresh while the user is actively moving around.
    staleTime: 60 * 1000,
    retry: false,
  });
}

export interface LoginInput {
  email: string;
  password: string;
  tenant_slug?: string;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput): Promise<MeResponse> =>
      api<MeResponse>("/api/auth/login", { method: "POST", body: input }),
    onSuccess: (me) => {
      qc.setQueryData(ME_KEY, me);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api<null>("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      qc.setQueryData(ME_KEY, null);
    },
  });
}

/** P7: switch the session's active role. Caller is expected to refresh
 *  the page after success so the navigation re-renders against the new
 *  role consistently — the tenant shell decides which nav set to show
 *  by reading ``me.active_role``. */
export function useSwitchRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (role: string): Promise<MeResponse> =>
      api<MeResponse>("/api/auth/switch-role", {
        method: "POST",
        body: { role },
      }),
    onSuccess: (me) => {
      qc.setQueryData(ME_KEY, me);
    },
  });
}
