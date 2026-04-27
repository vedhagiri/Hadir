// Wire types for /api/attendance/calendar/*. Mirrors the Pydantic
// response models in backend/hadir/attendance_calendar/router.py.

export type CalendarStatus =
  | "present"
  | "late"
  | "absent"
  | "leave"
  | "weekend"
  | "holiday"
  | "future"
  | "no_record";

export interface CompanyDay {
  date: string;
  present_count: number;
  late_count: number;
  absent_count: number;
  leave_count: number;
  active_employees: number;
  is_weekend: boolean;
  is_holiday: boolean;
  holiday_name?: string | null;
  percent_present: number;
}

export interface CompanyMonth {
  month: string;
  days: CompanyDay[];
}

export interface PersonDay {
  date: string;
  status: CalendarStatus;
  in_time?: string | null;
  out_time?: string | null;
  total_minutes?: number | null;
  overtime_minutes: number;
  policy_name?: string | null;
  is_weekend: boolean;
  is_holiday: boolean;
  holiday_name?: string | null;
  leave_name?: string | null;
}

export interface PersonMonth {
  month: string;
  employee_id: number;
  employee_code: string;
  full_name: string;
  days: PersonDay[];
}

export interface TimelineInterval {
  start: string;
  end: string;
}

export interface EvidenceCrop {
  detection_event_id: number;
  captured_at: string;
  camera_code: string;
  confidence?: number | null;
  crop_url: string;
}

export interface DayDetail {
  employee_id: number;
  employee_code: string;
  full_name: string;
  department_name: string;
  date: string;
  status: CalendarStatus;
  in_time?: string | null;
  out_time?: string | null;
  total_minutes?: number | null;
  overtime_minutes: number;
  policy_name?: string | null;
  policy_description?: string | null;
  policy_scope: string;
  timeline: TimelineInterval[];
  evidence: EvidenceCrop[];
  is_weekend: boolean;
  is_holiday: boolean;
  holiday_name?: string | null;
  leave_name?: string | null;
}
