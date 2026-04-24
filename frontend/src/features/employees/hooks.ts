// TanStack Query hooks for the employees feature.
//
// The list query key is keyed on the filter inputs so TanStack Query
// automatically refetches + caches per distinct search. Mutations
// invalidate the list and the affected detail on success.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import type {
  Employee,
  EmployeeListResponse,
  ImportResult,
  PhotoIngestResult,
  PhotoListResponse,
} from "./types";

export interface EmployeeListFilters {
  q: string;
  department_id: number | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
}

export function useEmployeeList(
  filters: EmployeeListFilters,
): UseQueryResult<EmployeeListResponse, Error> {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.department_id !== null) {
    params.set("department_id", String(filters.department_id));
  }
  if (filters.include_inactive) params.set("include_inactive", "true");
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  const path = `/api/employees?${params.toString()}`;

  return useQuery({
    queryKey: ["employees", "list", filters],
    queryFn: () => api<EmployeeListResponse>(path),
    staleTime: 30 * 1000,
  });
}

export function useEmployeeDetail(
  employeeId: number | null,
): UseQueryResult<Employee, Error> {
  return useQuery({
    queryKey: ["employees", "detail", employeeId],
    queryFn: () => api<Employee>(`/api/employees/${employeeId}`),
    enabled: employeeId !== null,
  });
}

export function useEmployeePhotos(
  employeeId: number | null,
): UseQueryResult<PhotoListResponse, Error> {
  return useQuery({
    queryKey: ["employees", "photos", employeeId],
    queryFn: () => api<PhotoListResponse>(`/api/employees/${employeeId}/photos`),
    enabled: employeeId !== null,
  });
}

export function useImportEmployees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<ImportResult> => {
      const form = new FormData();
      form.append("file", file);
      return api<ImportResult>("/api/employees/import", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}

export function useBulkIngestPhotos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]): Promise<PhotoIngestResult> => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      return api<PhotoIngestResult>("/api/employees/photos/bulk", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}

interface DrawerUploadInput {
  employeeId: number;
  files: File[];
  angle: "front" | "left" | "right" | "other";
}

export function useEmployeePhotoUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DrawerUploadInput): Promise<PhotoIngestResult> => {
      const form = new FormData();
      for (const f of input.files) form.append("files", f, f.name);
      form.append("angle", input.angle);
      return api<PhotoIngestResult>(
        `/api/employees/${input.employeeId}/photos`,
        { method: "POST", body: form },
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({
        queryKey: ["employees", "photos", variables.employeeId],
      });
      qc.invalidateQueries({
        queryKey: ["employees", "detail", variables.employeeId],
      });
      qc.invalidateQueries({ queryKey: ["employees", "list"] });
    },
  });
}

export function useDeletePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { employeeId: number; photoId: number }): Promise<void> => {
      await api<null>(
        `/api/employees/${args.employeeId}/photos/${args.photoId}`,
        { method: "DELETE" },
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({
        queryKey: ["employees", "photos", variables.employeeId],
      });
      qc.invalidateQueries({
        queryKey: ["employees", "detail", variables.employeeId],
      });
      qc.invalidateQueries({ queryKey: ["employees", "list"] });
    },
  });
}
