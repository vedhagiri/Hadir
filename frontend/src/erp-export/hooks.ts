// TanStack Query hooks for the ERP file-drop config page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../api/client";
import type { ErpExportConfig, ErpExportConfigPatch } from "./types";

const KEY = ["erp-export-config"] as const;

export function useErpExportConfig(): UseQueryResult<ErpExportConfig, Error> {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<ErpExportConfig>("/api/erp-export-config"),
    staleTime: 60 * 1000,
  });
}

export function usePatchErpExportConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ErpExportConfigPatch) =>
      api<ErpExportConfig>("/api/erp-export-config", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
