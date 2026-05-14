// TanStack Query hooks for the employees feature.
//
// The list query key is keyed on the filter inputs so TanStack Query
// automatically refetches + caches per distinct search. Mutations
// invalidate the list and the affected detail on success.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError, api } from "../../api/client";
import type {
  DeleteRequest,
  DeleteRequestListResponse,
  Employee,
  EmployeeListResponse,
  EmployeeWritePayload,
  ImportResult,
  PhotoIngestResult,
  PhotoListResponse,
  TeamMembersResponse,
} from "./types";

export type EmployeeSortBy = "employee_code" | "full_name" | "department";
export type EmployeeSortDir = "asc" | "desc";

export interface EmployeeListFilters {
  q: string;
  department_id: number | null;
  include_inactive: boolean;
  // BUG-015 / BUG-018 — server-side restriction so total + pagination
  // reflect a single status subset. Pass null to honour the legacy
  // include_inactive flag.
  status_filter?: "active" | "inactive" | "all" | null;
  page: number;
  page_size: number;
  // Sort knobs. Optional so existing call sites that don't care
  // about ordering keep working — we default to ``employee_code asc``
  // (matches the backend default).
  sort_by?: EmployeeSortBy;
  sort_dir?: EmployeeSortDir;
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
  if (filters.status_filter) {
    params.set("status_filter", filters.status_filter);
  }
  params.set("page", String(filters.page));
  params.set("page_size", String(filters.page_size));
  params.set("sort_by", filters.sort_by ?? "employee_code");
  params.set("sort_dir", filters.sort_dir ?? "asc");
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

// Maps the logged-in user → their employee record by email match.
// Returns ``null`` (not an error) when the account isn't linked to
// an employee — common for Admin/HR accounts that exist purely as
// operators. The 404 from the backend is treated as "no link" so
// the self-view pages can render an empty state cleanly instead of
// surfacing a query error.
export function useMyEmployee(): UseQueryResult<Employee | null, Error> {
  return useQuery({
    queryKey: ["employees", "me"],
    queryFn: async (): Promise<Employee | null> => {
      try {
        return await api<Employee>("/api/employees/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 5 * 60 * 1000,
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

export function useEmployeeTeamMembers(
  employeeId: number | null,
): UseQueryResult<TeamMembersResponse, Error> {
  return useQuery({
    queryKey: ["employees", "team-members", employeeId],
    queryFn: () =>
      api<TeamMembersResponse>(`/api/employees/${employeeId}/team-members`),
    enabled: employeeId !== null,
    staleTime: 60 * 1000,
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

export interface ImportPreviewRow {
  row: number;
  employee_code: string;
  full_name: string;
  email: string | null;
  designation: string | null;
  phone: string | null;
  division: string | null;
  department: string;
  section: string | null;
  joining_date: string | null;
  relieving_date: string | null;
  reports_to_email: string | null;
  defaulted_joining_date: boolean;
}

export interface ImportPreviewResult {
  rows: ImportPreviewRow[];
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
}

export function usePreviewImport() {
  return useMutation({
    mutationFn: async (file: File): Promise<ImportPreviewResult> => {
      const form = new FormData();
      form.append("file", file);
      return api<ImportPreviewResult>("/api/employees/import-preview", {
        method: "POST",
        body: form,
      });
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

// P28.7 — create + update employees with the extended field set.

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: EmployeeWritePayload): Promise<Employee> => {
      return api<Employee>("/api/employees", {
        method: "POST",
        body: payload,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees", "list"] });
    },
  });
}


// Direct soft-delete — sets status='inactive'. Operator request: Admin /
// HR / Manager can all do this without the HR-approval workflow.
// Hard-delete still routes through useSubmitDeleteRequest below.
export function useSoftDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (employeeId: number): Promise<void> => {
      await api<null>(`/api/employees/${employeeId}`, { method: "DELETE" });
    },
    onSuccess: (_v, employeeId) => {
      qc.invalidateQueries({ queryKey: ["employees", "list"] });
      qc.invalidateQueries({
        queryKey: ["employees", "detail", employeeId],
      });
    },
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      employeeId: number;
      payload: EmployeeWritePayload;
    }): Promise<Employee> => {
      return api<Employee>(`/api/employees/${args.employeeId}`, {
        method: "PATCH",
        body: args.payload,
      });
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({
        queryKey: ["employees", "detail", variables.employeeId],
      });
      qc.invalidateQueries({ queryKey: ["employees", "list"] });
    },
  });
}

// P28.7 — delete-request workflow.

export function useEmployeePendingDeleteRequest(
  employeeId: number | null,
): UseQueryResult<DeleteRequest | null, Error> {
  return useQuery({
    queryKey: ["delete-requests", "pending", employeeId],
    queryFn: () =>
      api<DeleteRequest | null>(
        `/api/employees/${employeeId}/delete-request`,
      ),
    enabled: employeeId !== null,
  });
}

export function useDeleteRequestList(): UseQueryResult<
  DeleteRequestListResponse,
  Error
> {
  return useQuery({
    queryKey: ["delete-requests", "list"],
    queryFn: () => api<DeleteRequestListResponse>("/api/delete-requests"),
    refetchInterval: 30 * 1000,
  });
}

export function useSubmitDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      employeeId: number;
      // Optional — operator may submit without a reason.
      reason: string | null;
    }): Promise<DeleteRequest> => {
      return api<DeleteRequest>(
        `/api/employees/${args.employeeId}/delete-request`,
        { method: "POST", body: { reason: args.reason } },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}

export function useDecideDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      employeeId: number;
      requestId: number;
      decision: "approve" | "reject";
      comment?: string;
    }): Promise<DeleteRequest> => {
      return api<DeleteRequest>(
        `/api/employees/${args.employeeId}/delete-request/${args.requestId}/decide`,
        {
          method: "POST",
          body: { decision: args.decision, comment: args.comment },
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}

export interface BulkDeleteRequest {
  scope: "selected" | "all";
  mode: "soft" | "hard";
  ids?: number[];
  confirmation?: string;
}

export interface BulkDeleteResponse {
  scope: "selected" | "all";
  mode: "soft" | "hard";
  requested: number;
  deleted: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export function useBulkDeleteEmployees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkDeleteRequest): Promise<BulkDeleteResponse> =>
      api<BulkDeleteResponse>("/api/employees/bulk-delete", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
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
