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
  // P29 (#3): top-tier hierarchy. Null when not assigned.
  division_id?: number | null;
  division_code?: string | null;
  division_name?: string | null;
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
    mutationFn: (input: {
      code: string;
      name: string;
      division_id?: number | null;
    }) =>
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
    mutationFn: ({
      id,
      name,
      division_id,
    }: {
      id: number;
      name?: string;
      division_id?: number | null;
    }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (division_id !== undefined) body.division_id = division_id;
      return api<Department>(`/api/departments/${id}`, {
        method: "PATCH",
        body,
      });
    },
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

// ---------------------------------------------------------------------------
// Department-manager assignment (user_departments)
// ---------------------------------------------------------------------------
//
// A Manager added here lands in user_departments and immediately
// gains visibility over every employee in this department via the
// existing get_manager_visible_employee_ids scope helper. Symmetric
// with the per-employee Manager Assignments page.

export interface DepartmentManager {
  user_id: number;
  full_name: string;
  email: string;
}

export interface DepartmentManagerListResponse {
  items: DepartmentManager[];
}

export function useDepartmentManagers(
  departmentId: number | null,
): UseQueryResult<DepartmentManagerListResponse, Error> {
  return useQuery({
    queryKey: ["departments", "managers", departmentId],
    queryFn: () =>
      api<DepartmentManagerListResponse>(
        `/api/departments/${departmentId}/managers`,
      ),
    enabled: departmentId !== null,
    staleTime: 60 * 1000,
  });
}

export function useAssignDepartmentManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, userId }: { departmentId: number; userId: number }) =>
      api<DepartmentManager>(
        `/api/departments/${departmentId}/managers`,
        { method: "POST", body: { user_id: userId } },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["departments", "managers", vars.departmentId],
      });
    },
  });
}

export function useRemoveDepartmentManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, userId }: { departmentId: number; userId: number }) =>
      api<void>(
        `/api/departments/${departmentId}/managers/${userId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["departments", "managers", vars.departmentId],
      });
    },
  });
}
