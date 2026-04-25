// TanStack Query hooks for the manager-assignments page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  AssignmentResponse,
  AssignmentsListResponse,
} from "./types";

const LIST_KEY = ["manager-assignments", "list"] as const;

export function useAssignments(): UseQueryResult<
  AssignmentsListResponse,
  Error
> {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () =>
      api<AssignmentsListResponse>("/api/manager-assignments"),
    staleTime: 10 * 1000,
  });
}

export interface CreateAssignmentInput {
  manager_user_id: number;
  employee_id: number;
  is_primary: boolean;
}

export function useCreateAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: CreateAssignmentInput,
    ): Promise<AssignmentResponse> =>
      api<AssignmentResponse>("/api/manager-assignments", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useDeleteAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assignmentId: number): Promise<void> => {
      await api<null>(`/api/manager-assignments/${assignmentId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
