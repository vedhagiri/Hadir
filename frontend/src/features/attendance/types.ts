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
}

export interface AttendanceListResponse {
  date: string;
  items: AttendanceItem[];
}
