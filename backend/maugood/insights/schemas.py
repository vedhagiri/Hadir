"""Response models for ``/api/insights/*``.

Shapes follow the Insights API contract
(``/tmp/ui-agents/insights/BRIEF.md``). Times are ``HH:MM`` 24-hour
strings in the tenant's timezone; the frontend formats them. Crops and
photos are referenced by id only — never inlined.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel


class Period(BaseModel):
    start: date
    end: date
    days: int
    working_days: int
    label: str
    is_single_day: bool
    prev_label: Optional[str] = None


class Scope(BaseModel):
    employees: int
    departments: int
    department_label: Optional[str] = None


class Kpis(BaseModel):
    total: int
    present: int
    present_pct: int
    late: int
    early: int
    absent: int
    absent_pct: int
    leave: int
    ot_hours: float
    ot_employees: int
    avg_hours: Optional[float] = None
    avg_late_minutes: Optional[int] = None
    # v2
    attendance_pct: int = 0
    punctuality_pct: Optional[int] = None
    avg_in: Optional[str] = None
    avg_out: Optional[str] = None
    expected_days: int = 0
    present_days: int = 0


class BreakdownItem(BaseModel):
    key: str
    label: str
    count: int
    share: float
    delta: Optional[int] = None
    delta_good: bool
    delta_bad: bool


class TrendDay(BaseModel):
    date: date
    weekday: str
    is_weekend: bool
    is_holiday: bool
    holiday_name: Optional[str] = None
    present: int
    late: int
    absent: int
    leave: int
    headcount: int
    present_pct: int


class ArrivalBucket(BaseModel):
    bucket: str
    count: int


class DepartmentStat(BaseModel):
    department_id: Optional[int] = None
    name: str
    headcount: int
    present: int
    late: int
    absent: int
    leave: int
    avg_hours: Optional[float] = None
    ot_hours: float
    pct: int
    # v2
    attendance_pct: Optional[int] = None
    punctuality_pct: Optional[int] = None
    avg_in: Optional[str] = None
    prev_attendance_pct: Optional[int] = None


class ExceptionRow(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    department: str
    date: date
    status: str
    in_time: Optional[str] = None
    out_time: Optional[str] = None
    hours: Optional[float] = None
    detail: str


class TopPerson(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    department: str
    count: int
    in_time: Optional[str] = None


# ---------------------------------------------------------------------------
# v2 additions
# ---------------------------------------------------------------------------


class CompareKpis(BaseModel):
    attendance_pct: int
    punctuality_pct: Optional[int] = None
    avg_in: Optional[str] = None
    avg_hours: Optional[float] = None
    late: int
    absent: int
    leave: int
    ot_hours: float
    present_days: int
    expected_days: int


class Compare(BaseModel):
    label: str
    start: date
    end: date
    kpis: CompareKpis


class WeekdayStat(BaseModel):
    weekday: int
    name: str
    working_days: int
    attendance_pct: Optional[int] = None
    punctuality_pct: Optional[int] = None
    late: int
    absent: int


class ShiftInfo(BaseModel):
    name: str
    start: str
    end: str
    grace_minutes: int


class WatchPerson(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    department: str
    department_id: Optional[int] = None
    primary_photo_id: Optional[int] = None


class WatchLate(WatchPerson):
    count: int
    avg_late_minutes: Optional[int] = None


class WatchAbsent(WatchPerson):
    count: int
    longest_streak: int


class WatchCount(WatchPerson):
    count: int


class WatchOvertime(WatchPerson):
    ot_minutes: int


class WatchTotals(BaseModel):
    frequent_late: int
    repeated_absent: int
    early_leavers: int
    overtime: int
    never_seen: int


class Watchlist(BaseModel):
    frequent_late: list[WatchLate]
    repeated_absent: list[WatchAbsent]
    early_leavers: list[WatchCount]
    overtime: list[WatchOvertime]
    never_seen: list[WatchCount]
    totals: WatchTotals


class HeatmapRow(BaseModel):
    department_id: Optional[int] = None
    name: str
    headcount: int
    cells: list[Optional[int]]


class Heatmap(BaseModel):
    dates: list[date]
    rows: list[HeatmapRow]


class BriefStats(BaseModel):
    attendance_pct: int
    punctuality_pct: Optional[int] = None
    avg_in: Optional[str] = None
    avg_hours: Optional[float] = None


class PersonPrevious(BriefStats):
    late_days: int
    absent_days: int
    label: str


class EmployeeCompare(BaseModel):
    previous: Optional[PersonPrevious] = None
    department: Optional[BriefStats] = None
    company: Optional[BriefStats] = None


class Streak(BaseModel):
    status: str
    days: int


class Highlights(BaseModel):
    current_streak: Optional[Streak] = None
    longest_present_streak: int
    most_late_weekday: Optional[str] = None
    avg_late_minutes: Optional[int] = None
    avg_minutes_vs_shift_start: Optional[int] = None


class PersonItem(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    designation: Optional[str] = None
    department: str
    department_id: Optional[int] = None
    primary_photo_id: Optional[int] = None
    attendance_pct: Optional[int] = None
    punctuality_pct: Optional[int] = None
    present_days: int
    late_days: int
    absent_days: int
    leave_days: int
    early_days: int
    avg_in: Optional[str] = None
    ot_minutes: int
    needs_attention: bool
    attention_reasons: list[str]


class PeopleOut(BaseModel):
    period: Period
    total: int
    page: int
    page_size: int
    items: list[PersonItem]


class OverviewOut(BaseModel):
    period: Period
    scope: Scope
    kpis: Kpis
    breakdown: list[BreakdownItem]
    trend: list[TrendDay]
    arrivals: list[ArrivalBucket]
    departments: list[DepartmentStat]
    exceptions: list[ExceptionRow]
    exceptions_total: int
    top_late: list[TopPerson] = []
    top_absent: list[TopPerson] = []
    # v2
    compare: Optional[Compare] = None
    weekday: list[WeekdayStat] = []
    shift: Optional[ShiftInfo] = None
    watchlist: Optional[Watchlist] = None
    heatmap: Optional[Heatmap] = None


class DepartmentInfo(BaseModel):
    id: int
    name: str
    code: str
    division: Optional[str] = None
    headcount: int
    managers: list[str]


class DepartmentEmployee(BaseModel):
    employee_id: int
    employee_code: str
    full_name: str
    designation: Optional[str] = None
    present_days: int
    late_days: int
    absent_days: int
    leave_days: int
    avg_in: Optional[str] = None
    avg_out: Optional[str] = None
    avg_hours: Optional[float] = None
    ot_hours: float
    pct: int
    last_status: str
    primary_photo_id: Optional[int] = None
    # v2
    punctuality_pct: Optional[int] = None
    strip: list[str] = []


class DepartmentOut(BaseModel):
    department: DepartmentInfo
    period: Period
    kpis: Kpis
    breakdown: list[BreakdownItem]
    trend: list[TrendDay]
    arrivals: list[ArrivalBucket]
    employees: list[DepartmentEmployee]
    exceptions: list[ExceptionRow]
    exceptions_total: int
    # v2
    compare: Optional[Compare] = None
    weekday: list[WeekdayStat] = []
    shift: Optional[ShiftInfo] = None
    watchlist: Optional[Watchlist] = None
    company: Optional[BriefStats] = None


class EmployeeProfile(BaseModel):
    id: int
    department_id: Optional[int] = None
    employee_code: str
    full_name: str
    designation: Optional[str] = None
    department: str
    email: Optional[str] = None
    reports_to: Optional[str] = None
    joining_date: Optional[date] = None
    primary_photo_id: Optional[int] = None


class PolicyInfo(BaseModel):
    name: str
    type: str
    window: Optional[str] = None
    required_hours: int
    grace_minutes: Optional[int] = None


class EmployeeKpis(BaseModel):
    working_days: int
    present_days: int
    late_days: int
    absent_days: int
    leave_days: int
    early_days: int
    short_days: int
    punctuality_pct: int
    attendance_pct: int
    avg_in: Optional[str] = None
    avg_out: Optional[str] = None
    avg_hours: Optional[float] = None
    total_hours: float
    ot_hours: float


class EmployeeDay(BaseModel):
    date: date
    weekday: str
    status: str
    in_time: Optional[str] = None
    out_time: Optional[str] = None
    hours: Optional[float] = None
    ot_minutes: int
    late_minutes: Optional[int] = None
    flags: list[str]
    first_event_id: Optional[int] = None
    last_event_id: Optional[int] = None
    camera: Optional[str] = None
    is_weekend: bool
    is_holiday: bool
    leave_name: Optional[str] = None
    before_joining: bool = False


class EmployeeRequest(BaseModel):
    id: int
    type: str
    status: str
    start: date
    end: Optional[date] = None
    reason: str


class EmployeeOut(BaseModel):
    profile: EmployeeProfile
    policy: Optional[PolicyInfo] = None
    period: Period
    kpis: EmployeeKpis
    days: list[EmployeeDay]
    requests: list[EmployeeRequest]
    # v2
    compare: Optional[EmployeeCompare] = None
    highlights: Optional[Highlights] = None
