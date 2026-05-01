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
)
from maugood.db import (
    approved_leaves,
    attendance_records,
    cameras,
    departments,
    detection_events,
    employees,
    holidays,
    leave_types,
    shift_policies,
)
from maugood.tenants.scope import TenantScope


# Map Python's ``date.strftime("%A")`` → name match in the
# tenant_settings.weekend_days list.
_WEEKDAY_NAMES = (
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
)


# Status enum surfaced to the frontend for cell rendering.
STATUS_PRESENT = "present"
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
            attendance_records.c.leave_type_id,
            shift_policies.c.name.label("policy_name"),
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
        # 5. attendance flags: absent, late, present
        # 6. no_record (workday with neither attendance nor leave)
        if in_future:
            status = STATUS_FUTURE
        elif hol_name is not None:
            status = STATUS_HOLIDAY
        elif weekend:
            status = STATUS_WEEKEND
        elif ar is not None and ar.leave_type_id is not None:
            status = STATUS_LEAVE
        elif leave_name is not None and ar is None:
            status = STATUS_LEAVE
        elif ar is not None and bool(ar.absent):
            status = STATUS_ABSENT
        elif ar is not None and bool(ar.late):
            status = STATUS_LATE
        elif ar is not None:
            status = STATUS_PRESENT
        else:
            status = STATUS_NO_RECORD

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
    policy_name: Optional[str]
    policy_description: Optional[str]
    policy_scope: str
    timeline: list[TimelineInterval]
    evidence: list[EvidenceCrop]
    is_weekend: bool
    is_holiday: bool
    holiday_name: Optional[str]
    leave_name: Optional[str]


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
    max_crops: int = 5,
) -> list[EvidenceCrop]:
    """Pick up to ``max_crops`` events spread across the day.

    Five buckets:

    * arrival   = ``in_time ± 30 min``
    * morning   = ``in_time + 30 min`` → ``noon``
    * midday    = 11:00 → 14:00
    * afternoon = 14:00 → ``out_time - 30 min``
    * departure = ``out_time ± 30 min``

    From each bucket we take the highest-confidence event. Empty
    buckets skip — so a day with only arrival + departure events
    yields exactly two crops, not five.

    The picker ignores events whose underlying file has been swept
    by the orphan cleanup (``has_crop=False``) — those would
    return 404 from the crop endpoint.
    """

    if not events:
        return []

    def parse_t(iso: str) -> time:
        # Accept either "HH:MM:SS" or full datetime ISO strings.
        if "T" in iso:
            return datetime.fromisoformat(iso).time()
        h, m, s = iso.split(":")
        return time(int(h), int(m), int(float(s)))

    by_bucket: dict[str, list[dict]] = {
        "arrival": [],
        "morning": [],
        "midday": [],
        "afternoon": [],
        "departure": [],
    }
    for ev in events:
        if not ev.get("has_crop"):
            continue
        t = parse_t(ev["captured_at"])
        # Arrival / departure use offsets vs. policy in/out times when
        # known. Without those we fall back to "first / last detection".
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
        # Falls outside every bucket — drop silently. Common for
        # very-early or very-late events around shift boundaries.

    out: list[EvidenceCrop] = []
    for bucket_name in ("arrival", "morning", "midday", "afternoon", "departure"):
        bucket = by_bucket[bucket_name]
        if not bucket:
            continue
        # Highest-confidence event in this bucket (None confidence
        # sorts last).
        best = max(
            bucket,
            key=lambda e: (e.get("confidence") if e.get("confidence") is not None else 0.0),
        )
        out.append(
            EvidenceCrop(
                detection_event_id=int(best["id"]),
                captured_at=str(best["captured_at"]),
                camera_code=str(best.get("camera_name") or "CAM"),
                confidence=(
                    float(best["confidence"])
                    if best.get("confidence") is not None
                    else None
                ),
                crop_url=(
                    f"/api/attendance/calendar/evidence/"
                    f"{employee_id}/{int(best['id'])}/crop"
                ),
            )
        )
        if len(out) >= max_crops:
            break
    return out


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
            shift_policies.c.id.label("policy_id"),
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
            attendance_records.c.date == the_date,
        )
    ).first()

    hol = holidays_on(conn, scope, the_date=the_date)
    hol_name = hol[0].name if hol else None
    weekend = is_weekend(the_date, weekend_days)

    today_local = datetime.now(timezone.utc).astimezone(
        local_tz_for(settings)
    ).date()
    in_future = the_date > today_local

    # Status — same priority as person_view.
    if in_future:
        status = STATUS_FUTURE
    elif hol_name is not None:
        status = STATUS_HOLIDAY
    elif weekend:
        status = STATUS_WEEKEND
    elif ar is not None and ar.leave_type_id is not None:
        status = STATUS_LEAVE
    elif ar is not None and bool(ar.absent):
        status = STATUS_ABSENT
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
    if ar is not None:
        cfg = ar.policy_config or {}
        if isinstance(cfg, dict):
            d = cfg.get("description")
            if isinstance(d, str) and d:
                policy_description = d
            scope_val = cfg.get("scope")
            if isinstance(scope_val, str) and scope_val:
                policy_scope = scope_val

    # Detection events for that local day → timeline + evidence.
    day_start = datetime.combine(
        the_date, time(0, 0), tzinfo=local_tz_for(settings)
    ).astimezone(timezone.utc)
    day_end = datetime.combine(
        the_date, time(23, 59, 59), tzinfo=local_tz_for(settings)
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

    local_zone = local_tz_for(settings)
    captured_times: list[time] = []
    event_dicts: list[dict] = []
    for r in ev_rows:
        # Convert UTC captured_at → local time for the timeline.
        local_dt = r.captured_at.astimezone(local_zone)
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
        policy_name=str(ar.policy_name) if ar else None,
        policy_description=policy_description,
        policy_scope=policy_scope,
        timeline=timeline,
        evidence=evidence,
        is_weekend=weekend,
        is_holiday=hol_name is not None,
        holiday_name=hol_name,
        leave_name=str(ar.leave_name)
        if ar and ar.leave_name is not None
        else None,
    )
