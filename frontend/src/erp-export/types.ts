// Wire types for /api/erp-export-config.

export type ErpFormat = "csv" | "json";

export interface ErpExportConfig {
  tenant_id: number;
  enabled: boolean;
  format: ErpFormat;
  output_path: string;
  schedule_cron: string;
  window_days: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_path: string | null;
  last_run_error: string | null;
  next_run_at: string | null;
  tenant_root: string;
}

export interface ErpExportConfigPatch {
  enabled?: boolean;
  format?: ErpFormat;
  output_path?: string;
  schedule_cron?: string;
  window_days?: number;
}
