// Auth hooks. There's no React context here — TanStack Query's cache is
// the single source of truth for "who is the logged-in user". Components
// read the current user via `useMe()`; mutations are `useLogin()` /
// `useLogout()`.

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import { applyServerPreferred } from "../i18n";
import { applyServerPreferences as applyServerThemePreferences } from "../theme";
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
  const query = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    // Keep the session fresh while the user is actively moving around.
    staleTime: 60 * 1000,
    // Background-poll every 30 s so the cached ``session_expires_at``
    // stays close to the server's current sliding value. The
    // SessionExpiryWatcher reads it to drive the warning modal —
    // without this poll, the cached expiry would drift while the user
    // is active and the modal could fire spuriously.
    refetchInterval: 30 * 1000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  // P21/P22: when /api/auth/me resolves, apply any server-saved
  // preferences so a fresh login on another browser immediately
  // reflects the user's choices. The helpers no-op when the value
  // is already active.
  useEffect(() => {
    if (!query.data) return;
    if (query.data.preferred_language) {
      applyServerPreferred(query.data.preferred_language);
    }
    applyServerThemePreferences({
      theme: query.data.preferred_theme ?? null,
      density: query.data.preferred_density ?? null,
    });
  }, [query.data]);
  return query;
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

/** Session refresh — extends the server-side session's expiry by one
 *  idle window. Used by the SessionExpiryWatcher's "Stay signed in"
 *  button. Updates ``me`` in the cache so the countdown reschedules. */
export function useRefreshSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{
      session_expires_at: string;
      session_idle_minutes: number;
    }> =>
      api<{
        session_expires_at: string;
        session_idle_minutes: number;
      }>("/api/auth/refresh", { method: "POST" }),
    onSuccess: (res) => {
      // Patch the cached me with the new expiry so the watcher's
      // useEffect reschedules the warning timer.
      const cur = qc.getQueryData<MeResponse | null>(ME_KEY);
      if (cur) {
        qc.setQueryData<MeResponse>(ME_KEY, {
          ...cur,
          session_expires_at: res.session_expires_at,
          session_idle_minutes: res.session_idle_minutes,
        });
      }
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
