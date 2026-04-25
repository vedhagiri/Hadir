// TanStack Query hooks for the custom-fields editor + per-employee values.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  CustomField,
  CustomFieldCreateInput,
  CustomFieldPatchInput,
  CustomFieldValue,
  CustomFieldValuePatchItem,
  ReorderItem,
} from "./types";

const FIELDS_KEY = ["custom-fields"] as const;

export function useCustomFields(): UseQueryResult<CustomField[], Error> {
  return useQuery({
    queryKey: FIELDS_KEY,
    queryFn: () => api<CustomField[]>("/api/custom-fields"),
    staleTime: 60 * 1000,
  });
}

export function useCreateCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomFieldCreateInput) =>
      api<CustomField>("/api/custom-fields", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FIELDS_KEY }),
  });
}

export function usePatchCustomField(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomFieldPatchInput) =>
      api<CustomField>(`/api/custom-fields/${id}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FIELDS_KEY }),
  });
}

export function useDeleteCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await api<null>(`/api/custom-fields/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FIELDS_KEY });
      // Values may have been wiped — invalidate any per-employee caches.
      qc.invalidateQueries({ queryKey: ["custom-field-values"] });
    },
  });
}

export function useReorderCustomFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ReorderItem[]) =>
      api<CustomField[]>("/api/custom-fields/reorder", {
        method: "POST",
        body: { items },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FIELDS_KEY }),
  });
}

// ---- Per-employee values --------------------------------------------------

export function useEmployeeCustomFieldValues(
  employeeId: number | null,
): UseQueryResult<CustomFieldValue[], Error> {
  return useQuery({
    queryKey: ["custom-field-values", employeeId],
    queryFn: () =>
      api<CustomFieldValue[]>(
        `/api/employees/${employeeId}/custom-fields`,
      ),
    enabled: employeeId !== null,
  });
}

export function usePatchEmployeeCustomFieldValues(employeeId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: CustomFieldValuePatchItem[]) =>
      api<CustomFieldValue[]>(
        `/api/employees/${employeeId}/custom-fields`,
        { method: "PATCH", body: { items } },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["custom-field-values", employeeId] }),
  });
}
