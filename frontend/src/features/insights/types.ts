// Wire types for /api/insights/* (MaugoodAI Insights). Mirrors the
// contract in the Insights brief — the backend reuses the PDF context
// builders in reporting/pdf.py, so these figures match the PDF.

export type InsightsStatus =
  | "present"
  | "late"
  | "absent"
  | "leave"
  | "weekend"
  | "holiday"
  | "waiting"
  | "no_record"
  | "present_weekend"
  | "present_holiday"
  | (string & {});

export interface InsightsPeriod {
  start: string;
  end: string;
  days: number;
  working_days: number;
  label: string;
  is_single_day: boolean;
  prev_label: string | null;
}

export interface InsightsScope {
  employees: number;
  departments: number;
  department_label: string | null;
}

export interface InsightsKpis {
  total: number;
  present: number;
  present_pct: number;
  late: number;
  early: number;
  absent: number;
  absent_pct: number;
  leave: number;
  ot_hours: number;
  ot_employees: number;
  avg_hours: number | null;
  avg_late_minutes: number | null;
  // v2 (optional until the backend ships them everywhere)
  attendance_pct?: number;
  punctuality_pct?: number | null;
  avg_in?: string | null;
  avg_out?: string | null;
  expected_days?: number;
  present_days?: number;
}

export interface InsightsBreakdownRow {
  key: string;
  label: string;
  count: number;
  share: number;
  delta: number | null;
  delta_good: boolean;
  delta_bad: boolean;
}

export interface InsightsTrendDay {
  date: string;
  weekday: string;
  is_weekend: boolean;
  is_holiday: boolean;
  holiday_name: string | null;
  present: number;
  late: number;
  absent: number;
  leave: number;
  headcount: number;
  present_pct: number;
}

export interface InsightsArrivalBucket {
  bucket: string;
  count: number;
}

export interface InsightsDepartmentRow {
  department_id: number;
  name: string;
  headcount: number;
  present: number;
  late: number;
  absent: number;
  leave: number;
  avg_hours: number | null;
  ot_hours: number;
  pct: number;
  // v2 (requested by the Departments page)
  attendance_pct?: number;
  punctuality_pct?: number | null;
  avg_in?: string | null;
  prev_attendance_pct?: number | null;
}

export interface InsightsException {
  employee_id: number;
  employee_code: string;
  full_name: string;
  department: string;
  date: string;
  status: InsightsStatus;
  in_time: string | null;
  out_time: string | null;
  hours: number | null;
  detail: string;
}

export interface InsightsOverview {
  period: InsightsPeriod;
  scope: InsightsScope;
  kpis: InsightsKpis;
  breakdown: InsightsBreakdownRow[];
  trend: InsightsTrendDay[];
  arrivals: InsightsArrivalBucket[];
  departments: InsightsDepartmentRow[];
  exceptions: InsightsException[];
  exceptions_total: number;
  /** Ranked over the whole period (not capped like `exceptions`). */
  top_late: InsightsTopPerson[];
  top_absent: InsightsTopPerson[];
  // v2
  compare?: InsightsCompare | null;
  weekday?: InsightsWeekday[];
  shift?: InsightsShift | null;
  watchlist?: InsightsWatchlist;
  heatmap?: InsightsHeatmap;
}

// ---------------------------------------------------------------------------
// v2 additions
// ---------------------------------------------------------------------------

/** Previous-period figures (same number of calendar days right before start). */
export interface InsightsCompareKpis {
  attendance_pct: number | null;
  punctuality_pct: number | null;
  avg_in: string | null;
  avg_hours: number | null;
  late: number;
  absent: number;
  leave: number;
  ot_hours: number;
  present_days: number;
  expected_days: number;
}

export interface InsightsCompare {
  label: string;
  start?: string;
  end?: string;
  kpis: InsightsCompareKpis;
}

/** One working weekday in the range (Mon=0). */
export interface InsightsWeekday {
  weekday: number;
  name: string;
  working_days: number;
  attendance_pct: number | null;
  punctuality_pct: number | null;
  late: number;
  absent: number;
}

/** Most common shift policy in scope — for chart markers. */
export interface InsightsShift {
  start: string;
  end: string;
  grace_minutes: number;
  name: string;
}

export interface InsightsWatchPerson {
  employee_id: number;
  employee_code: string;
  full_name: string;
  department: string;
  department_id: number | null;
  primary_photo_id: number | null;
  /** never_seen only: absent days in the period. */
  count?: number;
}

export interface InsightsWatchLate extends InsightsWatchPerson {
  count: number;
  avg_late_minutes: number | null;
}
export interface InsightsWatchAbsent extends InsightsWatchPerson {
  count: number;
  longest_streak: number;
}
export interface InsightsWatchEarly extends InsightsWatchPerson {
  count: number;
}
export interface InsightsWatchOvertime extends InsightsWatchPerson {
  ot_minutes: number;
}

export interface InsightsWatchlist {
  frequent_late: InsightsWatchLate[];
  repeated_absent: InsightsWatchAbsent[];
  early_leavers: InsightsWatchEarly[];
  overtime: InsightsWatchOvertime[];
  never_seen: InsightsWatchPerson[];
  totals: {
    frequent_late: number;
    repeated_absent: number;
    early_leavers: number;
    overtime: number;
    never_seen: number;
  };
}

export interface InsightsHeatmapRow {
  department_id: number;
  name: string;
  headcount: number;
  /** attendance % per entry of ``dates`` (null = no data). */
  cells: Array<number | null>;
}

export interface InsightsHeatmap {
  /** Working days only. */
  dates: string[];
  rows: InsightsHeatmapRow[];
}

/** Headline figures for "vs company / department" comparisons. */
export interface InsightsBenchmark {
  attendance_pct: number | null;
  punctuality_pct: number | null;
  avg_in: string | null;
  avg_hours: number | null;
}

// --- GET /api/insights/people ---------------------------------------------

export type InsightsAttentionReason = "late" | "absent" | "never_seen" | "early" | (string & {});

export type InsightsPeopleSort = "attention" | "name" | "attendance" | "punctuality" | "late" | "absent";

export interface InsightsPeopleItem {
  employee_id: number;
  employee_code: string;
  full_name: string;
  designation: string | null;
  department: string;
  department_id: number | null;
  primary_photo_id: number | null;
  attendance_pct: number | null;
  punctuality_pct: number | null;
  present_days: number;
  late_days: number;
  absent_days: number;
  leave_days: number;
  early_days?: number;
  avg_in: string | null;
  ot_minutes: number;
  needs_attention: boolean;
  attention_reasons: InsightsAttentionReason[];
}

export interface InsightsPeople {
  period: InsightsPeriod;
  total: number;
  page: number;
  page_size: number;
  items: InsightsPeopleItem[];
}

export interface InsightsPeopleQuery {
  departmentId?: number | null;
  q?: string;
  sort?: InsightsPeopleSort;
  page?: number;
  pageSize?: number;
}

export interface InsightsTopPerson {
  employee_id: number;
  employee_code: string;
  full_name: string;
  department: string;
  count: number;
  in_time: string | null;
}

export interface InsightsDepartmentEmployee {
  employee_id: number;
  employee_code: string;
  full_name: string;
  designation: string | null;
  present_days: number;
  late_days: number;
  absent_days: number;
  leave_days: number;
  avg_in: string | null;
  avg_out: string | null;
  avg_hours: number | null;
  ot_hours: number;
  pct: number;
  last_status: InsightsStatus;
  primary_photo_id: number | null;
  // v2
  punctuality_pct?: number | null;
  /** One status per calendar day of the period (sparkline strip). */
  strip?: InsightsStatus[];
}

export interface InsightsDepartment {
  department: {
    id: number;
    name: string;
    code: string;
    division: string | null;
    headcount: number;
    managers: string[];
  };
  period: InsightsPeriod;
  kpis: InsightsKpis;
  breakdown: InsightsBreakdownRow[];
  trend: InsightsTrendDay[];
  arrivals: InsightsArrivalBucket[];
  employees: InsightsDepartmentEmployee[];
  exceptions: InsightsException[];
  exceptions_total: number;
  // v2
  compare?: InsightsCompare | null;
  weekday?: InsightsWeekday[];
  shift?: InsightsShift | null;
  watchlist?: InsightsWatchlist;
  company?: InsightsBenchmark;
}

export interface InsightsEmployeeDay {
  date: string;
  weekday: string;
  status: InsightsStatus;
  in_time: string | null;
  out_time: string | null;
  hours: number | null;
  ot_minutes: number;
  late_minutes: number | null;
  flags: string[];
  first_event_id: number | null;
  last_event_id: number | null;
  camera: string | null;
  is_weekend: boolean;
  is_holiday: boolean;
  leave_name: string | null;
  // v2
  before_joining?: boolean;
}

export interface InsightsEmployee {
  profile: {
    id: number;
    employee_code: string;
    full_name: string;
    designation: string | null;
    department: string;
    department_id?: number | null;
    email: string | null;
    reports_to: string | null;
    joining_date: string | null;
    primary_photo_id: number | null;
  };
  policy: {
    name: string;
    type: string;
    window: string;
    required_hours: number;
    grace_minutes: number;
  } | null;
  period: InsightsPeriod;
  kpis: {
    working_days: number;
    present_days: number;
    late_days: number;
    absent_days: number;
    leave_days: number;
    early_days: number;
    short_days: number;
    punctuality_pct: number;
    attendance_pct: number;
    avg_in: string | null;
    avg_out: string | null;
    avg_hours: number | null;
    total_hours: number;
    ot_hours: number;
  };
  days: InsightsEmployeeDay[];
  requests: Array<{
    id: number;
    type: string;
    status: string;
    start: string;
    end: string | null;
    reason: string;
  }>;
  // v2
  compare?: {
    previous: (InsightsBenchmark & { late_days: number; absent_days: number; label?: string }) | null;
    department: InsightsBenchmark | null;
    company: InsightsBenchmark | null;
  };
  highlights?: {
    current_streak: { status: "present" | "absent" | (string & {}); days: number } | null;
    longest_present_streak: number;
    most_late_weekday: string | null;
    avg_late_minutes: number | null;
    /** Negative = arrives before shift start on average. */
    avg_minutes_vs_shift_start: number | null;
  };
}
