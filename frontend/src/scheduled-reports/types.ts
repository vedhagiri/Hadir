// Wire types for /api/email-config + /api/report-schedules + /api/report-runs.

export type EmailProvider = "smtp" | "microsoft_graph";

export interface EmailConfig {
  tenant_id: number;
  provider: EmailProvider;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_use_tls: boolean;
  has_smtp_password: boolean;
  graph_tenant_id: string;
  graph_client_id: string;
  has_graph_client_secret: boolean;
  from_address: string;
  from_name: string;
  enabled: boolean;
  updated_at: string;
}

export interface EmailConfigUpdate {
  provider?: EmailProvider;
  smtp_host?: string;
  smtp_port?: number;
  smtp_username?: string;
  smtp_password?: string;
  smtp_use_tls?: boolean;
  graph_tenant_id?: string;
  graph_client_id?: string;
  graph_client_secret?: string;
  from_address?: string;
  from_name?: string;
  enabled?: boolean;
}

export interface ReportFilterConfig {
  window_days: number;
  department_id?: number | null;
  employee_id?: number | null;
}

export type ReportFormat = "xlsx" | "pdf";

export interface ReportSchedule {
  id: number;
  tenant_id: number;
  name: string;
  report_type: "attendance";
  format: ReportFormat;
  filter_config: ReportFilterConfig;
  recipients: string[];
  schedule_cron: string;
  active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  next_run_at: string | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ReportScheduleCreateInput {
  name: string;
  format: ReportFormat;
  filter_config?: ReportFilterConfig;
  recipients: string[];
  schedule_cron: string;
  active?: boolean;
}

export interface ReportSchedulePatchInput {
  name?: string;
  format?: ReportFormat;
  filter_config?: ReportFilterConfig;
  recipients?: string[];
  schedule_cron?: string;
  active?: boolean;
}

export interface ReportRun {
  id: number;
  tenant_id: number;
  schedule_id: number | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  file_size_bytes: number | null;
  recipients_delivered_to: string[];
  error_message: string | null;
  delivery_mode: "attached" | "link" | null;
}
