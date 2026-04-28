// Departments CRUD hooks. Read open to every authenticated role
// (Employee Add drawer's department picker depends on this);
// write/delete gated to Admin/HR by the backend.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";

export interface Department {
  id: number;
  code: string;
  name: string;
  employee_count: number;
}

export interface DepartmentListResponse {
  items: Department[];
}

export function useDepartments(): UseQueryResult<DepartmentListResponse, Error> {
  return useQuery({
    queryKey: ["departments"],
    queryFn: () => api<DepartmentListResponse>("/api/departments"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string; name: string }) =>
      api<Department>("/api/departments", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api<Department>(`/api/departments/${id}`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/api/departments/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
}
