// Wire types for /api/attendance.

export interface DepartmentRef {
  id: number;
  code: string;
  name: string;
}

export interface PolicyRef {
  id: number;
  name: string;
}

export interface AttendanceItem {
  employee_id: number;
  employee_code: string;
  full_name: string;
  employee_status?: "active" | "inactive" | "deleted";
  department: DepartmentRef;
  date: string;
  in_time: string | null;
  out_time: string | null;
  total_minutes: number | null;
  policy: PolicyRef;
  late: boolean;
  early_out: boolean;
  short_hours: boolean;
  absent: boolean;
  overtime_minutes: number;
  leave_type_id: number | null;
  // Server-computed: true when this row is for today and the
  // employee hasn't checked in yet AND their shift hasn't ended.
  // Frontend renders "Waiting for login" instead of "Absent".
  pending?: boolean;
  // Per-row day context flags. Lets the pill say "Weekend" or
  // "Holiday — Eid" instead of falling through to "Present" on
  // rows that simply weren't expected to have a check-in.
  is_weekend?: boolean;
  is_holiday?: boolean;
  holiday_name?: string | null;
}

export interface AttendanceListResponse {
  date: string;
  items: AttendanceItem[];
}
