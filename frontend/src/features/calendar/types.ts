// Wire types for /api/attendance/calendar/*. Mirrors the Pydantic
// response models in backend/maugood/attendance_calendar/router.py.

export type CalendarStatus =
  | "present"
  | "escalation_present"
  | "late"
  | "absent"
  | "waiting"
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
  // Today-only count: employees marked absent who can still arrive
  // within the open shift window. Backend defaults to 0 on past +
  // future dates.
  waiting_count: number;
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
  // Late-breakdown helpers (Fixed-type policies only; null for Flex).
  policy_shift_start?: string | null;
  policy_grace_minutes?: number | null;
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
  policy_id?: number | null;
  policy_name?: string | null;
  policy_description?: string | null;
  policy_scope: string;
  // Structured policy facts so the drawer can render type-specific
  // copy without parsing freeform strings. Backed by columns added
  // in the same release; older clients see them as missing/null.
  policy_type?: "Fixed" | "Flex" | "Ramadan" | "Custom" | null;
  policy_required_hours?: number | null;
  policy_grace_minutes?: number | null;
  policy_shift_start?: string | null;
  policy_shift_end?: string | null;
  policy_in_window_start?: string | null;
  policy_in_window_end?: string | null;
  policy_out_window_start?: string | null;
  policy_out_window_end?: string | null;
  policy_range_start?: string | null;
  policy_range_end?: string | null;
  policy_custom_inner_type?: "Fixed" | "Flex" | null;
  timeline: TimelineInterval[];
  evidence: EvidenceCrop[];
  is_weekend: boolean;
  weekend_days: string[];
  is_holiday: boolean;
  holiday_name?: string | null;
  leave_name?: string | null;
  // Escalation confirmation (0063).
  escalation_confirmed: boolean;
  escalation_note?: string | null;
  escalation_request?: EscalationRequestSnapshot | null;
  // Absent sub-state helpers (only populated when status === "absent").
  camera_gaps: CameraGap[];
  pending_request?: PendingRequestSnapshot | null;
  approved_request?: ApprovedRequestSnapshot | null;
}

export interface EscalationRequestSnapshot {
  request_id: number;
  submitted_at: string;
  reason_category: string;
  reason_text?: string | null;
  manager_name?: string | null;
  manager_decision_at?: string | null;
  manager_comment?: string | null;
  hr_name?: string | null;
  hr_decision_at?: string | null;
  hr_comment?: string | null;
}

// ─ Absent sub-state helpers (populated only when status === "absent") ───────

export interface CameraGap {
  camera_id: number;
  camera_name: string;
  offline_from: string;   // ISO datetime with tz
  offline_to: string;     // ISO datetime with tz
  offline_minutes: number;
}

export interface PendingRequestSnapshot {
  request_id: number;
  request_type: string;   // 'exception' | 'escalation'
  status: string;         // e.g. 'submitted', 'manager_approved'
  submitted_at: string;
  reason_category: string;
  reason_text?: string | null;
  manager_name?: string | null;
}

export interface ApprovedRequestSnapshot {
  request_id: number;
  request_type: string;   // 'exception' | 'leave'
  submitted_at: string;
  reason_category: string;
  reason_text?: string | null;
  manager_name?: string | null;
  manager_decision_at?: string | null;
  manager_comment?: string | null;
  hr_name?: string | null;
  hr_decision_at?: string | null;
  hr_comment?: string | null;
}
