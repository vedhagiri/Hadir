// Sections CRUD hooks. Sections nest inside departments; the same
// code can be reused under different departments (OPS/QA + ENG/QA
// are distinct rows). Read open to every authenticated role;
// mutations gated to Admin/HR. Section managers (user_sections)
// see only employees assigned to that specific section.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";

export interface Section {
  id: number;
  code: string;
  name: string;
  department_id: number;
  department_code: string;
  department_name: string;
  employee_count: number;
}

export interface SectionListResponse {
  items: Section[];
}

export function useSections(
  departmentId: number | null = null,
): UseQueryResult<SectionListResponse, Error> {
  const path =
    departmentId !== null
      ? `/api/sections?department_id=${departmentId}`
      : "/api/sections";
  return useQuery({
    queryKey: ["sections", departmentId],
    queryFn: () => api<SectionListResponse>(path),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      code: string;
      name: string;
      department_id: number;
    }) =>
      api<Section>("/api/sections", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sections"] }),
  });
}

export function useUpdateSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api<Section>(`/api/sections/${id}`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sections"] }),
  });
}

export function useDeleteSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<void>(`/api/sections/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sections"] }),
  });
}

// ---------------------------------------------------------------------------
// Manager assignment (user_sections)
// ---------------------------------------------------------------------------

export interface SectionManager {
  user_id: number;
  full_name: string;
  email: string;
}

export interface SectionManagerListResponse {
  items: SectionManager[];
}

export function useSectionManagers(
  sectionId: number | null,
): UseQueryResult<SectionManagerListResponse, Error> {
  return useQuery({
    queryKey: ["sections", "managers", sectionId],
    queryFn: () =>
      api<SectionManagerListResponse>(
        `/api/sections/${sectionId}/managers`,
      ),
    enabled: sectionId !== null,
    staleTime: 60 * 1000,
  });
}

export function useAssignSectionManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionId, userId }: { sectionId: number; userId: number }) =>
      api<SectionManager>(
        `/api/sections/${sectionId}/managers`,
        { method: "POST", body: { user_id: userId } },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["sections", "managers", vars.sectionId],
      });
    },
  });
}

export function useRemoveSectionManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionId, userId }: { sectionId: number; userId: number }) =>
      api<void>(
        `/api/sections/${sectionId}/managers/${userId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["sections", "managers", vars.sectionId],
      });
    },
  });
}
