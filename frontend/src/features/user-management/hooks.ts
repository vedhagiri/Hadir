// TanStack Query hooks for the AD Users surface.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  AdUser,
  AdUserList,
  EntraGroup,
  GroupRoleMap,
  LoginActivity,
  SyncResult,
} from "./types";

const AD_USERS_KEY = ["entra", "users"] as const;
const GROUP_ROLES_KEY = ["entra", "group-roles"] as const;

export function useAdUsers(): UseQueryResult<AdUserList, Error> {
  return useQuery({
    queryKey: AD_USERS_KEY,
    queryFn: async () => api<AdUserList>("/api/entra-sync/users"),
    staleTime: 15 * 1000,
    retry: false,
  });
}

export function useSyncUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncResult> =>
      api<SyncResult>("/api/entra-sync/run", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AD_USERS_KEY });
    },
  });
}

export function useEntraGroups(enabled: boolean): UseQueryResult<EntraGroup[], Error> {
  return useQuery({
    queryKey: ["entra", "groups"],
    queryFn: async () => api<EntraGroup[]>("/api/entra-sync/groups"),
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useGroupRoles(): UseQueryResult<GroupRoleMap, Error> {
  return useQuery({
    queryKey: GROUP_ROLES_KEY,
    queryFn: async () => api<GroupRoleMap>("/api/entra-sync/group-roles"),
    staleTime: 30 * 1000,
    retry: false,
  });
}

export function usePutGroupRoles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (map: GroupRoleMap): Promise<GroupRoleMap> =>
      api<GroupRoleMap>("/api/entra-sync/group-roles", {
        method: "PUT",
        body: map,
      }),
    onSuccess: (data) => {
      qc.setQueryData(GROUP_ROLES_KEY, data);
    },
  });
}

export function useLoginActivity(
  userId: number | null,
): UseQueryResult<LoginActivity, Error> {
  return useQuery({
    queryKey: ["entra", "login-activity", userId],
    queryFn: async () =>
      api<LoginActivity>(`/api/entra-sync/users/${userId}/login-activity`),
    enabled: userId != null,
    retry: false,
  });
}

// Role change + access toggle reuse the shared /api/users PATCH.
export function usePatchUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      userId: number;
      role_codes?: string[];
      is_active?: boolean;
    }): Promise<AdUser> => {
      const body: { role_codes?: string[]; is_active?: boolean } = {};
      if (input.role_codes) body.role_codes = input.role_codes;
      if (input.is_active !== undefined) body.is_active = input.is_active;
      await api(`/api/users/${input.userId}`, { method: "PATCH", body });
      // Re-fetch the AD row for the fresh shape (roles + access).
      return api<AdUser>(`/api/entra-sync/users/${input.userId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AD_USERS_KEY });
    },
  });
}
