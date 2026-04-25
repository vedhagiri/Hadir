// TanStack Query hooks for the policies + assignments pages.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  AssignmentCreateInput,
  AssignmentResponse,
  PolicyCreateInput,
  PolicyPatchInput,
  PolicyResponse,
} from "./types";

const POLICIES_KEY = ["policies", "list"] as const;
const ASSIGNMENTS_KEY = ["policies", "assignments"] as const;

export function usePolicies(): UseQueryResult<PolicyResponse[], Error> {
  return useQuery({
    queryKey: POLICIES_KEY,
    queryFn: async () => api<PolicyResponse[]>("/api/policies"),
    staleTime: 30 * 1000,
  });
}

export function useAssignments(): UseQueryResult<AssignmentResponse[], Error> {
  return useQuery({
    queryKey: ASSIGNMENTS_KEY,
    queryFn: async () => api<AssignmentResponse[]>("/api/policy-assignments"),
    staleTime: 30 * 1000,
  });
}

export function useCreatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PolicyCreateInput): Promise<PolicyResponse> =>
      api<PolicyResponse>("/api/policies", { method: "POST", body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: POLICIES_KEY });
    },
  });
}

export function usePatchPolicy(policyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PolicyPatchInput): Promise<PolicyResponse> =>
      api<PolicyResponse>(`/api/policies/${policyId}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: POLICIES_KEY });
    },
  });
}

export function useDeletePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (policyId: number): Promise<void> => {
      await api<null>(`/api/policies/${policyId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: POLICIES_KEY });
    },
  });
}

export function useCreateAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: AssignmentCreateInput,
    ): Promise<AssignmentResponse> =>
      api<AssignmentResponse>("/api/policy-assignments", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
    },
  });
}

export function useDeleteAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assignmentId: number): Promise<void> => {
      await api<null>(`/api/policy-assignments/${assignmentId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
    },
  });
}
