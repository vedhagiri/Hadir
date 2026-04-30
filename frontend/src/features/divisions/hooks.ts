// Divisions CRUD hooks. Mirror departments hooks; backend is at
// /api/divisions. Read open to every authenticated role; mutations
// gated to Admin/HR by the server. Includes manager-assignment
// hooks (user_divisions) — symmetric with department managers.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";

export interface Division {
  id: number;
  code: string;
  name: string;
  department_count: number;
}

export interface DivisionListResponse {
  items: Division[];
}

export function useDivisions(): UseQueryResult<DivisionListResponse, Error> {
  return useQuery({
    queryKey: ["divisions"],
    queryFn: () => api<DivisionListResponse>("/api/divisions"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateDivision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string; name: string }) =>
      api<Division>("/api/divisions", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["divisions"] }),
  });
}

export function useUpdateDivision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api<Division>(`/api/divisions/${id}`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["divisions"] }),
  });
}

export function useDeleteDivision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/api/divisions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["divisions"] }),
  });
}

// ---------------------------------------------------------------------------
// Manager assignment (user_divisions). Symmetric with the
// department-manager hooks — division managers see every employee
// in every department under that division.
// ---------------------------------------------------------------------------

export interface DivisionManager {
  user_id: number;
  full_name: string;
  email: string;
}

export interface DivisionManagerListResponse {
  items: DivisionManager[];
}

export function useDivisionManagers(
  divisionId: number | null,
): UseQueryResult<DivisionManagerListResponse, Error> {
  return useQuery({
    queryKey: ["divisions", "managers", divisionId],
    queryFn: () =>
      api<DivisionManagerListResponse>(
        `/api/divisions/${divisionId}/managers`,
      ),
    enabled: divisionId !== null,
    staleTime: 60 * 1000,
  });
}

export function useAssignDivisionManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ divisionId, userId }: { divisionId: number; userId: number }) =>
      api<DivisionManager>(
        `/api/divisions/${divisionId}/managers`,
        { method: "POST", body: { user_id: userId } },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["divisions", "managers", vars.divisionId],
      });
    },
  });
}

export function useRemoveDivisionManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ divisionId, userId }: { divisionId: number; userId: number }) =>
      api<void>(
        `/api/divisions/${divisionId}/managers/${userId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["divisions", "managers", vars.divisionId],
      });
    },
  });
}
