"""Aggregations + helpers for the attendance calendar (P28.6).

Architecture decisions documented in ``docs/phases/P28.6.md``:

* No new tables. The engine (P10) already produces one row per
  ``(employee, date)`` in ``attendance_records`` plus the flags
  ``late``, ``absent``, ``early_out``, ``short_hours``,
  ``overtime_minutes``. Plus ``approved_leaves`` covers leave dates;
  ``holidays`` covers holiday dates; ``tenant_settings.weekend_days``
  + ``timezone`` carry the weekend rule. Everything we need is
  already there.
* Status enum is computed server-side, not in JS:
  ``present | late | absent | leave | weekend | holiday | future |
  no_record``. Frontend stays dumb.
* Role scope is the same machinery the existing
  ``maugood.attendance.router`` uses (``manager_assignments`` +
  department membership union for Manager; email-match for
  Employee). No new RBAC code.
* Tenant isolation: every query filters on ``tenant_id`` via
  ``TenantScope``; cross-tenant employee_id lookups return 404 at
  the router boundary, not 403 (403 leaks role information).
"""

from __future__ import annotations

import calendar as _calendar
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, func, select
from sqlalchemy.engine import Connection

from maugood.attendance.repository import (
    holidays_on,
    load_tenant_settings,
    local_tz_for,
    policy_shift_end_times,
)
from maugood.db import (
    approved_leaves,
    attendance_records,
    camera_health_snapshots,
    cameras,
    departments,
    detection_events,
    employees,
    holidays,
    leave_types,
    requests as requests_table,
    shift_policies,
    users,
)
from maugood.tenants.scope import TenantScope


# Map Python's ``date.strftime("%A")`` → name match in the
# tenant_settings.weekend_days list.
_WEEKDAY_NAMES = (
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
)


# Status enum surfaced to the frontend for cell rendering.
STATUS_WAITING = "waiting"
STATUS_PRESENT = "present"
STATUS_ESCALATION_PRESENT = "escalation_present"
STATUS_LATE = "late"
STATUS_ABSENT = "absent"
STATUS_LEAVE = "leave"
STATUS_WEEKEND = "weekend"
STATUS_HOLIDAY = "holiday"
STATUS_FUTURE = "future"
STATUS_NO_RECORD = "no_record"


# ---------------------------------------------------------------------------
# Month bounds + day generator
# ---------------------------------------------------------------------------


def parse_month(month: str) -> tuple[date, date]:
    """``YYYY-MM`` → (first_day, last_day) inclusive. Raises ValueError
    on a malformed value."""

    if not isinstance(month, str) or len(month) != 7 or month[4] != "-":
        raise ValueError("month must be YYYY-MM")
    year = int(month[:4])
    mm = int(month[5:7])
    if mm < 1 or mm > 12:
        raise ValueError("month part must be 01-12")
    last_day = _calendar.monthrange(year, mm)[1]
    return date(year, mm, 1), date(year, mm, last_day)


def iter_days(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur = cur + timedelta(days=1)


def is_weekend(d: date, weekend_days: tuple[str, ...]) -> bool:
    return d.strftime("%A") in weekend_days


# ---------------------------------------------------------------------------
# Company view — daily aggregate
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CompanyDay:
    date: date
    present_count: int
    late_count: int
    absent_count: int
    waiting_count: int  # today only: shift window still open + no in_time
    leave_count: int
    active_employees: int
    is_weekend: bool
    is_holiday: bool
    holiday_name: Optional[str]
    percent_present: int  # 0-100, rounded


def company_view(
    conn: Connection,
    scope: TenantScope,
    *,
    month_start: date,
    month_end: date,
    department_ids: Optional[list[int]] = None,
    employee_ids: Optional[list[int]] = None,
) -> list[CompanyDay]:
    """One row per day in the month with aggregate counts.

    ``department_ids`` / ``employee_ids`` apply role scope:

    * Admin/HR with no filter → counts across every active employee
      in the tenant.
    * Manager → ``employee_ids = visible employee union`` so the
      counts are dept-only.

    ``active_employees`` is the headcount in the same scope: 25 for a
    Manager whose visible set is 25, 106 for an Admin in a 106-emp
    tenant. Worker-level filtering happens via the same join, not by
    post-filtering — keeps the SQL one query.
    """

    settings = load_tenant_settings(conn, scope)
    weekend_days = tuple(settings.weekend_days)

    # Active employee count for the scope. Engine convention from
    # P10: ``status='active'``.
    active_emp_filter = [
        employees.c.tenant_id == scope.tenant_id,
        employees.c.status == "active",
    ]
    if department_ids is not None:
        active_emp_filter.append(employees.c.department_id.in_(department_ids))
    if employee_ids is not None:
        active_emp_filter.append(employees.c.id.in_(employee_ids))
    active_count = int(
        conn.execute(
            select(func.count()).select_from(employees).where(*active_emp_filter)
        ).scalar_one()
    )

    # Per-day aggregate from attendance_records joined with employees
    # for the role-scoping filter. Single GROUP BY date.
    agg_filter = [
        attendance_records.c.tenant_id == scope.tenant_id,
        attendance_records.c.date >= month_start,
        attendance_records.c.date <= month_end,
        employees.c.tenant_id == scope.tenant_id,
        employees.c.id == attendance_records.c.employee_id,
    ]
    if department_ids is not None:
        agg_filter.append(employees.c.department_id.in_(department_ids))
    if employee_ids is not None:
        agg_filter.append(employees.c.id.in_(employee_ids))

    agg_stmt = (
        select(
            attendance_records.c.date.label("date"),
            func.count().label("rows"),
            func.sum(
                func.cast(attendance_records.c.absent, _bool_to_int())
            ).label("absent"),
            func.sum(
                func.cast(attendance_records.c.late, _bool_to_int())
            ).label("late"),
            func.sum(
                func.cast(
                    attendance_records.c.leave_type_id.isnot(None),
                    _bool_to_int(),
                )
            ).label("leave"),
            # ``check_ins`` = anyone with a real in_time on the row.
            # Late employees still check in, so they're included in
            # this sum and we subtract them out below for the strict
            # "on-time present" count surfaced by the calendar.
            func.sum(
                func.cast(
                    attendance_records.c.in_time.isnot(None),
                    _bool_to_int(),
                )
            ).label("check_ins"),
        )
        .where(*agg_filter)
        .group_by(attendance_records.c.date)
    )
    agg_rows = {r.date: r for r in conn.execute(agg_stmt).all()}

    # Holidays for the month (one query, indexed lookup by date).
    hol_rows = conn.execute(
        select(holidays.c.date, holidays.c.name).where(
            holidays.c.tenant_id == scope.tenant_id,
            holidays.c.date >= month_start,
            holidays.c.date <= month_end,
            holidays.c.active.is_(True),
        )
    ).all()
    holiday_by_date = {r.date: str(r.name) for r in hol_rows}

    # Today's "waiting" count — employees marked absent who can still
    # arrive within their shift window. Only today qualifies; past
    # dates' absent counts are authoritative. The lookup runs once
    # per call (today's date is at most one day in the range).
    tenant_tz = local_tz_for(settings)
    today_local = datetime.now(timezone.utc).astimezone(tenant_tz).date()
    waiting_today = 0
    if month_start <= today_local <= month_end:
        pending_filter = list(agg_filter) + [
            attendance_records.c.date == today_local,
            attendance_records.c.absent.is_(True),
            attendance_records.c.in_time.is_(None),
            attendance_records.c.leave_type_id.is_(None),
        ]
        pending_rows = conn.execute(
            select(
                attendance_records.c.employee_id,
                attendance_records.c.policy_id,
            ).where(*pending_filter)
        ).all()
        if pending_rows:
            policy_ids = sorted({int(r.policy_id) for r in pending_rows})
            shift_end_by_policy = policy_shift_end_times(
                conn, scope, policy_ids
            )
            now_local_time = datetime.now(timezone.utc).astimezone(
                tenant_tz
            ).time()
            for r in pending_rows:
                shift_end = shift_end_by_policy.get(int(r.policy_id))
                if shift_end is None:
                    continue
                if now_local_time < shift_end:
                    waiting_today += 1

    out: list[CompanyDay] = []
    for d in iter_days(month_start, month_end):
        agg = agg_rows.get(d)
        absent_raw = int(agg.absent or 0) if agg else 0
        late = int(agg.late or 0) if agg else 0
        leave = int(agg.leave or 0) if agg else 0
        check_ins = int(agg.check_ins or 0) if agg else 0
        # "Present" = on-time check-ins. The previous formula
        # (rows - absent - leave) silently counted weekend / pending
        # rows (no in_time, not marked absent) as present, which
        # showed "178 present" on a quiet weekend. Subtracting late
        # from check-ins gives a strict on-time count; the late
        # count surfaces alongside.
        present = max(0, check_ins - late)
        # ``absent`` rows from the engine include "on leave" rows
        # (engine sets absent=true + leave_type_id when on leave).
        # Subtract leave to get true no-show absences.
        absent = max(0, absent_raw - leave)
        # Today only: peel "waiting" out of the absent total so the
        # operator sees them as still-pending rather than already-
        # absent. The waiting bucket auto-empties as shift ends pass.
        waiting = waiting_today if d == today_local else 0
        absent = max(0, absent - waiting)
        weekend = is_weekend(d, weekend_days)
        hol_name = holiday_by_date.get(d)
        active = active_count
        # percent_present is rolled against the active headcount
        # (denominator) — so a tenant with 100 active employees and
        # 95 present rows reads 95%, not 95/96 (= 99%).
        percent = (
            int(round(100 * present / active)) if active > 0 else 0
        )
        out.append(
            CompanyDay(
                date=d,
                present_count=present,
                late_count=late,
                absent_count=absent,
                waiting_count=waiting,
                leave_count=leave,
                active_employees=active,
                is_weekend=weekend,
                is_holiday=hol_name is not None,
                holiday_name=hol_name,
                percent_present=max(0, min(100, percent)),
            )
        )
    return out


def _bool_to_int():  # type: ignore[no-untyped-def]
    """Postgres ``BOOLEAN -> INT`` cast for SUM aggregates."""

    from sqlalchemy.dialects.postgresql import INTEGER  # noqa: PLC0415

    return INTEGER


# ---------------------------------------------------------------------------
# Per-person view — one row per day
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PersonDay:
    date: date
    status: str
    in_time: Optional[str]
    out_time: Optional[str]
    total_minutes: Optional[int]
    overtime_minutes: int
    policy_name: Optional[str]
    is_weekend: bool
    is_holiday: bool
    holiday_name: Optional[str]
    leave_name: Optional[str]
    # Late-breakdown fields — populated for Fixed/Ramadan/Custom-Fixed
    # policies so the calendar cell and drawer can render
    # "Expected / Arrived / Late By" without a separate query.
    # Both None for Flex policies (window-based lateness, no single
    # expected start time).
    policy_shift_start: Optional[str]
    policy_grace_minutes: Optional[int]


def person_view(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    month_start: date,
    month_end: date,
    today_local: date,
) -> list[PersonDay]:
    """One row per day for one employee. Status computed per-day from
    the engine's flags + holidays + weekend + leaves + 'in the future'.
    """

    settings = load_tenant_settings(conn, scope)
    weekend_days = tuple(settings.weekend_days)

    # All attendance rows for this employee in the month, joined with
    # the policy + leave-type for naming.
    rows = conn.execute(
        select(
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.overtime_minutes,
            attendance_records.c.late,
            attendance_records.c.absent,
            attendance_records.c.locked,
            attendance_records.c.leave_type_id,
            attendance_records.c.policy_id,
            shift_policies.c.name.label("policy_name"),
            shift_policies.c.config.label("policy_config"),
            leave_types.c.name.label("leave_name"),
        )
        .select_from(
            attendance_records.join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
            ).outerjoin(
                leave_types,
                and_(
                    leave_types.c.id == attendance_records.c.leave_type_id,
                    leave_types.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.employee_id == employee_id,
            attendance_records.c.date >= month_start,
            attendance_records.c.date <= month_end,
        )
    ).all()
    by_date = {r.date: r for r in rows}

    # Approved leaves spanning the month for this employee — surfaced
    # for cells without an attendance row (e.g. a long leave block
    # where the engine hasn't materialised every day yet).
    leave_rows = conn.execute(
        select(
            approved_leaves.c.start_date,
            approved_leaves.c.end_date,
            leave_types.c.name,
        )
        .select_from(
            approved_leaves.join(
                leave_types,
                and_(
                    leave_types.c.id == approved_leaves.c.leave_type_id,
                    leave_types.c.tenant_id == approved_leaves.c.tenant_id,
                ),
            )
        )
        .where(
            approved_leaves.c.tenant_id == scope.tenant_id,
            approved_leaves.c.employee_id == employee_id,
            approved_leaves.c.start_date <= month_end,
            approved_leaves.c.end_date >= month_start,
        )
    ).all()

    def leave_name_for(d: date) -> Optional[str]:
        for lr in leave_rows:
            if lr.start_date <= d <= lr.end_date:
                return str(lr.name)
        return None

    # Holidays for the month.
    hol_rows = conn.execute(
        select(holidays.c.date, holidays.c.name).where(
            holidays.c.tenant_id == scope.tenant_id,
            holidays.c.date >= month_start,
            holidays.c.date <= month_end,
            holidays.c.active.is_(True),
        )
    ).all()
    holiday_by_date = {r.date: str(r.name) for r in hol_rows}

    # Per-policy shift-end map + tenant "now" for the today/waiting
    # check below. The map is empty if no attendance rows exist —
    # which short-circuits the waiting branch correctly.
    policy_ids_for_today = [
        int(r.policy_id)
        for r in rows
        if r.date == today_local
        and bool(r.absent)
        and r.in_time is None
        and r.leave_type_id is None
    ]
    shift_end_by_policy = (
        policy_shift_end_times(conn, scope, policy_ids_for_today)
        if policy_ids_for_today
        else {}
    )
    now_local_time = (
        datetime.now(timezone.utc).astimezone(local_tz_for(settings)).time()
    )

    out: list[PersonDay] = []
    for d in iter_days(month_start, month_end):
        weekend = is_weekend(d, weekend_days)
        hol_name = holiday_by_date.get(d)
        in_future = d > today_local
        ar = by_date.get(d)
        leave_name = leave_name_for(d)

        # Status priority:
        # 1. future > everything else (visual hint that the day hasn't
        #    happened yet)
        # 2. holiday > weekend (a public holiday on a weekend reads as
        #    holiday — the operator wants to see it)
        # 3. weekend (no work expected)
        # 4. leave (approved_leaves covers the date)
        # 5. waiting — today only, when the row is "absent" but the
        #    employee's shift window hasn't closed yet (flex / late
        #    arrival window still open). Treats them as pending, not
        #    absent. Falls through to absent automatically once the
        #    shift end passes.
        # 6. attendance flags: absent, late, present
        # 7. no_record (workday with neither attendance nor leave)
        # Leave wins over holiday / weekend (see fetch_day_detail note) so
        # the cell colour matches the day-detail drawer's leave template.
        if in_future:
            status = STATUS_FUTURE
        elif ar is not None and ar.leave_type_id is not None:
            status = STATUS_LEAVE
        elif leave_name is not None and ar is None:
            status = STATUS_LEAVE
        elif hol_name is not None:
            status = STATUS_HOLIDAY
        elif weekend:
            status = STATUS_WEEKEND
        elif (
            ar is not None
            and bool(ar.absent)
            and ar.in_time is None
            and d == today_local
            and (
                (shift_end := shift_end_by_policy.get(int(ar.policy_id)))
                is not None
            )
            and now_local_time < shift_end
        ):
            status = STATUS_WAITING
        elif ar is not None and bool(ar.absent):
            status = STATUS_ABSENT
        elif ar is not None and bool(getattr(ar, "locked", None)):
            # Attendance confirmed via escalation approval — distinct from
            # regular present so the calendar clearly shows the override.
            status = STATUS_ESCALATION_PRESENT
        elif ar is not None and bool(ar.late):
            status = STATUS_LATE
        elif ar is not None:
            status = STATUS_PRESENT
        else:
            status = STATUS_NO_RECORD

        # Extract shift_start + grace_minutes from the policy JSONB for
        # Fixed / Ramadan / Custom-Fixed policies so the calendar cell
        # can render a "Late by Xh Ym" row without a second query.
        # Flex policies carry in_window_start/end instead of a single
        # shift_start — leave both as None for that case.
        _policy_shift_start: Optional[str] = None
        _policy_grace_minutes: Optional[int] = None
        if ar is not None and ar.policy_config:
            _cfg = ar.policy_config
            if isinstance(_cfg, dict):
                _s = _cfg.get("start")
                if isinstance(_s, str) and _s:
                    _policy_shift_start = _s
                _g = _cfg.get("grace_minutes")
                try:
                    _policy_grace_minutes = int(_g) if _g is not None else None
                except (TypeError, ValueError):
                    pass

        out.append(
            PersonDay(
                date=d,
                status=status,
                in_time=ar.in_time.isoformat(timespec="seconds")
                if ar and ar.in_time is not None
                else None,
                out_time=ar.out_time.isoformat(timespec="seconds")
                if ar and ar.out_time is not None
                else None,
                total_minutes=int(ar.total_minutes)
                if ar and ar.total_minutes is not None
                else None,
                overtime_minutes=int(ar.overtime_minutes) if ar else 0,
                policy_name=str(ar.policy_name) if ar else None,
                is_weekend=weekend,
                is_holiday=hol_name is not None,
                holiday_name=hol_name,
                leave_name=str(ar.leave_name)
                if ar and ar.leave_name is not None
                else leave_name,
                policy_shift_start=_policy_shift_start,
                policy_grace_minutes=_policy_grace_minutes,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Day detail (drawer payload)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TimelineInterval:
    start: str  # ISO time HH:MM
    end: str


@dataclass(frozen=True, slots=True)
class EvidenceCrop:
    detection_event_id: int
    captured_at: str  # ISO time HH:MM:SS
    camera_code: str
    confidence: Optional[float]
    crop_url: str


@dataclass(frozen=True, slots=True)
class DayDetail:
    employee_id: int
    employee_code: str
    full_name: str
    department_name: str
    date: date
    status: str
    in_time: Optional[str]
    out_time: Optional[str]
    total_minutes: Optional[int]
    overtime_minutes: int
    policy_id: Optional[int]
    policy_name: Optional[str]
    policy_description: Optional[str]
    policy_scope: str
    # P28.9 — structured policy facts so the frontend's "Policy
    # applied" card can render type-specific copy without doing
    # JSONB introspection client-side. All times are ``HH:MM`` local
    # strings; dates are ``YYYY-MM-DD``. None on every field where
    # the policy type doesn't carry that knob.
    policy_type: Optional[str]
    policy_required_hours: Optional[int]
    policy_grace_minutes: Optional[int]
    policy_shift_start: Optional[str]
    policy_shift_end: Optional[str]
    policy_in_window_start: Optional[str]
    policy_in_window_end: Optional[str]
    policy_out_window_start: Optional[str]
    policy_out_window_end: Optional[str]
    policy_range_start: Optional[str]
    policy_range_end: Optional[str]
    policy_custom_inner_type: Optional[str]
    timeline: list[TimelineInterval]
    evidence: list[EvidenceCrop]
    is_weekend: bool
    weekend_days: list[str]
    is_holiday: bool
    holiday_name: Optional[str]
    leave_name: Optional[str]
    # Escalation-confirmed fields (0063).
    # ``escalation_confirmed`` is True when the attendance record has
    # been locked after a Manager+HR-approved escalation.
    escalation_confirmed: bool
    escalation_note: Optional[str]
    # Snapshot of the approved escalation request so the drawer can
    # render the approval chain without a second round-trip.
    escalation_request: Optional["EscalationRequestSnapshot"]
    # Absent sub-state helpers (only populated when status == absent).
    camera_gaps: list["CameraGap"]
    pending_request: Optional["PendingRequestSnapshot"]
    approved_request: Optional["ApprovedRequestSnapshot"]


@dataclass(frozen=True, slots=True)
class EscalationRequestSnapshot:
    """Subset of the approved escalation request shown in the drawer."""
    request_id: int
    submitted_at: str          # ISO datetime
    reason_category: str
    reason_text: Optional[str]
    manager_name: Optional[str]
    manager_decision_at: Optional[str]
    manager_comment: Optional[str]
    hr_name: Optional[str]
    hr_decision_at: Optional[str]
    hr_comment: Optional[str]


@dataclass(frozen=True, slots=True)
class CameraGap:
    """One offline period for a single camera during the employee's shift."""
    camera_id: int
    camera_name: str
    offline_from: str   # ISO datetime with tz
    offline_to: str     # ISO datetime with tz
    offline_minutes: int


@dataclass(frozen=True, slots=True)
class PendingRequestSnapshot:
    """An open (not-yet-decided) exception or escalation request for this day."""
    request_id: int
    request_type: str          # 'exception' | 'escalation'
    status: str                # e.g. 'submitted', 'manager_approved'
    submitted_at: str          # ISO datetime
    reason_category: str
    reason_text: Optional[str]
    manager_name: Optional[str]  # assigned manager (from requests.manager_user_id)


@dataclass(frozen=True, slots=True)
class ApprovedRequestSnapshot:
    """An approved exception/leave request (non-escalation) for this day."""
    request_id: int
    request_type: str
    submitted_at: str
    reason_category: str
    reason_text: Optional[str]
    manager_name: Optional[str]
    manager_decision_at: Optional[str]
    manager_comment: Optional[str]
    hr_name: Optional[str]
    hr_decision_at: Optional[str]
    hr_comment: Optional[str]


# Two detection events more than this many minutes apart on the same
# day are considered separate "in the office" intervals — anything
# closer collapses into one. 10 minutes mirrors the prototype's rough
# "lunch break" granularity.
TIMELINE_GAP_MINUTES = 10


def collapse_timeline(
    captured_times: list[time],
    *,
    gap_minutes: int = TIMELINE_GAP_MINUTES,
) -> list[TimelineInterval]:
    """Collapse a list of detection times (sorted ascending) into
    ``[start, end]`` intervals. Adjacent times within ``gap_minutes``
    of each other belong to the same interval.

    Pure logic — testable without a DB. Single-detection days produce
    a 0-length interval anchored on the lone time.
    """

    if not captured_times:
        return []
    sorted_times = sorted(captured_times)
    intervals: list[tuple[time, time]] = []
    cur_start = sorted_times[0]
    cur_end = sorted_times[0]
    for t in sorted_times[1:]:
        delta = (
            datetime.combine(date.min, t)
            - datetime.combine(date.min, cur_end)
        ).total_seconds()
        if delta <= gap_minutes * 60:
            cur_end = t
        else:
            intervals.append((cur_start, cur_end))
            cur_start = t
            cur_end = t
    intervals.append((cur_start, cur_end))
    return [
        TimelineInterval(
            start=s.isoformat(timespec="minutes"),
            end=e.isoformat(timespec="minutes"),
        )
        for s, e in intervals
    ]


def pick_evidence(
    events: list[dict],
    *,
    employee_id: int,
    in_time: Optional[time],
    out_time: Optional[time],
    max_crops: int = 24,
) -> list[EvidenceCrop]:
    """Pick evidence crops for the Day Detail drawer.

    Strategy:

    1. Drop events whose underlying file is missing (``has_crop=False``
       — those would return 404 from the crop endpoint).
    2. Collapse multiple events captured in the same wall-clock minute
       to a single thumbnail (highest confidence wins; tie → lowest
       id). Prevents three near-identical crops from one dwell.
    3. If the deduped set is ≤ ``max_crops``, return everything sorted
       chronologically — an operator who manually mapped 7 faces
       wants to see all 7.
    4. Otherwise bucket-sample across five time-of-day windows so the
       operator still sees a representative spread (arrival / morning
       / midday / afternoon / departure / edge) rather than a packed
       block from one busy hour. Per-bucket cap = ``max_crops // 5``.
    """

    def parse_t(iso: str) -> time:
        # Accept either "HH:MM:SS" or full datetime ISO strings.
        if "T" in iso:
            return datetime.fromisoformat(iso).time()
        h, m, s = iso.split(":")
        return time(int(h), int(m), int(float(s)))

    def _to_crop(ev: dict) -> EvidenceCrop:
        return EvidenceCrop(
            detection_event_id=int(ev["id"]),
            captured_at=str(ev["captured_at"]),
            camera_code=str(ev.get("camera_name") or "CAM"),
            confidence=(
                float(ev["confidence"])
                if ev.get("confidence") is not None
                else None
            ),
            crop_url=(
                f"/api/attendance/calendar/evidence/"
                f"{employee_id}/{int(ev['id'])}/crop"
            ),
        )

    cropped = [ev for ev in events if ev.get("has_crop")]
    if not cropped:
        return []

    # Minute-level dedupe — collapse multiple events captured within
    # the same wall-clock minute to one tile so the gallery doesn't
    # show three near-identical crops from the same dwell. Within a
    # minute we prefer the highest-confidence event (auto-matches
    # carry confidence; manual maps don't, so they sort last) and
    # break ties by lowest id (first captured wins). One thumbnail
    # per minute matches the operator mental model in the example
    # "5:01 → one image, 5:02 → another image".
    by_minute: dict[str, dict] = {}
    for ev in cropped:
        t = parse_t(ev["captured_at"])
        minute_key = f"{t.hour:02d}:{t.minute:02d}"
        prev = by_minute.get(minute_key)
        if prev is None:
            by_minute[minute_key] = ev
            continue
        prev_conf = prev.get("confidence") if prev.get("confidence") is not None else -1.0
        this_conf = ev.get("confidence") if ev.get("confidence") is not None else -1.0
        if this_conf > prev_conf or (
            this_conf == prev_conf and int(ev["id"]) < int(prev["id"])
        ):
            by_minute[minute_key] = ev
    cropped = list(by_minute.values())

    # Small-set fast path: show every (deduped) mapped event. Re-sort
    # defensively in case a caller passes an unordered list.
    if len(cropped) <= max_crops:
        cropped.sort(key=lambda e: parse_t(e["captured_at"]))
        return [_to_crop(ev) for ev in cropped]

    # Large-set path: bucket-sample so the drawer doesn't dump all
    # 100+ thumbnails. Per-bucket cap derived from max_crops so the
    # five buckets together stay near the limit.
    per_bucket_cap = max(1, max_crops // 5)
    by_bucket: dict[str, list[dict]] = {
        "arrival": [],
        "morning": [],
        "midday": [],
        "afternoon": [],
        "departure": [],
    }
    for ev in cropped:
        t = parse_t(ev["captured_at"])
        in_t = in_time
        out_t = out_time
        in_minus_30 = _shift(in_t, -30) if in_t else None
        in_plus_30 = _shift(in_t, +30) if in_t else None
        out_minus_30 = _shift(out_t, -30) if out_t else None
        out_plus_30 = _shift(out_t, +30) if out_t else None

        if in_t and in_minus_30 and in_plus_30 and in_minus_30 <= t <= in_plus_30:
            by_bucket["arrival"].append(ev)
            continue
        if out_t and out_minus_30 and out_plus_30 and out_minus_30 <= t <= out_plus_30:
            by_bucket["departure"].append(ev)
            continue
        if time(11, 0) <= t <= time(14, 0):
            by_bucket["midday"].append(ev)
            continue
        if in_plus_30 is not None and t < time(12, 0) and t >= in_plus_30:
            by_bucket["morning"].append(ev)
            continue
        if out_minus_30 is not None and t >= time(14, 0) and t < out_minus_30:
            by_bucket["afternoon"].append(ev)
            continue
        # Outside every bucket (very-early or very-late) — keep it,
        # we'll fold these into a synthetic "edge" bucket below so a
        # 4 AM / 11 PM event isn't silently dropped.
        by_bucket.setdefault("edge", []).append(ev)

    chosen: list[dict] = []
    for bucket_name in (
        "arrival",
        "morning",
        "midday",
        "afternoon",
        "departure",
        "edge",
    ):
        bucket = by_bucket.get(bucket_name, [])
        if not bucket:
            continue
        bucket.sort(key=lambda e: parse_t(e["captured_at"]))
        chosen.extend(bucket[:per_bucket_cap])
        if len(chosen) >= max_crops:
            break

    chosen = chosen[:max_crops]
    chosen.sort(key=lambda e: parse_t(e["captured_at"]))
    return [_to_crop(ev) for ev in chosen]


def _shift(t: time, minutes: int) -> Optional[time]:
    """Add ``minutes`` to a ``time``; clamps at 00:00 / 23:59.

    Uses a mid-calendar pivot date so a check-in at 00:19 minus 30
    minutes (and similar boundary cases) stays well clear of the
    ``date.min`` underflow that crashes ``datetime.combine``.
    """

    pivot = date(2000, 1, 1)
    base = datetime.combine(pivot, t) + timedelta(minutes=minutes)
    if base.date() != pivot:
        if base.date() < pivot:
            return time(0, 0)
        return time(23, 59)
    return base.time()


_MIN_GAP_MINUTES = 5  # ignore brief blips shorter than this


def _build_camera_gaps(
    offline_rows: list,
    *,
    min_gap_minutes: int = _MIN_GAP_MINUTES,
) -> list[CameraGap]:
    """Merge consecutive offline health-snapshot rows per camera into CameraGap
    intervals. Snapshot cadence is ~60 s; rows within 90 s of each other belong
    to the same outage. Outages shorter than ``min_gap_minutes`` are noise and
    are dropped."""
    if not offline_rows:
        return []

    by_camera: dict[int, list] = {}
    for r in offline_rows:
        by_camera.setdefault(int(r.camera_id), []).append(r)

    gaps: list[CameraGap] = []
    for cam_id, rows in by_camera.items():
        cam_name = str(rows[0].camera_name or f"CAM-{cam_id}")
        cur_start = rows[0].captured_at
        cur_end = rows[0].captured_at

        for row in rows[1:]:
            diff_s = (row.captured_at - cur_end).total_seconds()
            if diff_s <= 90:
                cur_end = row.captured_at
            else:
                mins = max(1, int((cur_end - cur_start).total_seconds() / 60) + 1)
                if mins >= min_gap_minutes:
                    gaps.append(
                        CameraGap(
                            camera_id=cam_id,
                            camera_name=cam_name,
                            offline_from=cur_start.isoformat(),
                            offline_to=cur_end.isoformat(),
                            offline_minutes=mins,
                        )
                    )
                cur_start = row.captured_at
                cur_end = row.captured_at

        mins = max(1, int((cur_end - cur_start).total_seconds() / 60) + 1)
        if mins >= min_gap_minutes:
            gaps.append(
                CameraGap(
                    camera_id=cam_id,
                    camera_name=cam_name,
                    offline_from=cur_start.isoformat(),
                    offline_to=cur_end.isoformat(),
                    offline_minutes=mins,
                )
            )

    return gaps


def fetch_day_detail(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
) -> Optional[DayDetail]:
    """Build the drawer payload. Returns None if the employee row
    isn't in the tenant (caller 404s)."""

    emp_row = conn.execute(
        select(
            employees.c.id,
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.department_id,
            departments.c.name.label("department_name"),
        )
        .select_from(
            employees.join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
    ).first()
    if emp_row is None:
        return None

    settings = load_tenant_settings(conn, scope)
    weekend_days = tuple(settings.weekend_days)

    # Attendance row + policy.
    ar = conn.execute(
        select(
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.overtime_minutes,
            attendance_records.c.late,
            attendance_records.c.absent,
            attendance_records.c.leave_type_id,
            attendance_records.c.locked,
            attendance_records.c.escalation_note,
            shift_policies.c.id.label("policy_id"),
            shift_policies.c.name.label("policy_name"),
            shift_policies.c.type.label("policy_type"),
            shift_policies.c.config.label("policy_config"),
            leave_types.c.name.label("leave_name"),
        )
        .select_from(
            attendance_records.join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
            ).outerjoin(
                leave_types,
                and_(
                    leave_types.c.id == attendance_records.c.leave_type_id,
                    leave_types.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.employee_id == employee_id,
            attendance_records.c.date == the_date,
        )
    ).first()

    hol = holidays_on(conn, scope, the_date=the_date)
    hol_name = hol[0].name if hol else None
    weekend = is_weekend(the_date, weekend_days)

    local_tz = local_tz_for(settings)
    now_local = datetime.now(timezone.utc).astimezone(local_tz)
    today_local = now_local.date()
    now_local_time = now_local.time()
    in_future = the_date > today_local

    # Status — mirrors person_view priority exactly, including the
    # "waiting" branch that was previously missing here (causing the
    # drawer to show "absent" when the Per-Person cell showed "waiting").
    # Leave is the most specific, intentional status for an employee on a
    # given day, so it wins over holiday / weekend — an approved leave the
    # operator set must surface (and get its own template) rather than read
    # as a generic "week off".
    if in_future:
        status = STATUS_FUTURE
    elif ar is not None and ar.leave_type_id is not None:
        status = STATUS_LEAVE
    elif hol_name is not None:
        status = STATUS_HOLIDAY
    elif weekend:
        status = STATUS_WEEKEND
    elif (
        ar is not None
        and bool(ar.absent)
        and ar.in_time is None
        and the_date == today_local
    ):
        # Waiting — today-only: shift window still open. Resolve the
        # policy's shift-end for this single attendance row so we can
        # compare against the local clock.
        shift_end_map = policy_shift_end_times(
            conn, scope, [int(ar.policy_id)]
        )
        shift_end = shift_end_map.get(int(ar.policy_id))
        if shift_end is not None and now_local_time < shift_end:
            status = STATUS_WAITING
        else:
            status = STATUS_ABSENT
    elif ar is not None and bool(ar.absent):
        status = STATUS_ABSENT
    elif ar is not None and bool(ar.locked):
        status = STATUS_ESCALATION_PRESENT
    elif ar is not None and bool(ar.late):
        status = STATUS_LATE
    elif ar is not None:
        status = STATUS_PRESENT
    else:
        status = STATUS_NO_RECORD

    # Policy description from the JSONB ``description`` field, when
    # present. Defensive — older policies may not have it.
    policy_description: Optional[str] = None
    policy_scope = "tenant-default"
    # P28.9 — structured policy facts the frontend renders directly.
    # Sourced from the ``config`` JSONB; the exact key set varies per
    # ``policy.type`` (see ``maugood/attendance/engine.py::policy_from_row``
    # for the authoritative read of each shape).
    policy_type_out: Optional[str] = None
    policy_required_hours: Optional[int] = None
    policy_grace_minutes: Optional[int] = None
    policy_shift_start: Optional[str] = None
    policy_shift_end: Optional[str] = None
    policy_in_window_start: Optional[str] = None
    policy_in_window_end: Optional[str] = None
    policy_out_window_start: Optional[str] = None
    policy_out_window_end: Optional[str] = None
    policy_range_start: Optional[str] = None
    policy_range_end: Optional[str] = None
    policy_custom_inner_type: Optional[str] = None
    if ar is not None:
        cfg = ar.policy_config or {}
        if isinstance(cfg, dict):
            d = cfg.get("description")
            if isinstance(d, str) and d:
                policy_description = d
            scope_val = cfg.get("scope")
            if isinstance(scope_val, str) and scope_val:
                policy_scope = scope_val
            policy_type_out = str(ar.policy_type)
            try:
                policy_required_hours = int(cfg.get("required_hours", 8))
            except (TypeError, ValueError):
                policy_required_hours = 8
            # Pluck the HH:MM and YYYY-MM-DD strings if present.
            def _str_or_none(v: object) -> Optional[str]:
                return v if isinstance(v, str) and v else None

            policy_shift_start = _str_or_none(cfg.get("start"))
            policy_shift_end = _str_or_none(cfg.get("end"))
            policy_in_window_start = _str_or_none(cfg.get("in_window_start"))
            policy_in_window_end = _str_or_none(cfg.get("in_window_end"))
            policy_out_window_start = _str_or_none(cfg.get("out_window_start"))
            policy_out_window_end = _str_or_none(cfg.get("out_window_end"))
            policy_range_start = _str_or_none(cfg.get("start_date"))
            policy_range_end = _str_or_none(cfg.get("end_date"))
            inner = cfg.get("inner_type")
            if isinstance(inner, str) and inner in ("Fixed", "Flex"):
                policy_custom_inner_type = inner
            if policy_shift_end or policy_shift_start:
                try:
                    policy_grace_minutes = int(cfg.get("grace_minutes", 15))
                except (TypeError, ValueError):
                    policy_grace_minutes = 15

    # Detection events for that local day → timeline + evidence.
    day_start = datetime.combine(
        the_date, time(0, 0), tzinfo=local_tz
    ).astimezone(timezone.utc)
    day_end = datetime.combine(
        the_date, time(23, 59, 59), tzinfo=local_tz
    ).astimezone(timezone.utc)
    ev_rows = conn.execute(
        select(
            detection_events.c.id,
            detection_events.c.captured_at,
            detection_events.c.confidence,
            detection_events.c.face_crop_path,
            cameras.c.name.label("camera_name"),
        )
        .select_from(
            detection_events.outerjoin(
                cameras,
                and_(
                    cameras.c.id == detection_events.c.camera_id,
                    cameras.c.tenant_id == detection_events.c.tenant_id,
                ),
            )
        )
        .where(
            detection_events.c.tenant_id == scope.tenant_id,
            detection_events.c.employee_id == employee_id,
            detection_events.c.captured_at >= day_start,
            detection_events.c.captured_at <= day_end,
        )
        .order_by(detection_events.c.captured_at.asc())
    ).all()

    captured_times: list[time] = []
    event_dicts: list[dict] = []
    for r in ev_rows:
        # Convert UTC captured_at → local time for the timeline.
        local_dt = r.captured_at.astimezone(local_tz)
        captured_times.append(local_dt.time())
        event_dicts.append(
            {
                "id": int(r.id),
                "captured_at": local_dt.time().isoformat(timespec="seconds"),
                "confidence": (
                    float(r.confidence) if r.confidence is not None else None
                ),
                "camera_name": r.camera_name,
                # has_crop mirrors the detection_events router rule:
                # face_crop_path NULL = orphan/unavailable.
                "has_crop": r.face_crop_path is not None,
            }
        )

    timeline = collapse_timeline(captured_times)
    evidence = pick_evidence(
        event_dicts,
        employee_id=int(emp_row.id),
        in_time=ar.in_time if ar is not None else None,
        out_time=ar.out_time if ar is not None else None,
    )

    # Escalation confirmation — check if the attendance record is
    # locked and load the approved escalation request for the drawer.
    escalation_confirmed = bool(ar is not None and ar.locked)
    escalation_note_val: Optional[str] = (
        str(ar.escalation_note)
        if ar is not None and ar.escalation_note is not None
        else None
    )
    esc_snapshot: Optional[EscalationRequestSnapshot] = None
    if escalation_confirmed:
        mgr_users = users.alias("mgr_users")
        hr_users = users.alias("hr_users")
        esc_row = conn.execute(
            select(
                requests_table.c.id,
                requests_table.c.submitted_at,
                requests_table.c.reason_category,
                requests_table.c.reason_text,
                mgr_users.c.full_name.label("manager_name"),
                requests_table.c.manager_decision_at,
                requests_table.c.manager_comment,
                hr_users.c.full_name.label("hr_name"),
                requests_table.c.hr_decision_at,
                requests_table.c.hr_comment,
            )
            .select_from(
                requests_table
                .outerjoin(
                    mgr_users,
                    requests_table.c.manager_user_id == mgr_users.c.id,
                )
                .outerjoin(
                    hr_users,
                    requests_table.c.hr_user_id == hr_users.c.id,
                )
            )
            .where(
                requests_table.c.tenant_id == scope.tenant_id,
                requests_table.c.employee_id == int(emp_row.id),
                requests_table.c.type == "escalation",
                requests_table.c.target_date_start == the_date,
                requests_table.c.status.in_(
                    ("hr_approved", "admin_approved")
                ),
            )
            .order_by(requests_table.c.id.desc())
            .limit(1)
        ).first()
        if esc_row is not None:
            esc_snapshot = EscalationRequestSnapshot(
                request_id=int(esc_row.id),
                submitted_at=esc_row.submitted_at.isoformat(),
                reason_category=str(esc_row.reason_category),
                reason_text=str(esc_row.reason_text)
                if esc_row.reason_text
                else None,
                manager_name=str(esc_row.manager_name)
                if esc_row.manager_name
                else None,
                manager_decision_at=esc_row.manager_decision_at.isoformat()
                if esc_row.manager_decision_at
                else None,
                manager_comment=str(esc_row.manager_comment)
                if esc_row.manager_comment
                else None,
                hr_name=str(esc_row.hr_name) if esc_row.hr_name else None,
                hr_decision_at=esc_row.hr_decision_at.isoformat()
                if esc_row.hr_decision_at
                else None,
                hr_comment=str(esc_row.hr_comment)
                if esc_row.hr_comment
                else None,
            )

    # --- Absent sub-state helpers ----------------------------------------
    # Only queried when the day is genuinely absent — skip for present,
    # late, leave, holiday, etc. to keep the hot path cheap.
    _camera_gaps: list[CameraGap] = []
    _pending_request: Optional[PendingRequestSnapshot] = None
    _approved_request: Optional[ApprovedRequestSnapshot] = None

    if status == STATUS_ABSENT:
        # 1. Camera gaps — offline periods during the employee's shift window.
        # Build the UTC shift window from the extracted policy times.
        from datetime import time as _time_type  # noqa: PLC0415
        try:
            if policy_shift_start:
                _sh, _sm = (int(x) for x in policy_shift_start.split(":")[:2])
                _win_start_utc = datetime.combine(
                    the_date, _time_type(_sh, _sm), tzinfo=local_tz
                ).astimezone(timezone.utc)
            else:
                _win_start_utc = day_start  # already computed above

            if policy_shift_end:
                _eh, _em = (int(x) for x in policy_shift_end.split(":")[:2])
                _win_end_utc = datetime.combine(
                    the_date, _time_type(_eh, _em), tzinfo=local_tz
                ).astimezone(timezone.utc)
            else:
                _win_end_utc = day_end  # already computed above
        except (ValueError, TypeError):
            _win_start_utc = day_start
            _win_end_utc = day_end

        offline_rows = conn.execute(
            select(
                camera_health_snapshots.c.camera_id,
                camera_health_snapshots.c.captured_at,
                cameras.c.name.label("camera_name"),
            )
            .select_from(
                camera_health_snapshots.join(
                    cameras,
                    and_(
                        cameras.c.id == camera_health_snapshots.c.camera_id,
                        cameras.c.tenant_id == camera_health_snapshots.c.tenant_id,
                    ),
                )
            )
            .where(
                camera_health_snapshots.c.tenant_id == scope.tenant_id,
                camera_health_snapshots.c.reachable.is_(False),
                camera_health_snapshots.c.captured_at >= _win_start_utc,
                camera_health_snapshots.c.captured_at <= _win_end_utc,
            )
            .order_by(
                camera_health_snapshots.c.camera_id,
                camera_health_snapshots.c.captured_at,
            )
        ).all()
        _camera_gaps = _build_camera_gaps(list(offline_rows))

        # 2. Pending request — any open (non-terminal) request for this day.
        _TERMINAL_STATUSES = (
            "hr_approved", "admin_approved",
            "manager_rejected", "hr_rejected", "admin_rejected", "cancelled",
        )
        mgr_alias = users.alias("mgr_alias")
        pend_row = conn.execute(
            select(
                requests_table.c.id,
                requests_table.c.type,
                requests_table.c.status,
                requests_table.c.submitted_at,
                requests_table.c.reason_category,
                requests_table.c.reason_text,
                mgr_alias.c.full_name.label("manager_name"),
            )
            .select_from(
                requests_table.outerjoin(
                    mgr_alias,
                    requests_table.c.manager_user_id == mgr_alias.c.id,
                )
            )
            .where(
                requests_table.c.tenant_id == scope.tenant_id,
                requests_table.c.employee_id == int(emp_row.id),
                requests_table.c.target_date_start == the_date,
                requests_table.c.status.notin_(_TERMINAL_STATUSES),
            )
            .order_by(requests_table.c.id.desc())
            .limit(1)
        ).first()
        if pend_row is not None:
            _pending_request = PendingRequestSnapshot(
                request_id=int(pend_row.id),
                request_type=str(pend_row.type),
                status=str(pend_row.status),
                submitted_at=pend_row.submitted_at.isoformat(),
                reason_category=str(pend_row.reason_category),
                reason_text=str(pend_row.reason_text) if pend_row.reason_text else None,
                manager_name=str(pend_row.manager_name) if pend_row.manager_name else None,
            )

        # 3. Approved non-escalation request (exception / leave approved but
        # the absence is still on record). Escalation-confirmed days are
        # already handled by the escalation_confirmed flag above (locked=True).
        if _pending_request is None:
            mgr_users2 = users.alias("mgr_users2")
            hr_users2 = users.alias("hr_users2")
            appr_row = conn.execute(
                select(
                    requests_table.c.id,
                    requests_table.c.type,
                    requests_table.c.submitted_at,
                    requests_table.c.reason_category,
                    requests_table.c.reason_text,
                    mgr_users2.c.full_name.label("manager_name"),
                    requests_table.c.manager_decision_at,
                    requests_table.c.manager_comment,
                    hr_users2.c.full_name.label("hr_name"),
                    requests_table.c.hr_decision_at,
                    requests_table.c.hr_comment,
                )
                .select_from(
                    requests_table
                    .outerjoin(
                        mgr_users2,
                        requests_table.c.manager_user_id == mgr_users2.c.id,
                    )
                    .outerjoin(
                        hr_users2,
                        requests_table.c.hr_user_id == hr_users2.c.id,
                    )
                )
                .where(
                    requests_table.c.tenant_id == scope.tenant_id,
                    requests_table.c.employee_id == int(emp_row.id),
                    requests_table.c.target_date_start == the_date,
                    requests_table.c.type != "escalation",
                    requests_table.c.status.in_(("hr_approved", "admin_approved")),
                )
                .order_by(requests_table.c.id.desc())
                .limit(1)
            ).first()
            if appr_row is not None:
                _approved_request = ApprovedRequestSnapshot(
                    request_id=int(appr_row.id),
                    request_type=str(appr_row.type),
                    submitted_at=appr_row.submitted_at.isoformat(),
                    reason_category=str(appr_row.reason_category),
                    reason_text=str(appr_row.reason_text) if appr_row.reason_text else None,
                    manager_name=str(appr_row.manager_name) if appr_row.manager_name else None,
                    manager_decision_at=appr_row.manager_decision_at.isoformat() if appr_row.manager_decision_at else None,
                    manager_comment=str(appr_row.manager_comment) if appr_row.manager_comment else None,
                    hr_name=str(appr_row.hr_name) if appr_row.hr_name else None,
                    hr_decision_at=appr_row.hr_decision_at.isoformat() if appr_row.hr_decision_at else None,
                    hr_comment=str(appr_row.hr_comment) if appr_row.hr_comment else None,
                )

    return DayDetail(
        employee_id=int(emp_row.id),
        employee_code=str(emp_row.employee_code),
        full_name=str(emp_row.full_name),
        department_name=str(emp_row.department_name),
        date=the_date,
        status=status,
        in_time=ar.in_time.isoformat(timespec="seconds")
        if ar and ar.in_time is not None
        else None,
        out_time=ar.out_time.isoformat(timespec="seconds")
        if ar and ar.out_time is not None
        else None,
        total_minutes=int(ar.total_minutes)
        if ar and ar.total_minutes is not None
        else None,
        overtime_minutes=int(ar.overtime_minutes) if ar else 0,
        policy_id=int(ar.policy_id) if ar else None,
        policy_name=str(ar.policy_name) if ar else None,
        policy_description=policy_description,
        policy_scope=policy_scope,
        policy_type=policy_type_out,
        policy_required_hours=policy_required_hours,
        policy_grace_minutes=policy_grace_minutes,
        policy_shift_start=policy_shift_start,
        policy_shift_end=policy_shift_end,
        policy_in_window_start=policy_in_window_start,
        policy_in_window_end=policy_in_window_end,
        policy_out_window_start=policy_out_window_start,
        policy_out_window_end=policy_out_window_end,
        policy_range_start=policy_range_start,
        policy_range_end=policy_range_end,
        policy_custom_inner_type=policy_custom_inner_type,
        timeline=timeline,
        evidence=evidence,
        is_weekend=weekend,
        weekend_days=list(weekend_days),
        is_holiday=hol_name is not None,
        holiday_name=hol_name,
        leave_name=str(ar.leave_name)
        if ar and ar.leave_name is not None
        else None,
        escalation_confirmed=escalation_confirmed,
        escalation_note=escalation_note_val,
        escalation_request=esc_snapshot,
        camera_gaps=_camera_gaps,
        pending_request=_pending_request,
        approved_request=_approved_request,
    )
