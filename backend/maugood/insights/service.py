"""Insights data assembly — a thin JSON adapter over the PDF builders.

Golden rule: **same numbers as the Template 1 PDF**. Nothing in this
module re-derives attendance. Rows come from
``reporting.pdf._query_rows`` → ``_mk_row`` (engine rows verbatim, with
``with_crops=False`` so no crop is ever decrypted), and the KPIs,
breakdown, department ranking and exception list come straight out of
``_daily_context`` (single day) / ``_range_context`` (range) /
``_employee_range_context`` (person). This module only reshapes those
dicts into the API contract and adds two chart series (per-day trend,
arrival histogram) computed from the same normalised rows.

Every query is filtered by ``scope.tenant_id`` (the PDF helpers do it,
and so does every query here); the caller runs inside the request's
tenant context. Day boundaries use the tenant timezone.
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import and_, func, select
from sqlalchemy.engine import Connection

from maugood.attendance.repository import load_tenant_settings
from maugood.db import (
    departments,
    divisions,
    employee_photos,
    employees,
    roles,
    user_departments,
    user_roles,
    users,
)
from maugood.reporting import pdf as P
from maugood.tenants.scope import TenantScope

MAX_RANGE_DAYS = 92
ARRIVAL_BUCKET_MINUTES = 30

_WAITING_LABEL = "Awaiting arrival"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _hhmm(minutes: Optional[int]) -> Optional[str]:
    if minutes is None:
        return None
    m = int(minutes) % (24 * 60)
    return f"{m // 60:02d}:{m % 60:02d}"


def _r2(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(float(v), 2)


def tenant_today(conn: Connection, scope: TenantScope) -> date:
    """Today in the tenant's timezone (never the server's)."""

    settings = load_tenant_settings(conn, scope)
    return datetime.now(timezone.utc).astimezone(P._tz(settings.timezone)).date()


def _api_status(status: str, d: date, today: date) -> str:
    """Map the PDF's internal ``pending`` to the app's words: a day
    still in progress is ``waiting``; a past day is ``no_record``."""

    if status == "pending":
        return "waiting" if d >= today else "no_record"
    return status


class _Loaded:
    """Everything the PDF's ``build_pdf`` prepares before picking a
    layout — loaded the same way, minus branding / crops."""

    def __init__(
        self,
        conn: Connection,
        scope: TenantScope,
        *,
        start: date,
        end: date,
        department_ids: Optional[list[int]],
        employee_id: Optional[int] = None,
        with_sightings: bool = False,
    ) -> None:
        self.fmt = P.load_tenant_formatter(conn, scope.tenant_id)
        tsettings = load_tenant_settings(conn, scope)
        self.tz = P._tz(tsettings.timezone)
        self.weekend_days = tuple(tsettings.weekend_days)
        self.today = datetime.now(timezone.utc).astimezone(self.tz).date()
        self.raw_rows = P._query_rows(
            conn,
            scope,
            start_date=start,
            end_date=end,
            department_ids=department_ids,
            employee_id=employee_id,
        )
        self.holiday_names = P._holidays_between(conn, scope, start, end)
        self.pcache = P._policy_cache(self.fmt)
        sight: dict[tuple[int, date], Any] = {}
        if with_sightings and self.raw_rows:
            sight = P._sightings_summary(
                conn,
                scope,
                start_date=start,
                end_date=end,
                tz=self.tz,
                employee_id=employee_id,
            )
        self.rows = [
            P._mk_row(
                r,
                fmt=self.fmt,
                pcache=self.pcache,
                holiday_names=self.holiday_names,
                weekend_days=self.weekend_days,
                sight=sight.get((int(r.employee_id), r.date)),
                with_crops=False,
            )
            for r in self.raw_rows
        ]
        self.start, self.end = start, end
        self.days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        self.working = [
            d
            for d in self.days
            if d.strftime("%A") not in self.weekend_days and d not in self.holiday_names
        ]

    def is_weekend(self, d: date) -> bool:
        return d.strftime("%A") in self.weekend_days


# ---------------------------------------------------------------------------
# Shared sections
# ---------------------------------------------------------------------------


def _period(ld: _Loaded, prev_label: Optional[str] = None) -> dict:
    return {
        "start": ld.start,
        "end": ld.end,
        "days": len(ld.days),
        "working_days": len(ld.working),
        "label": P._range_label(ld.start, ld.end),
        "is_single_day": ld.start == ld.end,
        "prev_label": prev_label,
    }


def _company_context(
    conn: Connection,
    scope: TenantScope,
    ld: _Loaded,
    *,
    department_ids: Optional[list[int]],
    department_label: Optional[str],
) -> tuple[dict, dict]:
    """Return ``(pdf_ctx, kpis)`` for the company layouts.

    Single day → ``_daily_context`` (the daily PDF), range →
    ``_range_context`` (the range PDF). The KPI dict is the PDF's
    ``k`` re-keyed onto the contract.
    """

    if ld.start == ld.end:
        ctx = P._daily_context(
            conn,
            scope,
            ld.rows,
            the_date=ld.start,
            department_ids=department_ids,
            department_label=department_label,
            fmt=ld.fmt,
            tz=ld.tz,
            holiday_names=ld.holiday_names,
            weekend_days=ld.weekend_days,
            pcache=ld.pcache,
            report_id="",
            generated_at_label="",
            generated_by_email="",
        )
        k = ctx["k"]
        kpis = {
            "total": k["total"],
            "present": k["present"],
            "present_pct": k["present_pct"],
            "late": k["late"],
            "early": k["early"],
            "absent": k["absent"],
            "absent_pct": k["absent_pct"],
            "leave": k["leave"],
            "ot_hours": k["ot_hours"],
            "ot_employees": k["ot_employees"],
            "avg_hours": _r2(k["avg_hours"]),
            "avg_late_minutes": k["avg_late_minutes"],
        }
        return ctx, kpis

    ctx = P._range_context(
        ld.rows,
        start=ld.start,
        end=ld.end,
        department_label=department_label,
        fmt=ld.fmt,
        tz=ld.tz,
        holiday_names=ld.holiday_names,
        weekend_days=ld.weekend_days,
        report_id="",
        generated_at_label="",
        generated_by_email="",
        with_crops=False,
    )
    k = ctx["k"]
    kpis = {
        "total": k["total"],
        "present": k["present_days"],
        "present_pct": k["present_pct"],
        "late": k["late"],
        "early": k["early"],
        "absent": k["absent"],
        "absent_pct": P._pct(k["absent"], k["slots"]),
        "leave": k["leave"],
        "ot_hours": k["ot_hours"],
        "ot_employees": k["ot_employees"],
        "avg_hours": _r2(k["avg_hours"]),
        "avg_late_minutes": k["avg_late_minutes"],
    }
    # The range PDF has no breakdown panel; build it from the same rows
    # (person-days) with the PDF's own helper.
    ctx["breakdown"] = P._breakdown(ld.rows, None, None)
    return ctx, kpis


def _breakdown_out(bd: dict, ld: _Loaded) -> list[dict]:
    out = []
    for b in bd["rows"]:
        key, label = b["key"], b["label"]
        if key == "pending":
            key = "waiting" if ld.end >= ld.today else "no_record"
            if key == "waiting":
                label = _WAITING_LABEL
        out.append(
            {
                "key": key,
                "label": label,
                "count": b["count"],
                "share": round(b["share"], 2),
                "delta": b["delta"],
                "delta_good": bool(b["delta_good"]),
                "delta_bad": bool(b["delta_bad"]),
            }
        )
    return out


def _trend(ld: _Loaded) -> list[dict]:
    """Per-day series — same denominator as the PDF presence chart
    (employees with any row in the period)."""

    total = len({r["employee_id"] for r in ld.rows})
    by_day: dict[date, list[dict]] = {}
    for r in ld.rows:
        by_day.setdefault(r["date"], []).append(r)
    out = []
    for d in ld.days:
        rs = by_day.get(d, [])
        c = Counter(r["status"] for r in rs)
        present = sum(1 for r in rs if r["in_min"] is not None)
        out.append(
            {
                "date": d,
                "weekday": d.strftime("%a"),
                "is_weekend": ld.is_weekend(d),
                "is_holiday": d in ld.holiday_names,
                "holiday_name": ld.holiday_names.get(d),
                "present": present,
                "late": c.get("late", 0),
                "absent": c.get("absent", 0),
                "leave": c.get("leave", 0),
                "headcount": total,
                "present_pct": P._pct(present, total),
            }
        )
    return out


def _arrivals(ld: _Loaded) -> list[dict]:
    """First-in histogram over present person-days, contiguous 30-min
    buckets between the earliest and latest arrival."""

    counts = Counter(
        (r["in_min"] // ARRIVAL_BUCKET_MINUTES) * ARRIVAL_BUCKET_MINUTES
        for r in ld.rows
        if r["in_min"] is not None
    )
    if not counts:
        return []
    lo, hi = min(counts), max(counts)
    return [
        {"bucket": _hhmm(m), "count": counts.get(m, 0)}
        for m in range(lo, hi + 1, ARRIVAL_BUCKET_MINUTES)
    ]


def _departments_out(ctx: dict) -> list[dict]:
    return [
        {
            "department_id": d.get("department_id"),
            "name": d["name"],
            "headcount": d["headcount"],
            "present": d["present"],
            "late": d["late"],
            "absent": d["absent"],
            "leave": d["leave"],
            "avg_hours": _r2(d["avg_hours"]),
            "ot_hours": d["ot_hours"],
            "pct": d["pct"],
        }
        for d in ctx["departments"]
    ]


def _exceptions_out(ctx: dict) -> list[dict]:
    out = []
    for r in ctx["exceptions"]:
        labels = [label for _cls, label in r["flags"]]
        out.append(
            {
                "employee_id": r["employee_id"],
                "employee_code": r["employee_code"],
                "full_name": r["full_name"],
                "department": r["department_name"],
                "date": r["date"],
                "status": r["exception_status"],
                "in_time": _hhmm(r["in_min"]),
                "out_time": _hhmm(r["out_min"]),
                "hours": r["hours"],
                "detail": " · ".join(labels) if labels else r["flags_empty"],
            }
        )
    return out


TOP_PEOPLE = 6


def _top_people(ld: _Loaded, status: str) -> list[dict]:
    """Most late / most absent people over the **whole** period.

    Ranked from every row, not from the exception list (which caps at
    300), so a long range still names the right people. One day → the
    latest arrivals first; a range → most days first.
    """

    by_emp: dict[int, dict] = {}
    for r in ld.rows:
        if r.get("exception_status") != status:
            continue
        cur = by_emp.get(r["employee_id"])
        if cur is None:
            by_emp[r["employee_id"]] = cur = {
                "employee_id": r["employee_id"],
                "employee_code": r["employee_code"],
                "full_name": r["full_name"],
                "department": r["department_name"],
                "count": 0,
                "in_time": _hhmm(r["in_min"]),
            }
        cur["count"] += 1
    people = list(by_emp.values())
    if ld.start == ld.end and status == "late":
        people.sort(key=lambda p: p["in_time"] or "", reverse=True)
    else:
        people.sort(key=lambda p: (-p["count"], p["full_name"].lower()))
    return people[:TOP_PEOPLE]


# ---------------------------------------------------------------------------
# Lookups (tenant-filtered)
# ---------------------------------------------------------------------------


def get_department(conn: Connection, scope: TenantScope, department_id: int) -> Optional[Any]:
    return conn.execute(
        select(
            departments.c.id,
            departments.c.code,
            departments.c.name,
            divisions.c.name.label("division_name"),
        )
        .select_from(
            departments.outerjoin(
                divisions,
                and_(
                    divisions.c.id == departments.c.division_id,
                    divisions.c.tenant_id == departments.c.tenant_id,
                ),
            )
        )
        .where(departments.c.tenant_id == scope.tenant_id, departments.c.id == department_id)
    ).first()


def employee_department(
    conn: Connection, scope: TenantScope, employee_id: int
) -> tuple[bool, Optional[int]]:
    """``(exists_in_tenant, department_id)``."""

    row = conn.execute(
        select(employees.c.department_id).where(
            employees.c.tenant_id == scope.tenant_id, employees.c.id == employee_id
        )
    ).first()
    if row is None:
        return False, None
    return True, row.department_id


def _primary_photo_ids(
    conn: Connection, scope: TenantScope, employee_ids: list[int]
) -> dict[int, int]:
    if not employee_ids:
        return {}
    rows = conn.execute(
        select(employee_photos.c.employee_id, employee_photos.c.id)
        .where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.employee_id.in_(employee_ids),
        )
        .order_by(
            employee_photos.c.employee_id,
            (employee_photos.c.angle == "front").desc(),
            employee_photos.c.created_at.asc(),
        )
        .distinct(employee_photos.c.employee_id)
    ).all()
    return {int(r.employee_id): int(r.id) for r in rows}


# ---------------------------------------------------------------------------
# Endpoint bodies
# ---------------------------------------------------------------------------


def build_overview(
    conn: Connection,
    scope: TenantScope,
    *,
    start: date,
    end: date,
    department_ids: Optional[list[int]],
    department_label: Optional[str],
) -> dict:
    ld = _Loaded(conn, scope, start=start, end=end, department_ids=department_ids)
    ctx, kpis = _company_context(
        conn, scope, ld, department_ids=department_ids, department_label=department_label
    )
    pld = _prev_loaded(conn, scope, start=start, end=end, department_ids=department_ids)
    return {
        "period": _period(ld, ctx["breakdown"].get("prev_label")),
        "scope": {
            "employees": kpis["total"],
            "departments": len({r["department_name"] for r in ld.rows}),
            "department_label": department_label,
        },
        "kpis": _v2_kpis(kpis, ld),
        "breakdown": _breakdown_out(ctx["breakdown"], ld),
        "trend": _trend(ld),
        "arrivals": _arrivals(ld),
        "departments": _departments_v2(_departments_out(ctx), ld, pld),
        "exceptions": _exceptions_out(ctx),
        "exceptions_total": ctx["exceptions_total"],
        "top_late": _top_people(ld, "late"),
        "top_absent": _top_people(ld, "absent"),
        # v2
        "compare": _compare_from(pld),
        "weekday": _weekday(ld),
        "shift": _shift(ld),
        "watchlist": _watchlist(conn, scope, ld, _people(ld)),
        "heatmap": _heatmap(ld, ctx),
    }


def build_department(
    conn: Connection,
    scope: TenantScope,
    dept: Any,
    *,
    start: date,
    end: date,
    company_department_ids: Optional[list[int]] = None,
) -> dict:
    """``company_department_ids`` = the caller's scope for the
    ``company`` comparison (None = whole tenant, Manager = own depts)."""

    dept_id = int(dept.id)
    department_label = f"{dept.code} · {dept.name}"
    ld = _Loaded(conn, scope, start=start, end=end, department_ids=[dept_id])
    ctx, kpis = _company_context(
        conn, scope, ld, department_ids=[dept_id], department_label=department_label
    )

    # Per-employee aggregates: the range PDF's employee rollup (pure;
    # works for a single day too).
    rctx = (
        ctx
        if start != end
        else P._range_context(
            ld.rows,
            start=start,
            end=end,
            department_label=department_label,
            fmt=ld.fmt,
            tz=ld.tz,
            holiday_names=ld.holiday_names,
            weekend_days=ld.weekend_days,
            report_id="",
            generated_at_label="",
            generated_by_email="",
            with_crops=False,
        )
    )
    W = len(ld.working)
    people = _people(ld)
    emps = [e for g in rctx["groups"] for e in g["rows"]]
    photos = _primary_photo_ids(conn, scope, [e["employee_id"] for e in emps])
    last_dates: dict[int, date] = {}
    for r in ld.rows:
        last_dates[r["employee_id"]] = max(r["date"], last_dates.get(r["employee_id"], r["date"]))
    employees_out = [
        {
            "employee_id": e["employee_id"],
            "employee_code": e["employee_code"],
            "full_name": e["full_name"],
            "designation": e["designation"],
            "present_days": e["present"],
            "late_days": e["late"],
            "absent_days": e["absent"],
            "leave_days": e["leave"],
            "avg_in": _hhmm(e["avg_in_min"]),
            "avg_out": _hhmm(e["avg_out_min"]),
            "avg_hours": _r2(e["hours"] / e["present"]) if e["present"] else None,
            "ot_hours": round(e["ot_minutes"] / 60.0, 2),
            "pct": P._pct(e["present"], W),
            "last_status": _api_status(e["last_status"], last_dates[e["employee_id"]], ld.today),
            "primary_photo_id": photos.get(e["employee_id"]),
            # v2
            "punctuality_pct": _punct(e["present"], e["late"]),
            "strip": _strip(ld, people[e["employee_id"]]["by_date"]),
        }
        for e in emps
    ]

    headcount = int(
        conn.execute(
            select(func.count())
            .select_from(employees)
            .where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.department_id == dept_id,
                employees.c.status == "active",
            )
        ).scalar_one()
    )
    managers = [
        str(n)
        for n in conn.execute(
            select(users.c.full_name)
            .select_from(
                user_departments.join(
                    users,
                    and_(
                        users.c.id == user_departments.c.user_id,
                        users.c.tenant_id == user_departments.c.tenant_id,
                    ),
                )
                .join(
                    user_roles,
                    and_(
                        user_roles.c.user_id == users.c.id,
                        user_roles.c.tenant_id == users.c.tenant_id,
                    ),
                )
                .join(
                    roles,
                    and_(
                        roles.c.id == user_roles.c.role_id,
                        roles.c.tenant_id == user_roles.c.tenant_id,
                    ),
                )
            )
            .where(
                user_departments.c.tenant_id == scope.tenant_id,
                user_departments.c.department_id == dept_id,
                roles.c.code == "Manager",
                users.c.is_active.is_(True),
            )
            .distinct()
            .order_by(users.c.full_name)
        ).scalars()
    ]

    cld = _Loaded(conn, scope, start=start, end=end, department_ids=company_department_ids)
    return {
        "department": {
            "id": dept_id,
            "name": str(dept.name),
            "code": str(dept.code),
            "division": str(dept.division_name) if dept.division_name else None,
            "headcount": headcount,
            "managers": managers,
        },
        "period": _period(ld, ctx["breakdown"].get("prev_label")),
        "kpis": _v2_kpis(kpis, ld),
        "breakdown": _breakdown_out(ctx["breakdown"], ld),
        "trend": _trend(ld),
        "arrivals": _arrivals(ld),
        "employees": employees_out,
        "exceptions": _exceptions_out(ctx),
        "exceptions_total": ctx["exceptions_total"],
        # v2
        "compare": _compare_block(conn, scope, start=start, end=end, department_ids=[dept_id]),
        "weekday": _weekday(ld),
        "shift": _shift(ld),
        "watchlist": _watchlist(conn, scope, ld, people),
        "company": _brief(_summary(cld.rows, len(cld.working), single=start == end)),
    }


def build_employee(
    conn: Connection,
    scope: TenantScope,
    employee_id: int,
    *,
    start: date,
    end: date,
    company_department_ids: Optional[list[int]] = None,
) -> Optional[dict]:
    emp = P._employee_profile(conn, scope, employee_id, with_photo=False)
    if emp is None:
        return None
    _exists, emp_dept_id = employee_department(conn, scope, employee_id)
    ld = _Loaded(
        conn,
        scope,
        start=start,
        end=end,
        department_ids=None,
        employee_id=employee_id,
        with_sightings=True,
    )
    facts = P._employee_policy_facts(conn, scope, ld.raw_rows, ld.pcache, ld.fmt)
    ectx = P._employee_range_context(
        conn,
        scope,
        ld.rows,
        emp,
        start=start,
        end=end,
        fmt=ld.fmt,
        tz=ld.tz,
        holiday_names=ld.holiday_names,
        weekend_days=ld.weekend_days,
        facts=facts,
        report_id="",
        generated_at_label="",
        generated_by_email="",
    )
    k = ectx["k"]
    # Averages (in / out / short days) come from the range rollup of
    # the same rows.
    stats: dict = {}
    if ld.rows:
        rctx = P._range_context(
            ld.rows,
            start=start,
            end=end,
            department_label=None,
            fmt=ld.fmt,
            tz=ld.tz,
            holiday_names=ld.holiday_names,
            weekend_days=ld.weekend_days,
            report_id="",
            generated_at_label="",
            generated_by_email="",
            with_crops=False,
        )
        stats = rctx["groups"][0]["rows"][0]

    dp = k["present"]
    kpis = {
        "working_days": k["working_days"],
        "present_days": dp,
        "late_days": k["late"],
        "absent_days": k["absent"],
        "leave_days": k["leave"],
        "early_days": k["early"],
        "short_days": int(stats.get("short", 0)),
        "punctuality_pct": P._pct(dp - k["late"], dp),
        "attendance_pct": k["present_pct"],
        "avg_in": _hhmm(stats.get("avg_in_min")),
        "avg_out": _hhmm(stats.get("avg_out_min")),
        "avg_hours": _r2(k["hours"] / dp) if dp else None,
        "total_hours": k["hours"],
        "ot_hours": k["ot_hours"],
    }

    by_date = {r["date"]: r for r in ld.rows}
    joining = emp.get("joining_date")
    days = []
    for d in ld.days:
        r = by_date.get(d)
        base = {
            "date": d,
            "weekday": d.strftime("%a"),
            "is_weekend": ld.is_weekend(d),
            "is_holiday": d in ld.holiday_names,
            "before_joining": bool(joining is not None and d < joining),
        }
        if r is None:
            days.append(
                {
                    **base,
                    "status": _api_status(
                        P._no_row_status(
                            d, weekend_days=ld.weekend_days, holiday_names=ld.holiday_names
                        ),
                        d,
                        ld.today,
                    ),
                    "in_time": None,
                    "out_time": None,
                    "hours": None,
                    "ot_minutes": 0,
                    "late_minutes": None,
                    "flags": [],
                    "first_event_id": None,
                    "last_event_id": None,
                    "camera": None,
                    "leave_name": None,
                }
            )
            continue
        days.append(
            {
                **base,
                "status": _api_status(r["status"], d, ld.today),
                "in_time": _hhmm(r["in_min"]),
                "out_time": _hhmm(r["out_min"]),
                "hours": r["hours"],
                "ot_minutes": r["ot_minutes"],
                "late_minutes": r["late_minutes"],
                "flags": [cls for cls, _label in r["flags"]],
                "first_event_id": r["first_event_id"],
                "last_event_id": r["last_event_id"],
                "camera": r["source"],
                "leave_name": r["leave_name"],
            }
        )

    if facts.get("start") is not None and facts.get("end") is not None:
        window: Optional[str] = f"{facts['start']:%H:%M}–{facts['end']:%H:%M}"
    else:
        window = facts.get("window_label")

    return {
        "profile": {
            "id": emp["employee_id"],
            "department_id": emp_dept_id,
            "employee_code": emp["employee_code"],
            "full_name": emp["full_name"],
            "designation": emp["designation"],
            "department": emp["department_name"],
            "email": emp["email"],
            "reports_to": emp["manager_name"],
            "joining_date": emp["joining_date"],
            "primary_photo_id": emp["primary_photo_id"],
        },
        "policy": {
            "name": facts["name"],
            "type": facts["type"],
            "window": window,
            "required_hours": facts["required_hours"],
            "grace_minutes": facts["grace_minutes"],
        },
        "period": _period(ld),
        "kpis": kpis,
        "days": days,
        # v2
        "compare": _employee_compare(
            conn,
            scope,
            employee_id,
            emp_dept_id,
            start=start,
            end=end,
            company_department_ids=company_department_ids,
        ),
        "highlights": _employee_highlights(ld),
        "requests": [
            {
                "id": q["id"],
                "type": q["type"],
                "status": q["status_raw"],
                "start": q["date"],
                "end": q["end"],
                "reason": q["reason"],
            }
            for q in ectx["requests"]
        ],
    }


# ---------------------------------------------------------------------------
# v2 — comparisons, weekday profile, watchlists, heatmap, people picker
#
# Everything below is a pure fold over ``ld.rows`` (the PDF's normalised
# rows). Counting rules are the PDF's: present = a first-in exists,
# late / early / absent / leave = the row status.
# ---------------------------------------------------------------------------

WATCH_TOP = 10
NEVER_SEEN_TOP = 20
_PRESENTISH = ("present", "late", "early")


def _is_working(ld: _Loaded, d: date) -> bool:
    return not ld.is_weekend(d) and d not in ld.holiday_names


def _mean_hhmm(values: list[int]) -> Optional[str]:
    return _hhmm(int(round(sum(values) / len(values)))) if values else None


def _punct(present: int, late: int) -> Optional[int]:
    return P._pct(present - late, present) if present else None


def _summary(rows: list[dict], working_days: int, *, single: bool) -> dict:
    """Headline figures for a set of rows, with the PDF's definitions.

    Single day = the daily PDF (one slot per employee row, avg hours =
    mean over present rows); range = the range PDF (slots = employees ×
    working days, avg hours = per-employee rounded hours ÷ present days).
    """

    present = [r for r in rows if r["in_min"] is not None]
    n_p = len(present)
    total = len({r["employee_id"] for r in rows})
    late = sum(1 for r in rows if r["status"] == "late")
    if single:
        expected = len(rows)
        avg_hours = P._mean([r["hours"] for r in present if r["hours"] is not None])
    else:
        expected = total * working_days
        per_emp: dict[int, int] = {}
        for r in rows:
            per_emp[r["employee_id"]] = per_emp.get(r["employee_id"], 0) + (r["total_minutes"] or 0)
        hrs = sum(round(m / 60.0, 2) for m in per_emp.values())
        avg_hours = (hrs / n_p) if n_p else None
    return {
        "total": total,
        "present_days": n_p,
        "expected_days": expected,
        "attendance_pct": P._pct(n_p, expected),
        "punctuality_pct": _punct(n_p, late),
        "avg_in": _mean_hhmm([r["in_min"] for r in present]),
        "avg_out": _mean_hhmm([r["out_min"] for r in present if r["out_min"] is not None]),
        "avg_hours": _r2(avg_hours),
        "late": late,
        "early": sum(1 for r in rows if r["status"] == "early"),
        "absent": sum(1 for r in rows if r["status"] == "absent"),
        "leave": sum(1 for r in rows if r["status"] == "leave"),
        "ot_hours": round(sum(r["ot_minutes"] for r in rows) / 60.0, 2),
    }


def _prev_range(start: date, end: date) -> tuple[date, date]:
    n = (end - start).days + 1
    return start - timedelta(days=n), start - timedelta(days=1)


def _prev_loaded(
    conn: Connection,
    scope: TenantScope,
    *,
    start: date,
    end: date,
    department_ids: Optional[list[int]],
) -> _Loaded:
    ps, pe = _prev_range(start, end)
    return _Loaded(conn, scope, start=ps, end=pe, department_ids=department_ids)


def _compare_block(
    conn: Connection,
    scope: TenantScope,
    *,
    start: date,
    end: date,
    department_ids: Optional[list[int]],
) -> Optional[dict]:
    return _compare_from(
        _prev_loaded(conn, scope, start=start, end=end, department_ids=department_ids)
    )


def _departments_v2(rows_out: list[dict], ld: _Loaded, pld: _Loaded) -> list[dict]:
    """Per-department headline fields (overview ``departments[]``),
    with the overview's KPI definitions on the department's rows."""

    def by_dept(x: _Loaded) -> dict[Optional[int], list[dict]]:
        g: dict[Optional[int], list[dict]] = {}
        for r in x.rows:
            g.setdefault(r["department_id"], []).append(r)
        return g

    cur, prev = by_dept(ld), by_dept(pld)
    single, psingle = ld.start == ld.end, pld.start == pld.end
    for d in rows_out:
        did = d["department_id"]
        s = _summary(cur.get(did, []), len(ld.working), single=single)
        prs = prev.get(did)
        d["attendance_pct"] = s["attendance_pct"]
        d["punctuality_pct"] = s["punctuality_pct"]
        d["avg_in"] = s["avg_in"]
        d["prev_attendance_pct"] = (
            _summary(prs, len(pld.working), single=psingle)["attendance_pct"] if prs else None
        )
    return rows_out


def _compare_from(pld: _Loaded) -> Optional[dict]:
    ps, pe = pld.start, pld.end
    if not pld.rows:
        return None
    s = _summary(pld.rows, len(pld.working), single=ps == pe)
    return {
        "label": P._range_label(ps, pe),
        "start": ps,
        "end": pe,
        "kpis": {
            k: s[k]
            for k in (
                "attendance_pct",
                "punctuality_pct",
                "avg_in",
                "avg_hours",
                "late",
                "absent",
                "leave",
                "ot_hours",
                "present_days",
                "expected_days",
            )
        },
    }


def _weekday(ld: _Loaded) -> list[dict]:
    """Per weekday (Mon=0) over the working days in range. Denominator:
    employees with any row in the period × that weekday's working days
    (the range PDF's slot definition, sliced by weekday)."""

    total = len({r["employee_id"] for r in ld.rows})
    wdays: dict[int, int] = {}
    for d in ld.working:
        wdays[d.weekday()] = wdays.get(d.weekday(), 0) + 1
    working = set(ld.working)
    acc: dict[int, dict] = {w: {"rows": 0, "present": 0, "late": 0, "absent": 0} for w in wdays}
    for r in ld.rows:
        if r["date"] not in working:
            continue
        a = acc[r["date"].weekday()]
        a["rows"] += 1
        if r["in_min"] is not None:
            a["present"] += 1
        if r["status"] == "late":
            a["late"] += 1
        elif r["status"] == "absent":
            a["absent"] += 1
    out = []
    for w in sorted(wdays):
        a, slots = acc[w], total * wdays[w]
        out.append(
            {
                "weekday": w,
                "name": ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[w],
                "working_days": wdays[w],
                # null when no row exists on any of those dates (no data yet).
                "attendance_pct": P._pct(a["present"], slots) if (slots and a["rows"]) else None,
                "punctuality_pct": _punct(a["present"], a["late"]),
                "late": a["late"],
                "absent": a["absent"],
            }
        )
    return out


def _shift(ld: _Loaded) -> Optional[dict]:
    """The most common policy across the rows (for chart markers)."""

    counts: Counter = Counter()
    sample: dict[str, dict] = {}
    for r in ld.rows:
        key = r["policy_name"]
        counts[key] += 1
        sample.setdefault(key, r["policy"])
    if not counts:
        return None
    name, _n = counts.most_common(1)[0]
    f = sample[name]
    if f.get("start") is None or f.get("end") is None:
        return None
    return {
        "name": name,
        "start": f"{f['start']:%H:%M}",
        "end": f"{f['end']:%H:%M}",
        "grace_minutes": f.get("grace_minutes") or 0,
    }


def _people(ld: _Loaded) -> "dict[int, dict]":
    """Per-employee fold over ``ld.rows`` (rows are code/date ordered)."""

    working = set(ld.working)
    out: dict[int, dict] = {}
    for r in sorted(ld.rows, key=lambda x: (x["employee_id"], x["date"])):
        p = out.get(r["employee_id"])
        if p is None:
            out[r["employee_id"]] = p = {
                "employee_id": r["employee_id"],
                "employee_code": r["employee_code"],
                "full_name": r["full_name"],
                "designation": r["designation"],
                "department": r["department_name"],
                "department_id": r["department_id"],
                "present": 0,
                "late": 0,
                "early": 0,
                "absent": 0,
                "leave": 0,
                "ot_minutes": 0,
                "ins": [],
                "late_mins": [],
                "streak": 0,
                "longest_absent": 0,
                "by_date": {},
            }
        p["by_date"][r["date"]] = r
        st = r["status"]
        if r["in_min"] is not None:
            p["present"] += 1
            p["ins"].append(r["in_min"])
        if st == "late":
            p["late"] += 1
            if r["late_minutes"]:
                p["late_mins"].append(r["late_minutes"])
        elif st == "early":
            p["early"] += 1
        elif st == "absent":
            p["absent"] += 1
        elif st == "leave":
            p["leave"] += 1
        p["ot_minutes"] += r["ot_minutes"]
        # Absence streak over working days (non-working days don't break it).
        if r["date"] in working:
            if st == "absent":
                p["streak"] += 1
                p["longest_absent"] = max(p["longest_absent"], p["streak"])
            else:
                p["streak"] = 0
    return out


def _person_ref(p: dict, photos: dict[int, int]) -> dict:
    return {
        "employee_id": p["employee_id"],
        "employee_code": p["employee_code"],
        "full_name": p["full_name"],
        "department": p["department"],
        "department_id": p["department_id"],
        "primary_photo_id": photos.get(p["employee_id"]),
    }


def _watchlist(conn: Connection, scope: TenantScope, ld: _Loaded, people: dict[int, dict]) -> dict:
    single = ld.start == ld.end
    min_count = 1 if single else 2
    ps = list(people.values())

    def by_name(p: dict) -> str:
        return p["full_name"].lower()

    late = sorted((p for p in ps if p["late"] >= min_count), key=lambda p: (-p["late"], by_name(p)))
    absent = sorted(
        (p for p in ps if p["absent"] >= min_count),
        key=lambda p: (-p["absent"], -p["longest_absent"], by_name(p)),
    )
    early = sorted((p for p in ps if p["early"] >= 1), key=lambda p: (-p["early"], by_name(p)))
    ot = sorted(
        (p for p in ps if p["ot_minutes"] > 0), key=lambda p: (-p["ot_minutes"], by_name(p))
    )
    never = sorted(
        (p for p in ps if p["present"] == 0 and p["absent"] >= 1),
        key=lambda p: (-p["absent"], by_name(p)),
    )
    shown = (
        late[:WATCH_TOP]
        + absent[:WATCH_TOP]
        + early[:WATCH_TOP]
        + ot[:WATCH_TOP]
        + never[:NEVER_SEEN_TOP]
    )
    photos = _primary_photo_ids(conn, scope, sorted({p["employee_id"] for p in shown}))
    return {
        "frequent_late": [
            {
                **_person_ref(p, photos),
                "count": p["late"],
                "avg_late_minutes": (
                    int(round(sum(p["late_mins"]) / len(p["late_mins"])))
                    if p["late_mins"]
                    else None
                ),
            }
            for p in late[:WATCH_TOP]
        ],
        "repeated_absent": [
            {**_person_ref(p, photos), "count": p["absent"], "longest_streak": p["longest_absent"]}
            for p in absent[:WATCH_TOP]
        ],
        "early_leavers": [
            {**_person_ref(p, photos), "count": p["early"]} for p in early[:WATCH_TOP]
        ],
        "overtime": [
            {**_person_ref(p, photos), "ot_minutes": p["ot_minutes"]} for p in ot[:WATCH_TOP]
        ],
        "never_seen": [
            {**_person_ref(p, photos), "count": p["absent"]} for p in never[:NEVER_SEEN_TOP]
        ],
        "totals": {
            "frequent_late": len(late),
            "repeated_absent": len(absent),
            "early_leavers": len(early),
            "overtime": len(ot),
            "never_seen": len(never),
        },
    }


def _heatmap(ld: _Loaded, ctx: dict) -> dict:
    """Department × working-day attendance %. Ranges only."""

    if ld.start == ld.end:
        return {"dates": [], "rows": []}
    heads: dict[Optional[int], set] = {}
    cells: dict[tuple[Optional[int], date], list[int]] = {}
    for r in ld.rows:
        heads.setdefault(r["department_id"], set()).add(r["employee_id"])
        c = cells.setdefault((r["department_id"], r["date"]), [0, 0])
        c[0] += 1
        if r["in_min"] is not None:
            c[1] += 1
    rows = []
    for d in ctx["departments"]:
        did = d.get("department_id")
        hc = len(heads.get(did, ()))
        rows.append(
            {
                "department_id": did,
                "name": d["name"],
                "headcount": hc,
                "cells": [
                    (P._pct(cells[(did, day)][1], hc) if (did, day) in cells and hc else None)
                    for day in ld.working
                ],
            }
        )
    return {"dates": list(ld.working), "rows": rows}


def _v2_kpis(kpis: dict, ld: _Loaded) -> dict:
    """Additive KPI fields on top of the PDF-derived v1 KPIs."""

    s = _summary(ld.rows, len(ld.working), single=ld.start == ld.end)
    present = kpis["present"]
    return {
        **kpis,
        "attendance_pct": kpis["present_pct"],
        "punctuality_pct": _punct(present, kpis["late"]),
        "avg_in": s["avg_in"],
        "avg_out": s["avg_out"],
        "expected_days": s["expected_days"],
        "present_days": present,
    }


def _strip(ld: _Loaded, by_date: dict[date, dict]) -> list[str]:
    out = []
    for d in ld.days:
        r = by_date.get(d)
        st = (
            r["status"]
            if r is not None
            else P._no_row_status(d, weekend_days=ld.weekend_days, holiday_names=ld.holiday_names)
        )
        out.append(_api_status(st, d, ld.today))
    return out


def _brief(s: dict) -> dict:
    return {k: s[k] for k in ("attendance_pct", "punctuality_pct", "avg_in", "avg_hours")}


# --- /people ---------------------------------------------------------------

PEOPLE_SORTS = ("attention", "name", "attendance", "punctuality", "late", "absent")


def _attention_threshold(n_days: int) -> int:
    if n_days >= 7:
        return 3
    return 1 if n_days <= 2 else 2


def build_people(
    conn: Connection,
    scope: TenantScope,
    *,
    start: date,
    end: date,
    department_ids: Optional[list[int]],
    q: Optional[str],
    sort: str,
    page: int,
    page_size: int,
) -> dict:
    ld = _Loaded(conn, scope, start=start, end=end, department_ids=department_ids)
    people = _people(ld)
    W = len(ld.working)
    thr = _attention_threshold(len(ld.days))

    # Everyone active in scope appears even without a row (new joiner,
    # scheduler not run yet); rows add anyone inactive who has data.
    stmt = (
        select(
            employees.c.id,
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.designation,
            employees.c.department_id,
            departments.c.name.label("department_name"),
        )
        .select_from(
            employees.outerjoin(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
            )
        )
        .where(employees.c.tenant_id == scope.tenant_id, employees.c.status == "active")
    )
    if department_ids is not None:
        stmt = stmt.where(employees.c.department_id.in_(department_ids or [-1]))
    base: dict[int, dict] = {}
    for e in conn.execute(stmt):
        base[int(e.id)] = {
            "employee_id": int(e.id),
            "employee_code": str(e.employee_code),
            "full_name": str(e.full_name),
            "designation": str(e.designation) if e.designation else None,
            "department": str(e.department_name) if e.department_name else "—",
            "department_id": int(e.department_id) if e.department_id is not None else None,
        }
    for p in people.values():
        base.setdefault(
            p["employee_id"],
            {
                k: p[k]
                for k in (
                    "employee_id",
                    "employee_code",
                    "full_name",
                    "designation",
                    "department",
                    "department_id",
                )
            },
        )

    items = []
    for eid, b in base.items():
        p = people.get(eid)
        present = p["present"] if p else 0
        late = p["late"] if p else 0
        absent = p["absent"] if p else 0
        early = p["early"] if p else 0
        reasons = []
        if late >= thr:
            reasons.append("late")
        if absent >= thr:
            reasons.append("absent")
        if p is not None and present == 0 and absent >= 1:
            reasons.append("never_seen")
        if early >= thr:
            reasons.append("early")
        items.append(
            {
                **b,
                "primary_photo_id": None,
                "attendance_pct": P._pct(present, W) if (p is not None and W) else None,
                "punctuality_pct": _punct(present, late),
                "present_days": present,
                "late_days": late,
                "absent_days": absent,
                "leave_days": p["leave"] if p else 0,
                "early_days": early,
                "avg_in": _mean_hhmm(p["ins"]) if p else None,
                "ot_minutes": p["ot_minutes"] if p else 0,
                "needs_attention": bool(reasons),
                "attention_reasons": reasons,
            }
        )

    if q:
        needle = q.strip().lower()
        items = [
            i
            for i in items
            if needle in i["full_name"].lower()
            or needle in i["employee_code"].lower()
            or needle in i["department"].lower()
        ]

    def name_key(i: dict) -> str:
        return i["full_name"].lower()

    def nulls_last(v: Optional[int]) -> tuple[int, int]:
        return (1, 0) if v is None else (0, v)

    if sort == "name":
        items.sort(key=name_key)
    elif sort == "attendance":
        items.sort(key=lambda i: (nulls_last(i["attendance_pct"]), name_key(i)))
    elif sort == "punctuality":
        items.sort(key=lambda i: (nulls_last(i["punctuality_pct"]), name_key(i)))
    elif sort == "late":
        items.sort(key=lambda i: (-i["late_days"], name_key(i)))
    elif sort == "absent":
        items.sort(key=lambda i: (-i["absent_days"], name_key(i)))
    else:  # attention
        items.sort(
            key=lambda i: (
                not i["needs_attention"],
                -len(i["attention_reasons"]),
                -(i["late_days"] + i["absent_days"] + i["early_days"]),
                name_key(i),
            )
        )

    total = len(items)
    page_items = items[(page - 1) * page_size : page * page_size]
    photos = _primary_photo_ids(conn, scope, [i["employee_id"] for i in page_items])
    for i in page_items:
        i["primary_photo_id"] = photos.get(i["employee_id"])
    return {
        "period": _period(ld),
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": page_items,
    }


def month_to_date(conn: Connection, scope: TenantScope) -> tuple[date, date]:
    today = tenant_today(conn, scope)
    return today.replace(day=1), today


# --- employee v2 -----------------------------------------------------------


def _employee_compare(
    conn: Connection,
    scope: TenantScope,
    employee_id: int,
    department_id: Optional[int],
    *,
    start: date,
    end: date,
    company_department_ids: Optional[list[int]],
) -> dict:
    ps, pe = _prev_range(start, end)
    pld = _Loaded(conn, scope, start=ps, end=pe, department_ids=None, employee_id=employee_id)
    previous: Optional[dict] = None
    if pld.rows:
        present = [r for r in pld.rows if r["in_min"] is not None]
        dp = len(present)
        late = sum(1 for r in pld.rows if r["status"] == "late")
        hrs = sum(r["total_minutes"] or 0 for r in pld.rows) / 60.0
        previous = {
            "attendance_pct": P._pct(dp, len(pld.working)),
            "punctuality_pct": _punct(dp, late),
            "avg_in": _mean_hhmm([r["in_min"] for r in present]),
            "avg_hours": _r2(round(hrs, 2) / dp) if dp else None,
            "late_days": late,
            "absent_days": sum(1 for r in pld.rows if r["status"] == "absent"),
            "label": P._range_label(ps, pe),
        }

    cld = _Loaded(conn, scope, start=start, end=end, department_ids=company_department_ids)
    single = start == end
    W = len(cld.working)
    company = _brief(_summary(cld.rows, W, single=single)) if cld.rows else None
    department: Optional[dict] = None
    if department_id is not None:
        drows = [r for r in cld.rows if r["department_id"] == department_id]
        if drows:
            department = _brief(_summary(drows, W, single=single))
    return {"previous": previous, "department": department, "company": company}


def _employee_highlights(ld: _Loaded) -> dict:
    by_date = {r["date"]: r for r in ld.rows}
    working = [d for d in ld.days if _is_working(ld, d)]

    # Current streak: walk back from the latest working day with a
    # definitive outcome (skip today/future days still awaiting data).
    current: Optional[dict] = None
    kind: Optional[str] = None
    n = 0
    for d in reversed(working):
        r = by_date.get(d)
        st = r["status"] if r is not None else "pending"
        if kind is None:
            if st == "pending" and d >= ld.today:
                continue
            if r is not None and r["in_min"] is not None:
                kind = "present"
            elif st == "absent":
                kind = "absent"
            else:
                break
            n = 1
            continue
        hit = (r is not None and r["in_min"] is not None) if kind == "present" else st == "absent"
        if not hit:
            break
        n += 1
    if kind is not None:
        current = {"status": kind, "days": n}

    longest = run = 0
    for d in working:
        r = by_date.get(d)
        if r is not None and r["in_min"] is not None:
            run += 1
            longest = max(longest, run)
        elif r is None and d >= ld.today:
            continue
        else:
            run = 0

    late_rows = [r for r in ld.rows if r["status"] == "late"]
    most_late: Optional[str] = None
    if late_rows:
        c = Counter(r["date"].weekday() for r in late_rows)
        w = sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        most_late = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[w]
    late_mins = [r["late_minutes"] for r in late_rows if r["late_minutes"]]
    vs_start = [
        r["in_min"] - P._minutes(r["policy"]["start"])
        for r in ld.rows
        if r["in_min"] is not None and r["policy"].get("start") is not None
    ]
    return {
        "current_streak": current,
        "longest_present_streak": longest,
        "most_late_weekday": most_late,
        "avg_late_minutes": int(round(sum(late_mins) / len(late_mins))) if late_mins else None,
        "avg_minutes_vs_shift_start": (
            int(round(sum(vs_start) / len(vs_start))) if vs_start else None
        ),
    }
