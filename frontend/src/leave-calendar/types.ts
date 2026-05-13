// Wire types for /api/leave-types, /api/holidays, /api/approved-leaves,
// /api/tenant-settings.

export interface LeaveType {
  id: number;
  tenant_id: number;
  code: string;
  name: string;
  is_paid: boolean;
  active: boolean;
}

export interface LeaveTypeCreateInput {
  code: string;
  name: string;
  is_paid: boolean;
}

export interface LeaveTypePatchInput {
  name?: string;
  is_paid?: boolean;
  active?: boolean;
}

export interface Holiday {
  id: number;
  tenant_id: number;
  date: string; // YYYY-MM-DD
  name: string;
  active: boolean;
}

export interface HolidayCreateInput {
  date: string;
  name: string;
}

export interface HolidayImportSkipped {
  date: string;
  submitted_name: string;
  existing_name: string;
}

export interface HolidayImportResponse {
  imported: Holiday[];
  skipped: HolidayImportSkipped[];
  imported_count: number;
  skipped_count: number;
}

export interface ApprovedLeave {
  id: number;
  tenant_id: number;
  employee_id: number;
  leave_type_id: number;
  leave_type_code: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  notes: string | null;
  approved_by_user_id: number | null;
  approved_at: string;
}

export interface ApprovedLeaveCreateInput {
  employee_id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  notes?: string | null;
}

export interface TenantSettings {
  tenant_id: number;
  weekend_days: string[];
  timezone: string;
  updated_at: string;
}

export interface TenantSettingsPatchInput {
  weekend_days?: string[];
  timezone?: string;
}
