// TanStack Query hooks for the request submission UI.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type {
  AttachmentConfig,
  AttachmentRecord,
  DecisionInput,
  InboxSummary,
  ReasonCategory,
  ReasonCategoryCreateInput,
  ReasonCategoryPatchInput,
  RequestCreateInput,
  RequestRecord,
} from "./types";

const REQUESTS_KEY = ["requests"] as const;
const ATTACHMENT_CONFIG_KEY = ["requests", "attachment-config"] as const;
const REASON_CATEGORIES_KEY = ["request-reason-categories"] as const;

// ---- Requests -------------------------------------------------------------

export function useRequests(): UseQueryResult<RequestRecord[], Error> {
  return useQuery({
    queryKey: REQUESTS_KEY,
    queryFn: () => api<RequestRecord[]>("/api/requests"),
    staleTime: 30 * 1000,
  });
}

export function useRequest(
  id: number | null,
): UseQueryResult<RequestRecord, Error> {
  return useQuery({
    queryKey: ["requests", id],
    queryFn: () => api<RequestRecord>(`/api/requests/${id}`),
    enabled: id !== null,
  });
}

export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RequestCreateInput) =>
      api<RequestRecord>("/api/requests", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REQUESTS_KEY }),
  });
}

export function useCancelRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: number) =>
      api<RequestRecord>(`/api/requests/${requestId}/cancel`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REQUESTS_KEY }),
  });
}

// ---- Inbox (P15) ----------------------------------------------------------

const INBOX_PENDING_KEY = ["requests", "inbox", "pending"] as const;
const INBOX_DECIDED_KEY = ["requests", "inbox", "decided"] as const;
const INBOX_SUMMARY_KEY = ["requests", "inbox", "summary"] as const;

export function useInboxPending(): UseQueryResult<RequestRecord[], Error> {
  return useQuery({
    queryKey: INBOX_PENDING_KEY,
    queryFn: () => api<RequestRecord[]>("/api/requests/inbox/pending"),
    staleTime: 15 * 1000,
  });
}

export function useInboxDecided(): UseQueryResult<RequestRecord[], Error> {
  return useQuery({
    queryKey: INBOX_DECIDED_KEY,
    queryFn: () => api<RequestRecord[]>("/api/requests/inbox/decided"),
    staleTime: 30 * 1000,
  });
}

export function useInboxSummary(): UseQueryResult<InboxSummary, Error> {
  return useQuery({
    queryKey: INBOX_SUMMARY_KEY,
    queryFn: () => api<InboxSummary>("/api/requests/inbox/summary"),
    // Refetch on window focus so a manager who decides in another tab
    // sees the badge update when they come back.
    staleTime: 15 * 1000,
    refetchOnWindowFocus: true,
  });
}

// ---- Decisions ------------------------------------------------------------

function invalidateAfterDecision(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: REQUESTS_KEY });
  qc.invalidateQueries({ queryKey: INBOX_PENDING_KEY });
  qc.invalidateQueries({ queryKey: INBOX_DECIDED_KEY });
  qc.invalidateQueries({ queryKey: INBOX_SUMMARY_KEY });
}

export function useManagerDecide(requestId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecisionInput) =>
      api<RequestRecord>(`/api/requests/${requestId}/manager-decide`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => invalidateAfterDecision(qc),
  });
}

export function useHrDecide(requestId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecisionInput) =>
      api<RequestRecord>(`/api/requests/${requestId}/hr-decide`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => invalidateAfterDecision(qc),
  });
}

export function useAdminOverride(requestId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecisionInput) =>
      api<RequestRecord>(`/api/requests/${requestId}/admin-override`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => invalidateAfterDecision(qc),
  });
}

// ---- Attachments ----------------------------------------------------------

export function useAttachmentConfig(): UseQueryResult<AttachmentConfig, Error> {
  return useQuery({
    queryKey: ATTACHMENT_CONFIG_KEY,
    queryFn: () => api<AttachmentConfig>("/api/requests/attachment-config"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useRequestAttachments(
  requestId: number | null,
): UseQueryResult<AttachmentRecord[], Error> {
  return useQuery({
    queryKey: ["requests", requestId, "attachments"],
    queryFn: () =>
      api<AttachmentRecord[]>(`/api/requests/${requestId}/attachments`),
    enabled: requestId !== null,
  });
}

export function useUploadAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      requestId,
      file,
    }: {
      requestId: number;
      file: File;
    }): Promise<AttachmentRecord> => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      return api<AttachmentRecord>(
        `/api/requests/${requestId}/attachments`,
        { method: "POST", body: fd },
      );
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["requests", vars.requestId, "attachments"],
      });
    },
  });
}

export function useDeleteAttachment(requestId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (attachmentId: number): Promise<void> => {
      await api<null>(
        `/api/requests/${requestId}/attachments/${attachmentId}`,
        { method: "DELETE" },
      );
    },
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["requests", requestId, "attachments"],
      }),
  });
}

// ---- Reason categories ----------------------------------------------------

export function useReasonCategories(
  request_type?: "exception" | "leave",
): UseQueryResult<ReasonCategory[], Error> {
  const qs = request_type ? `?request_type=${request_type}` : "";
  return useQuery({
    queryKey: [...REASON_CATEGORIES_KEY, request_type ?? "all"],
    queryFn: () =>
      api<ReasonCategory[]>(`/api/request-reason-categories${qs}`),
    staleTime: 60 * 1000,
  });
}

export function useReasonCategoriesAll(
  includeInactive = true,
): UseQueryResult<ReasonCategory[], Error> {
  const qs = includeInactive ? "?include_inactive=true" : "";
  return useQuery({
    queryKey: [...REASON_CATEGORIES_KEY, "all", includeInactive],
    queryFn: () =>
      api<ReasonCategory[]>(`/api/request-reason-categories${qs}`),
    staleTime: 60 * 1000,
  });
}

export function useCreateReasonCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReasonCategoryCreateInput) =>
      api<ReasonCategory>("/api/request-reason-categories", {
        method: "POST",
        body: input,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: REASON_CATEGORIES_KEY }),
  });
}

export function usePatchReasonCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: ReasonCategoryPatchInput;
    }) =>
      api<ReasonCategory>(`/api/request-reason-categories/${id}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: REASON_CATEGORIES_KEY }),
  });
}

export function useDeleteReasonCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await api<null>(`/api/request-reason-categories/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: REASON_CATEGORIES_KEY }),
  });
}
