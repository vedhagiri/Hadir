"""Attendance PDF report builder — Template 1 "Classic" (approved 8 Oct 2026).

WeasyPrint renders one of four Jinja layouts under ``templates/``,
chosen from the request filters so the public API (``build_pdf``,
``POST /api/reports/attendance.pdf``, the scheduled-report runner)
is unchanged:

    employee_id set   + start == end  → employee_daily.html
    employee_id set   + start <  end  → employee_range.html
    no employee_id    + start == end  → attendance_daily.html
    no employee_id    + start <  end  → attendance_range.html

All four share ``report.css`` (bundled OFL fonts under ``../fonts`` so
the renderer never opens a network socket), the tenant's branding
accent (``HEX_PALETTE`` keyed by ``primary_color_key``), the tenant
logo + the MTS logo as ``data:`` URLs, and the tenant's timezone /
date / time formats.

Data rules (red lines for this module):

* Attendance figures come from ``attendance_records`` exactly as the
  engine computed them — never recomputed or adjusted here. Derived
  figures (percentages, averages, late minutes) are labelled as such.
* Day boundaries for sightings use the **tenant** timezone, not the
  server's (P11 red line).
* Face crops and reference photos are decrypted in memory only and
  embedded as ``data:`` URLs; nothing is written to disk.
* Cross-tenant / out-of-scope ``employee_id`` never renders a profile:
  the employee layouts are only used when the employee row exists in
  the tenant **and** sits inside the caller's department scope.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import mimetypes
from collections import Counter, OrderedDict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup
from sqlalchemy import and_, func, select, text
from sqlalchemy.engine import Connection

from maugood.attendance.repository import load_tenant_settings
from maugood.branding.constants import DEFAULT_PRIMARY_COLOR_KEY
from maugood.branding.repository import get_branding
from maugood.db import (
    attendance_records,
    departments,
    employee_photos,
    employees,
    holidays,
    leave_types,
    manager_assignments,
    request_reason_categories,
    requests,
    shift_policies,
    tenants,
    users,
)
from maugood.employees.photos import decrypt_bytes, sniff_image_ext
from maugood.tenants.scope import TenantScope
from maugood.util.datetime import TenantFormatter, load_tenant_formatter

logger = logging.getLogger(__name__)


# -- Hex palette per branding key ------------------------------------------
# ``accent`` paints the masthead + table heads, ``accent_2`` the KPI
# rails / bars / chart, ``soft`` the department group rows. The teal
# triple is the approved Template 1 colour set; the others are the
# matching tints for tenants on a different ``primary_color_key``.
# The scheduled-report emailer reads ``accent`` + ``soft`` too.
HEX_PALETTE: dict[str, dict[str, str]] = {
    "teal":   {"accent": "#1d5c60", "accent_2": "#2f7f84", "soft": "#e6f1f1"},
    "navy":   {"accent": "#1e3a8a", "accent_2": "#3b5bb5", "soft": "#e6ecf5"},
    "slate":  {"accent": "#475569", "accent_2": "#64748b", "soft": "#eef1f5"},
    "forest": {"accent": "#1f7a3a", "accent_2": "#2f9a52", "soft": "#e6f5ec"},
    "plum":   {"accent": "#7a1f7a", "accent_2": "#9a3d9a", "soft": "#f5e6f5"},
    "clay":   {"accent": "#a3522e", "accent_2": "#c06f48", "soft": "#f5ebe6"},
    "rose":   {"accent": "#a31752", "accent_2": "#c23a73", "soft": "#f5e6ec"},
    "amber":  {"accent": "#b07a00", "accent_2": "#d09a1e", "soft": "#f5efdc"},
}

_TEMPLATE_DIR = Path(__file__).parent / "templates"
_ASSET_DIR = Path(__file__).parent / "assets"
_REPORT_CSS = _TEMPLATE_DIR / "report.css"

# Longest list the exception tables will print before collapsing to a
# "showing first N" row — keeps a 90-day company report bounded.
MAX_EXCEPTION_ROWS = 300
# Employee daily: sightings above this collapse the middle of the day.
MAX_SIGHTING_ROWS = 120
# A quiet stretch longer than this (minutes) counts as a "gap".
GAP_THRESHOLD_MINUTES = 30

_AVATAR_COLORS = (
    "#2f7f84", "#0f766e", "#6d28d9", "#b45309",
    "#be123c", "#1d4ed8", "#4d7c0f", "#9d174d",
)

_WEEKDAY_ABBR = {
    "Monday": "Mon", "Tuesday": "Tue", "Wednesday": "Wed", "Thursday": "Thu",
    "Friday": "Fri", "Saturday": "Sat", "Sunday": "Sun",
}


def _cssq(value: Any) -> Markup:
    """Quote a Python string as a CSS string literal.

    Used for ``content:`` in the running header/footer. HTML
    autoescaping would emit ``&#34;`` which the CSS parser does not
    decode, so this escapes for CSS and marks the result safe.
    """

    s = str(value).replace("\\", "\\\\").replace('"', '\\"')
    s = s.replace("\r", " ").replace("\n", " ")
    return Markup(f'"{s}"')


_jinja_env = Environment(
    loader=FileSystemLoader(_TEMPLATE_DIR),
    autoescape=select_autoescape(("html", "xml")),
    trim_blocks=True,
    lstrip_blocks=True,
)
_jinja_env.filters["cssq"] = _cssq


# ---------------------------------------------------------------------------
# Small formatting helpers
# ---------------------------------------------------------------------------


def _long_date(d: date) -> str:
    return f"{d:%A}, {d.day} {d:%B %Y}"


def _short_day(d: date) -> str:
    return f"{d:%a} {d.day} {d:%b}"


def _medium_date(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def _range_label(s: date, e: date) -> str:
    if s == e:
        return _long_date(s)
    if (s.year, s.month) == (e.year, e.month):
        return f"{s.day} – {e.day} {e:%B %Y}"
    if s.year == e.year:
        return f"{s.day} {s:%B} – {e.day} {e:%B %Y}"
    return f"{s.day} {s:%B %Y} – {e.day} {e:%B %Y}"


def _initials(name: str) -> str:
    parts = [p for p in str(name).split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _avatar_color(code: str) -> str:
    h = hashlib.sha1(str(code).encode("utf-8")).digest()[0]
    return _AVATAR_COLORS[h % len(_AVATAR_COLORS)]


def _minutes(t: Optional[time]) -> Optional[int]:
    return None if t is None else t.hour * 60 + t.minute


def _time_from_minutes(m: int) -> time:
    return time((m // 60) % 24, m % 60)


def _weekend_label(weekend_days: tuple[str, ...]) -> str:
    if not weekend_days:
        return "none"
    return "/".join(_WEEKDAY_ABBR.get(d, d[:3]) for d in weekend_days)


def _hm(minutes: int) -> str:
    h, m = divmod(int(minutes), 60)
    return f"{h}h {m:02d}m" if h else f"{m}m"


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("Asia/Muscat")


def _pct(n: float, d: float) -> int:
    return int(round(100.0 * n / d)) if d else 0


def _mean(values: list[float]) -> Optional[float]:
    return (sum(values) / len(values)) if values else None


# ---------------------------------------------------------------------------
# Images → data: URLs (never a network socket, never a temp file)
# ---------------------------------------------------------------------------


def _file_data_url(path: Path, mime: Optional[str] = None) -> Optional[str]:
    try:
        if not path.is_file():
            return None
        raw = path.read_bytes()
    except OSError as exc:  # pragma: no cover — disk-shape edge case
        logger.warning("could not read %s: %s", path, exc)
        return None
    if mime is None:
        mime, _ = mimetypes.guess_type(str(path))
    return f"data:{mime or 'image/png'};base64,{base64.b64encode(raw).decode('ascii')}"


def _logo_data_url(logo_path: Optional[str]) -> Optional[str]:
    """Encode the tenant's logo as a ``data:`` URL. Missing files
    return ``None`` — the masthead falls back to an initial tile."""

    if not logo_path:
        return None
    return _file_data_url(Path(logo_path))


def _mts_logo_data_url() -> Optional[str]:
    return _file_data_url(_ASSET_DIR / "mts-logo.png", "image/png")


def _crop_to_data_url(file_path: Optional[str]) -> Optional[str]:
    """Decrypt an on-disk Fernet crop / reference photo and return a
    ``data:`` URL. Any failure returns ``None`` so the template shows
    the dashed placeholder instead of breaking the render."""

    if not file_path:
        return None
    try:
        p = Path(file_path)
        if not p.is_file():
            return None
        plain = decrypt_bytes(p.read_bytes())
    except (OSError, RuntimeError, ValueError) as exc:
        logger.warning("could not decrypt image %s for PDF: %s", file_path, exc)
        return None
    ext = sniff_image_ext(plain) or "jpg"
    mime = "image/png" if ext == "png" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(plain).decode('ascii')}"


# ---------------------------------------------------------------------------
# Shift policy facts (labels + thresholds for the late / early minutes)
# ---------------------------------------------------------------------------


def _parse_hhmm(value: Any) -> Optional[time]:
    if not value:
        return None
    try:
        hh, mm = str(value).split(":")[:2]
        return time(int(hh), int(mm))
    except (TypeError, ValueError):
        return None


def _policy_facts(
    ptype: Optional[str], config: Optional[dict], name: Optional[str], fmt: TenantFormatter
) -> dict:
    """Describe a shift policy for the report.

    Fixed-like (``start``/``end``/``grace_minutes``) and Flex-like
    (``in_window_*``/``out_window_*``) configs are recognised by their
    keys so Ramadan + Custom policies describe themselves correctly.
    The thresholds are only used to *decorate* the engine's flags with
    a minute count; they never decide whether a flag is shown.
    """

    cfg = config or {}
    ptype = str(ptype or "Fixed")
    required_hours = int(cfg.get("required_hours", 8) or 8)
    start = _parse_hhmm(cfg.get("start"))
    end = _parse_hhmm(cfg.get("end"))
    grace = int(cfg.get("grace_minutes", 0) or 0)
    in_end = _parse_hhmm(cfg.get("in_window_end"))
    in_start = _parse_hhmm(cfg.get("in_window_start"))
    out_start = _parse_hhmm(cfg.get("out_window_start"))
    out_end = _parse_hhmm(cfg.get("out_window_end"))

    facts: dict[str, Any] = {
        "name": name or ptype,
        "type": ptype,
        "required_hours": required_hours,
        "required_minutes": required_hours * 60,
        "required_label": f"{required_hours} h / day",
        "required_hours_label": f"{required_hours:.1f} h",
        "grace_label": None,
        "late_threshold": None,
        "early_threshold": None,
        "start": start,
        "end": end,
        "window_label": None,
    }
    if start is not None and end is not None:
        s, e = fmt.format_time(start), fmt.format_time(end)
        facts["shift_label"] = f"{ptype} · {s}–{e}"
        facts["window_label"] = f"{s} – {e}"
        facts["grace_label"] = f"{grace} min" if grace else None
        late_t = (datetime.combine(date(2000, 1, 1), start) + timedelta(minutes=grace)).time()
        early_t = (datetime.combine(date(2000, 1, 1), end) - timedelta(minutes=grace)).time()
        facts["late_threshold"] = late_t
        facts["early_threshold"] = early_t
        facts["late_hint"] = f"vs {fmt.format_time(late_t)} grace" if grace else f"vs {s} start"
        facts["method_note"] = (
            f"Late = in-time after {fmt.format_time(late_t)}"
            + (f" ({s} + {grace} min grace)" if grace else "")
            + f". Early out = out-time before {fmt.format_time(early_t)}. "
            f"Overtime = time beyond the {required_hours} h required."
        )
    elif in_start is not None and in_end is not None:
        facts["shift_label"] = (
            f"{ptype} · in {fmt.format_time(in_start)}–{fmt.format_time(in_end)}"
        )
        facts["window_label"] = (
            f"in {fmt.format_time(in_start)} – {fmt.format_time(in_end)}"
            + (
                f" · out {fmt.format_time(out_start)} – {fmt.format_time(out_end)}"
                if out_start and out_end
                else ""
            )
        )
        facts["late_threshold"] = in_end
        facts["early_threshold"] = out_start
        facts["late_hint"] = f"vs {fmt.format_time(in_end)} window end"
        facts["method_note"] = (
            f"Late = in-time after {fmt.format_time(in_end)}"
            + (f". Early out = out-time before {fmt.format_time(out_start)}" if out_start else "")
            + f". Overtime = time beyond the {required_hours} h required."
        )
    else:
        facts["shift_label"] = name or ptype
        facts["late_hint"] = "after the policy grace"
        facts["method_note"] = (
            f"Late / early flags follow the assigned shift policy. "
            f"Overtime = time beyond the {required_hours} h required."
        )
    return facts


def _policy_cache(fmt: TenantFormatter) -> dict[int, dict]:
    return {}


def _facts_for(cache: dict[int, dict], r: Any, fmt: TenantFormatter) -> dict:
    pid = int(r.policy_id) if r.policy_id is not None else -1
    f = cache.get(pid)
    if f is None:
        f = _policy_facts(r.policy_type, r.policy_config, r.policy_name, fmt)
        cache[pid] = f
    return f


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


def _query_rows(
    conn: Connection,
    scope: TenantScope,
    *,
    start_date: date,
    end_date: date,
    department_ids: Optional[list[int]],
    employee_id: Optional[int],
) -> list:
    """Attendance rows joined with employee / department / policy / leave.

    Outer joins on department + policy + leave type so an employee
    with a missing department (or a deleted policy row) still prints.
    """

    stmt = (
        select(
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.designation,
            employees.c.department_id,
            departments.c.code.label("department_code"),
            departments.c.name.label("department_name"),
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.late,
            attendance_records.c.early_out,
            attendance_records.c.short_hours,
            attendance_records.c.absent,
            attendance_records.c.overtime_minutes,
            attendance_records.c.leave_type_id,
            attendance_records.c.policy_id,
            leave_types.c.name.label("leave_name"),
            shift_policies.c.name.label("policy_name"),
            shift_policies.c.type.label("policy_type"),
            shift_policies.c.config.label("policy_config"),
        )
        .select_from(
            attendance_records.join(
                employees,
                and_(
                    employees.c.id == attendance_records.c.employee_id,
                    employees.c.tenant_id == attendance_records.c.tenant_id,
                ),
            )
            .join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
                isouter=True,
            )
            .join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id == attendance_records.c.tenant_id,
                ),
                isouter=True,
            )
            .join(
                leave_types,
                and_(
                    leave_types.c.id == attendance_records.c.leave_type_id,
                    leave_types.c.tenant_id == attendance_records.c.tenant_id,
                ),
                isouter=True,
            )
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date >= start_date,
            attendance_records.c.date <= end_date,
        )
        .order_by(
            employees.c.employee_code.asc(),
            attendance_records.c.date.asc(),
        )
    )
    if department_ids is not None:
        if not department_ids:
            return []
        stmt = stmt.where(employees.c.department_id.in_(department_ids))
    if employee_id is not None:
        stmt = stmt.where(employees.c.id == employee_id)
    return list(conn.execute(stmt))


_SIGHTINGS_SUMMARY_SQL = text(
    """
    SELECT de.employee_id,
           (de.captured_at AT TIME ZONE :tz)::date AS d,
           (array_agg(de.face_crop_path ORDER BY de.captured_at ASC)
                FILTER (WHERE de.face_crop_path IS NOT NULL))[1] AS first_path,
           (array_agg(de.face_crop_path ORDER BY de.captured_at DESC)
                FILTER (WHERE de.face_crop_path IS NOT NULL))[1] AS last_path,
           (array_agg(COALESCE(c.name, CASE WHEN de.device_id IS NOT NULL THEN 'Terminal' END)
                ORDER BY de.captured_at ASC))[1] AS first_cam,
           count(*) AS n,
           avg(de.confidence) AS conf
      FROM detection_events de
      LEFT JOIN cameras c
        ON c.id = de.camera_id AND c.tenant_id = de.tenant_id
     WHERE de.tenant_id = :tenant_id
       AND de.employee_id IS NOT NULL
       AND de.captured_at >= :lo
       AND de.captured_at <  :hi
       AND (CAST(:emp_id AS INTEGER) IS NULL OR de.employee_id = :emp_id)
     GROUP BY de.employee_id, (de.captured_at AT TIME ZONE :tz)::date
    """
)


def _day_bounds(d0: date, d1: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC-aware ``[local midnight d0, local midnight d1 + 1 day)``."""

    lo = datetime.combine(d0, time.min, tzinfo=tz)
    hi = datetime.combine(d1 + timedelta(days=1), time.min, tzinfo=tz)
    return lo.astimezone(timezone.utc), hi.astimezone(timezone.utc)


def _sightings_summary(
    conn: Connection,
    scope: TenantScope,
    *,
    start_date: date,
    end_date: date,
    tz: ZoneInfo,
    employee_id: Optional[int],
) -> dict[tuple[int, date], Any]:
    """One row per ``(employee, local day)``: first/last crop path, the
    camera of the first sighting, sighting count, mean confidence."""

    lo, hi = _day_bounds(start_date, end_date, tz)
    rows = conn.execute(
        _SIGHTINGS_SUMMARY_SQL,
        {
            "tz": tz.key,
            "tenant_id": scope.tenant_id,
            "lo": lo,
            "hi": hi,
            "emp_id": employee_id,
        },
    ).all()
    return {(int(r.employee_id), r.d): r for r in rows}


_SIGHTINGS_DAY_SQL = text(
    """
    SELECT de.captured_at, de.face_crop_path, de.confidence, de.device_id,
           c.name AS camera_name, c.location AS camera_location
      FROM detection_events de
      LEFT JOIN cameras c
        ON c.id = de.camera_id AND c.tenant_id = de.tenant_id
     WHERE de.tenant_id = :tenant_id
       AND de.employee_id = :emp_id
       AND de.captured_at >= :lo
       AND de.captured_at <  :hi
     ORDER BY de.captured_at ASC
    """
)


def _sightings_for_day(
    conn: Connection, scope: TenantScope, *, employee_id: int, on_date: date, tz: ZoneInfo
) -> list:
    lo, hi = _day_bounds(on_date, on_date, tz)
    return conn.execute(
        _SIGHTINGS_DAY_SQL,
        {"tenant_id": scope.tenant_id, "emp_id": employee_id, "lo": lo, "hi": hi},
    ).all()


def _holidays_between(conn: Connection, scope: TenantScope, start: date, end: date) -> dict[date, str]:
    rows = conn.execute(
        select(holidays.c.date, holidays.c.name).where(
            holidays.c.tenant_id == scope.tenant_id,
            holidays.c.active.is_(True),
            holidays.c.date >= start,
            holidays.c.date <= end,
        )
    ).all()
    return {r.date: str(r.name) for r in rows}


def _employee_profile(conn: Connection, scope: TenantScope, employee_id: int) -> Optional[dict]:
    row = conn.execute(
        select(
            employees.c.id,
            employees.c.employee_code,
            employees.c.full_name,
            employees.c.designation,
            employees.c.department_id,
            employees.c.reports_to_user_id,
            employees.c.reports_to_employee_id,
            departments.c.name.label("department_name"),
            departments.c.code.label("department_code"),
        )
        .select_from(
            employees.join(
                departments,
                and_(
                    departments.c.id == employees.c.department_id,
                    departments.c.tenant_id == employees.c.tenant_id,
                ),
                isouter=True,
            )
        )
        .where(employees.c.tenant_id == scope.tenant_id, employees.c.id == employee_id)
    ).first()
    if row is None:
        return None

    photo_count = int(
        conn.execute(
            select(func.count())
            .select_from(employee_photos)
            .where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.employee_id == employee_id,
            )
        ).scalar_one()
    )
    photo_row = conn.execute(
        select(employee_photos.c.file_path)
        .where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.employee_id == employee_id,
        )
        .order_by(
            (employee_photos.c.angle == "front").desc(),
            employee_photos.c.created_at.asc(),
        )
        .limit(1)
    ).first()

    manager_name: Optional[str] = None
    mgr = conn.execute(
        select(users.c.full_name)
        .select_from(
            manager_assignments.join(
                users,
                and_(
                    users.c.id == manager_assignments.c.manager_user_id,
                    users.c.tenant_id == manager_assignments.c.tenant_id,
                ),
            )
        )
        .where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.employee_id == employee_id,
        )
        .order_by(manager_assignments.c.is_primary.desc(), manager_assignments.c.id.asc())
        .limit(1)
    ).scalar()
    if mgr:
        manager_name = str(mgr)
    elif row.reports_to_user_id is not None:
        manager_name = conn.execute(
            select(users.c.full_name).where(
                users.c.tenant_id == scope.tenant_id, users.c.id == row.reports_to_user_id
            )
        ).scalar()
    elif row.reports_to_employee_id is not None:
        manager_name = conn.execute(
            select(employees.c.full_name).where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.id == row.reports_to_employee_id,
            )
        ).scalar()

    return {
        "employee_id": int(row.id),
        "employee_code": str(row.employee_code),
        "full_name": str(row.full_name),
        "designation": str(row.designation) if row.designation else None,
        "department_id": int(row.department_id) if row.department_id is not None else None,
        "department_name": str(row.department_name) if row.department_name else "—",
        "department_code": str(row.department_code) if row.department_code else "",
        "photo_count": photo_count,
        "photo_data_url": _crop_to_data_url(photo_row.file_path) if photo_row else None,
        "manager_name": str(manager_name) if manager_name else None,
        "initials": _initials(str(row.full_name)),
    }


_REQUEST_STAGE = {
    "submitted": ("late", "With manager"),
    "manager_approved": ("lv", "With HR"),
    "manager_rejected": ("bad", "Rejected"),
    "hr_approved": ("ok", "Approved"),
    "hr_rejected": ("bad", "Rejected"),
    "admin_approved": ("ok", "Approved"),
    "admin_rejected": ("bad", "Rejected"),
    "cancelled": ("we", "Cancelled"),
}


def _requests_in_period(
    conn: Connection, scope: TenantScope, *, employee_id: int, start: date, end: date
) -> list[dict]:
    rows = conn.execute(
        select(
            requests.c.type,
            requests.c.reason_category,
            requests.c.target_date_start,
            requests.c.target_date_end,
            requests.c.status,
            leave_types.c.name.label("leave_name"),
        )
        .select_from(
            requests.join(
                leave_types,
                and_(
                    leave_types.c.id == requests.c.leave_type_id,
                    leave_types.c.tenant_id == requests.c.tenant_id,
                ),
                isouter=True,
            )
        )
        .where(
            requests.c.tenant_id == scope.tenant_id,
            requests.c.employee_id == employee_id,
            requests.c.target_date_start <= end,
            func.coalesce(requests.c.target_date_end, requests.c.target_date_start) >= start,
        )
        .order_by(requests.c.target_date_start.asc(), requests.c.id.asc())
    ).all()
    if not rows:
        return []
    cats = {
        (str(r.request_type), str(r.code)): str(r.name)
        for r in conn.execute(
            select(
                request_reason_categories.c.request_type,
                request_reason_categories.c.code,
                request_reason_categories.c.name,
            ).where(request_reason_categories.c.tenant_id == scope.tenant_id)
        ).all()
    }
    out = []
    for r in rows:
        rtype = str(r.type)
        type_label = "Exception" if rtype == "exception" else (
            f"Leave · {r.leave_name}" if r.leave_name else "Leave"
        )
        cls, stage = _REQUEST_STAGE.get(str(r.status), ("pend", str(r.status).replace("_", " ").title()))
        out.append(
            {
                "day_label": _short_day(r.target_date_start),
                "type_label": type_label,
                "reason": cats.get((rtype, str(r.reason_category or "")), str(r.reason_category or "—")),
                "stage_status": cls,
                "stage_label": stage,
                "status_raw": str(r.status),
                "date": r.target_date_start,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Row normalisation
# ---------------------------------------------------------------------------

_EXCEPTION_ORDER = {"absent": 0, "late": 1, "early": 2, "short": 3}


def _row_status(r: Any, *, is_weekend: bool, is_holiday: bool) -> str:
    if r.leave_type_id is not None:
        return "leave"
    if r.absent:
        return "absent"
    if r.in_time is None:
        if is_holiday:
            return "holiday"
        if is_weekend:
            return "weekend"
        return "pending"
    if r.late:
        return "late"
    if r.early_out:
        return "early"
    return "present"


def _mk_row(
    r: Any,
    *,
    fmt: TenantFormatter,
    pcache: dict[int, dict],
    holiday_names: dict[date, str],
    weekend_days: tuple[str, ...],
    sight: Optional[Any],
    with_crops: bool,
) -> dict:
    facts = _facts_for(pcache, r, fmt)
    d: date = r.date
    is_weekend = d.strftime("%A") in weekend_days
    is_holiday = d in holiday_names
    status = _row_status(r, is_weekend=is_weekend, is_holiday=is_holiday)

    in_m, out_m = _minutes(r.in_time), _minutes(r.out_time)
    hours = round(r.total_minutes / 60.0, 2) if r.total_minutes is not None else None

    late_min: Optional[int] = None
    early_min: Optional[int] = None
    if r.late and in_m is not None and facts["late_threshold"] is not None:
        v = in_m - _minutes(facts["late_threshold"])
        late_min = v if v > 0 else None
    if r.early_out and out_m is not None and facts["early_threshold"] is not None:
        v = _minutes(facts["early_threshold"]) - out_m
        early_min = v if v > 0 else None
    short_min: Optional[int] = None
    if r.short_hours and r.total_minutes is not None:
        v = facts["required_minutes"] - int(r.total_minutes)
        short_min = v if v > 0 else None

    flags: list[tuple[str, str]] = []
    flags_empty = "—"
    if status == "absent":
        flags_empty = "No detection"
    elif status == "leave":
        flags_empty = f"{r.leave_name or 'Leave'} · approved"
    elif status == "holiday":
        flags_empty = holiday_names.get(d, "Public holiday")
    else:
        if r.late:
            flags.append(("late", f"Late {late_min}m" if late_min else "Late"))
        if r.early_out:
            flags.append(("early", f"Early {early_min}m" if early_min else "Early out"))
        if r.short_hours and r.in_time is not None:
            flags.append(("short", f"Short {short_min / 60:.1f}h" if short_min else "Short hours"))
        if r.overtime_minutes:
            flags.append(("ot", f"OT {_hm(int(r.overtime_minutes))}"))

    exception_status: Optional[str] = None
    if status in ("absent", "late", "early"):
        exception_status = status
    elif r.short_hours and r.in_time is not None:
        exception_status = "short"

    return {
        "employee_id": int(r.employee_id),
        "employee_code": str(r.employee_code),
        "full_name": str(r.full_name),
        "designation": str(r.designation) if r.designation else None,
        "department_id": int(r.department_id) if r.department_id is not None else None,
        "department_name": str(r.department_name) if r.department_name else "—",
        "date": d,
        "day_label": _short_day(d),
        "status": status,
        "exception_status": exception_status,
        "exception_order": _EXCEPTION_ORDER.get(exception_status or "", 9),
        "in_label": fmt.format_time(r.in_time) if r.in_time else "",
        "out_label": fmt.format_time(r.out_time) if r.out_time else "",
        "in_min": in_m,
        "out_min": out_m,
        "hours": hours,
        "total_minutes": int(r.total_minutes) if r.total_minutes is not None else None,
        "late": bool(r.late),
        "early_out": bool(r.early_out),
        "short_hours": bool(r.short_hours),
        "absent": bool(r.absent),
        "late_minutes": late_min,
        "early_minutes": early_min,
        "ot_minutes": int(r.overtime_minutes or 0),
        "leave_name": str(r.leave_name) if r.leave_name else None,
        "flags": flags,
        "flags_empty": flags_empty,
        "policy_label": facts["shift_label"],
        "policy_name": str(r.policy_name) if r.policy_name else facts["shift_label"],
        "policy": facts,
        "source": str(sight.first_cam) if sight is not None and sight.first_cam else None,
        "sightings": int(sight.n) if sight is not None else 0,
        "confidence": float(sight.conf) if sight is not None and sight.conf is not None else None,
        "in_crop": _crop_to_data_url(sight.first_path) if (with_crops and sight is not None) else None,
        "out_crop": (
            _crop_to_data_url(sight.last_path)
            if (with_crops and sight is not None and sight.last_path != sight.first_path)
            else None
        ),
        "initials": _initials(str(r.full_name)),
        "avatar_color": _avatar_color(str(r.employee_code)),
        "is_weekend": is_weekend,
        "is_holiday": is_holiday,
    }


def _fix_out_crop(row: dict) -> dict:
    """When first and last crop are the same file, reuse the decoded
    in-crop for the out column instead of decrypting twice."""

    if row["in_crop"] is not None and row["out_crop"] is None and row["sightings"] == 1:
        row["out_crop"] = row["in_crop"]
    return row


def _timeline_segments(
    in_m: Optional[int], out_m: Optional[int], *, lo: int, hi: int, policy_end: Optional[int],
    gaps: Optional[list[tuple[int, int]]] = None,
) -> list[tuple[str, float, float]]:
    """Return ``(class, left%, width%)`` tuples for the day ribbon."""

    if in_m is None or out_m is None or hi <= lo:
        return []
    if out_m < in_m:
        out_m += 24 * 60  # overnight shift
    span = float(hi - lo)

    def pos(m: int) -> float:
        return max(0.0, min(100.0, (m - lo) / span * 100.0))

    segs: list[tuple[str, float, float]] = []
    body_end = out_m
    if policy_end is not None:
        if policy_end < in_m:
            policy_end += 24 * 60
        body_end = min(out_m, policy_end)
    segs.append(("", pos(in_m), max(0.6, pos(body_end) - pos(in_m))))
    if policy_end is not None and out_m > policy_end:
        segs.append(("ot", pos(policy_end), pos(out_m) - pos(policy_end)))
    for a, b in gaps or []:
        segs.append(("gap", pos(a), max(0.6, pos(b) - pos(a))))
    return segs


def _axis_bounds(rows: list[dict], facts: dict) -> tuple[int, int]:
    """Whole-hour window covering every in/out plus the policy day,
    never narrower than 06:00–18:00."""

    lo, hi = 6 * 60, 18 * 60
    if facts.get("start") is not None:
        lo = min(lo, (_minutes(facts["start"]) // 60 - 1) * 60)
    if facts.get("end") is not None:
        e = _minutes(facts["end"])
        if facts.get("start") is not None and e < _minutes(facts["start"]):
            e += 24 * 60
        hi = max(hi, ((e + 59) // 60 + 1) * 60)
    for r in rows:
        if r.get("in_min") is not None:
            lo = min(lo, (r["in_min"] // 60) * 60)
        if r.get("out_min") is not None:
            o = r["out_min"]
            if r.get("in_min") is not None and o < r["in_min"]:
                o += 24 * 60
            hi = max(hi, ((o + 59) // 60) * 60)
    lo = max(0, lo)
    hi = min(48 * 60, max(hi, lo + 120))
    return lo, hi


def _axis_labels(lo: int, hi: int, fmt: TenantFormatter) -> dict:
    # At most 7 ticks in 24h format, 5 in 12h (labels are wider).
    max_ticks = 5 if fmt.time_format == "12h" else 7
    step = 60
    while (hi - lo) // step + 1 > max_ticks:
        step += 60
    ticks = [fmt.format_time(_time_from_minutes(m)) for m in range(lo, hi + 1, step)]
    return {
        "lo": lo,
        "hi": hi,
        "ticks": ticks,
        "label": f"{fmt.format_time(_time_from_minutes(lo))} – {fmt.format_time(_time_from_minutes(hi))}",
        "short": f"{(lo // 60) % 24:02d} – {(hi // 60) % 24:02d}",
    }


# ---------------------------------------------------------------------------
# Shared context pieces
# ---------------------------------------------------------------------------


def _branding_for_tenant(conn: Connection, *, tenant_id: int) -> dict:
    """Accent hexes + optional ``data:`` logo for the template."""

    branding = get_branding(conn, tenant_id=tenant_id)
    palette = HEX_PALETTE.get(branding.primary_color_key, HEX_PALETTE[DEFAULT_PRIMARY_COLOR_KEY])
    return {
        "primary_color_key": branding.primary_color_key,
        "font_key": branding.font_key,
        "accent_hex": palette["accent"],
        "accent_2_hex": palette["accent_2"],
        "accent_soft_hex": palette["soft"],
        "logo_data_url": _logo_data_url(branding.logo_path),
    }


class TenantNotFoundError(Exception):
    """Raised when the tenant row can't be resolved (router → 404)."""


def _tenant_summary(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(tenants.c.id, tenants.c.name, tenants.c.slug, tenants.c.schema_name).where(
            tenants.c.id == tenant_id
        )
    ).first()
    if row is None:
        raise TenantNotFoundError(f"tenant id {tenant_id} not found")
    return {
        "id": int(row.id),
        "name": str(row.name),
        "slug": str(row.slug),
        "schema_name": str(row.schema_name),
    }


def filename_for(*, slug: str, start: date, end: date) -> str:
    """``maugood-attendance-{tenant_slug}-{from}-to-{to}.pdf`` (spec'd
    in P17; the friendly slug, never the Postgres schema name)."""

    return f"maugood-attendance-{slug}-{start.isoformat()}-to-{end.isoformat()}.pdf"


def _group_by_department(rows: list[dict]) -> "OrderedDict[str, list[dict]]":
    by: "OrderedDict[str, list[dict]]" = OrderedDict()
    for r in sorted(rows, key=lambda x: (x["department_name"].lower(), x["full_name"].lower())):
        by.setdefault(r["department_name"], []).append(r)
    return by


def _dept_stats(name: str, rows: list[dict]) -> dict:
    present = [r for r in rows if r["in_min"] is not None]
    return {
        "name": name,
        "headcount": len(rows),
        "present": len(present),
        "late": sum(1 for r in rows if r["status"] == "late"),
        "absent": sum(1 for r in rows if r["status"] == "absent"),
        "leave": sum(1 for r in rows if r["status"] == "leave"),
        "avg_hours": _mean([r["hours"] for r in present if r["hours"] is not None]),
        "ot_hours": round(sum(r["ot_minutes"] for r in rows) / 60.0, 2),
        "pct": _pct(len(present), len(rows)),
    }


_BREAKDOWN = (
    ("present", "Present, on time", "#2a8a5c", +1),
    ("late", "Late", "#b4791a", -1),
    ("early", "Early out", "#d9a441", -1),
    ("absent", "Absent", "#c0392b", -1),
    ("leave", "On leave", "#2b6cb0", 0),
    ("weekend", "Weekend", "#b7c1be", 0),
    ("holiday", "Holiday", "#6a4bc4", 0),
    ("pending", "No record", "#9aa8a5", 0),
)


def _breakdown(rows: list[dict], prev_rows: Optional[list[dict]], prev_label: Optional[str]) -> dict:
    cur = Counter(r["status"] for r in rows)
    prev = Counter(r["status"] for r in prev_rows) if prev_rows is not None else None
    total = len(rows)
    out = []
    for key, label, color, polarity in _BREAKDOWN:
        n = cur.get(key, 0)
        if key in ("pending", "weekend", "holiday") and n == 0:
            continue
        delta = (n - prev.get(key, 0)) if prev is not None else None
        out.append(
            {
                "key": key,
                "label": label,
                "count": n,
                "share": (100.0 * n / total) if total else 0.0,
                "color": color,
                "delta": delta,
                "delta_good": delta is not None and polarity and (delta * polarity) > 0,
                "delta_bad": delta is not None and polarity and (delta * polarity) < 0,
            }
        )
    return {"rows": out, "prev_label": prev_label if prev_rows is not None else None}


# ---------------------------------------------------------------------------
# Context builders — one per layout
# ---------------------------------------------------------------------------


def _common_context(
    *,
    tenant: dict,
    branding: dict,
    fmt: TenantFormatter,
    tz: ZoneInfo,
    now_utc: datetime,
    generated_by_email: str,
    show_photos: bool,
    title: str,
    running_head: str,
    body_class: str,
) -> dict:
    return {
        "tenant": tenant,
        "branding": branding,
        "title": title,
        "running_head": running_head,
        "body_class": body_class,
        "generated_at_label": fmt.format_datetime(now_utc),
        "generated_by_email": generated_by_email or "—",
        "year": now_utc.astimezone(tz).year,
        "mts_logo_data_url": _mts_logo_data_url(),
        "show_photos": show_photos,
        "timezone": tz.key,
    }


def _scope_label(department_label: Optional[str]) -> str:
    return department_label or "All departments"


def _daily_context(
    conn: Connection,
    scope: TenantScope,
    rows: list[dict],
    *,
    the_date: date,
    department_ids: Optional[list[int]],
    department_label: Optional[str],
    fmt: TenantFormatter,
    tz: ZoneInfo,
    holiday_names: dict[date, str],
    weekend_days: tuple[str, ...],
    pcache: dict[int, dict],
    report_id: str,
    generated_at_label: str,
    generated_by_email: str,
) -> dict:
    total = len(rows)
    present_rows = [r for r in rows if r["in_min"] is not None]
    late_rows = [r for r in rows if r["status"] == "late"]
    early_rows = [r for r in rows if r["status"] == "early"]
    absent_rows = [r for r in rows if r["status"] == "absent"]
    leave_rows = [r for r in rows if r["status"] == "leave"]
    ot_rows = [r for r in rows if r["ot_minutes"] > 0]
    late_mins = [r["late_minutes"] for r in late_rows if r["late_minutes"]]

    k = {
        "total": total,
        "present": len(present_rows),
        "present_pct": _pct(len(present_rows), total),
        "late": len(late_rows),
        "early": len(early_rows),
        "absent": len(absent_rows),
        "absent_pct": _pct(len(absent_rows), total),
        "leave": len(leave_rows),
        "ot_hours": round(sum(r["ot_minutes"] for r in rows) / 60.0, 2),
        "ot_employees": len(ot_rows),
        "avg_hours": _mean([r["hours"] for r in present_rows if r["hours"] is not None]),
        "late_hint": (
            f"after grace · avg {int(round(sum(late_mins) / len(late_mins)))} min"
            if late_mins
            else "arrivals after the policy grace"
        ),
    }

    # Previous day with records (same filters) for the "change" column.
    prev_rows_n: Optional[list[dict]] = None
    prev_label: Optional[str] = None
    prev_date = conn.execute(
        select(func.max(attendance_records.c.date)).where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date < the_date,
            attendance_records.c.date >= the_date - timedelta(days=14),
        )
    ).scalar()
    if prev_date is not None:
        prev_raw = _query_rows(
            conn, scope, start_date=prev_date, end_date=prev_date,
            department_ids=department_ids, employee_id=None,
        )
        prev_rows_n = [
            _mk_row(r, fmt=fmt, pcache=pcache, holiday_names=holiday_names,
                    weekend_days=weekend_days, sight=None, with_crops=False)
            for r in prev_raw
        ]
        prev_label = _short_day(prev_date)

    by_dept = _group_by_department(rows)
    departments_stats = sorted(
        (_dept_stats(name, rs) for name, rs in by_dept.items()),
        key=lambda d: (-d["pct"], -d["headcount"], d["name"]),
    )
    groups = [
        {"name": name, "headcount": len(rs), "present": sum(1 for r in rs if r["in_min"] is not None), "rows": rs}
        for name, rs in by_dept.items()
    ]
    exceptions = sorted(
        (r for r in rows if r["exception_status"]),
        key=lambda r: (r["exception_order"], r["full_name"].lower()),
    )

    is_working = the_date.strftime("%A") not in weekend_days and the_date not in holiday_names
    day_kind = "working day" if is_working else ("holiday · " + holiday_names[the_date] if the_date in holiday_names else "weekend")
    box = [
        ("Report ID", report_id, "mono"),
        ("Generated", generated_at_label, ""),
        ("By", generated_by_email or "—", ""),
        ("Scope", f"{total} active employee{'s' if total != 1 else ''} · {len(by_dept)} department{'s' if len(by_dept) != 1 else ''}", ""),
        ("Date", f"{_medium_date(the_date)} · {day_kind}", ""),
        ("Timezone", tz.key, ""),
    ]
    return {
        "period_label": f"{_long_date(the_date)} · {_scope_label(department_label)}",
        "box": box,
        "k": k,
        "breakdown": _breakdown(rows, prev_rows_n, prev_label),
        "departments": departments_stats,
        "exceptions": exceptions[:MAX_EXCEPTION_ROWS],
        "exceptions_total": len(exceptions),
        "groups": groups,
    }


def _chart(
    days: list[date],
    *,
    rows_by_day: dict[date, list[dict]],
    total: int,
    working: set[date],
    holiday_names: dict[date, str],
) -> dict:
    """Bar geometry for the presence chart. Per day up to 31 days,
    per ISO week beyond that (keeps labels legible on a 90-day run)."""

    bars: list[dict] = []
    if len(days) <= 31:
        unit = "day"
        for d in days:
            if d not in working:
                bars.append({"pct": None, "kind": "Holiday" if d in holiday_names else "Weekend", "label": f"{d:%a} {d.day}"})
            else:
                present = sum(1 for r in rows_by_day.get(d, []) if r["in_min"] is not None)
                bars.append({"pct": _pct(present, total), "kind": None, "label": f"{d:%a} {d.day}"})
    else:
        unit = "week"
        weeks: "OrderedDict[tuple[int, int], list[date]]" = OrderedDict()
        for d in days:
            iso = d.isocalendar()
            weeks.setdefault((iso[0], iso[1]), []).append(d)
        for (_, wk), ds in weeks.items():
            wdays = [d for d in ds if d in working]
            if not wdays or not total:
                bars.append({"pct": None, "kind": "Off", "label": f"W{wk}"})
                continue
            present = sum(
                1 for d in wdays for r in rows_by_day.get(d, []) if r["in_min"] is not None
            )
            bars.append({"pct": _pct(present, total * len(wdays)), "kind": None, "label": f"W{wk}"})

    # Fixed 400 x 190 viewBox scaled into the ~198 pt wide side panel;
    # bars share the width, labels thin out beyond ten bars.
    n = max(1, len(bars))
    vw, x0 = 400.0, 44.0
    avail = vw - x0 - 10.0
    gap = max(2.0, min(12.0, avail / n * 0.3))
    bw = max(4.0, avail / n - gap)
    label_every = max(1, -(-n // 10))
    x = x0
    for i, b in enumerate(bars):
        b["x"] = round(x, 1)
        b["h"] = round(130 * (b["pct"] or 0) / 100.0) if b["pct"] is not None else 0
        if i % label_every:
            b["label"] = ""
        x += bw + gap
    svg_w = 198
    return {
        "bars": bars, "bw": round(bw, 1), "width": int(vw), "x0": int(x0), "unit": unit,
        "svg_w": svg_w, "svg_h": int(round(svg_w * 190.0 / vw)),
    }


def _range_context(
    rows: list[dict],
    *,
    start: date,
    end: date,
    department_label: Optional[str],
    fmt: TenantFormatter,
    tz: ZoneInfo,
    holiday_names: dict[date, str],
    weekend_days: tuple[str, ...],
    report_id: str,
    generated_at_label: str,
    generated_by_email: str,
    with_crops: bool,
) -> dict:
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    working = {d for d in days if d.strftime("%A") not in weekend_days and d not in holiday_names}
    W = len(working)

    by_emp: "OrderedDict[int, list[dict]]" = OrderedDict()
    for r in rows:
        by_emp.setdefault(r["employee_id"], []).append(r)
    total = len(by_emp)
    rows_by_day: dict[date, list[dict]] = {}
    for r in rows:
        rows_by_day.setdefault(r["date"], []).append(r)

    emps: list[dict] = []
    for eid, rs in by_emp.items():
        rs = sorted(rs, key=lambda r: r["date"])
        present = [r for r in rs if r["in_min"] is not None]
        dp, nl = len(present), sum(1 for r in rs if r["status"] == "late")
        ne, na = sum(1 for r in rs if r["status"] == "early"), sum(1 for r in rs if r["status"] == "absent")
        nv = sum(1 for r in rs if r["status"] == "leave")
        shortd = sum(1 for r in present if r["short_hours"])
        hrs = sum(r["total_minutes"] or 0 for r in rs) / 60.0
        ot = sum(r["ot_minutes"] for r in rs)
        ins = [r["in_min"] for r in present]
        outs = [r["out_min"] for r in present if r["out_min"] is not None]
        if W and nv >= W:
            status = "leave"
        elif dp == 0:
            status = "absent"
        elif W and dp >= W and not nl and not ne:
            status = "full"
        elif na:
            status = "absences"
        elif nl or ne:
            status = "flags"
        else:
            status = "full"
        flags: list[tuple[str, str]] = []
        if nl:
            flags.append(("late", f"Late ×{nl}"))
        if ne:
            flags.append(("early", f"Early ×{ne}"))
        if shortd:
            flags.append(("short", f"Short ×{shortd}"))
        if ot:
            flags.append(("ot", f"OT {_hm(ot)}"))
        sources = Counter(r["source"] for r in rs if r["source"])
        first_crop = last_crop = None
        if with_crops:
            first_crop = next((r["in_crop"] for r in rs if r["in_crop"]), None)
            last_crop = next(
                (r["out_crop"] or r["in_crop"] for r in reversed(rs) if (r["out_crop"] or r["in_crop"])),
                None,
            )
        head = rs[0]
        emps.append(
            {
                "employee_id": eid,
                "employee_code": head["employee_code"],
                "full_name": head["full_name"],
                "department_name": head["department_name"],
                "initials": head["initials"],
                "avatar_color": head["avatar_color"],
                "status": status,
                "present": dp, "late": nl, "early": ne, "absent": na, "leave": nv, "short": shortd,
                "hours": round(hrs, 2),
                "ot_minutes": ot,
                "avg_in": fmt.format_time(_time_from_minutes(int(round(sum(ins) / len(ins))))) if ins else "",
                "avg_out": fmt.format_time(_time_from_minutes(int(round(sum(outs) / len(outs))))) if outs else "",
                "flags": flags,
                "source": sources.most_common(1)[0][0] if sources else None,
                "first_crop": first_crop,
                "last_crop": last_crop,
            }
        )

    P = sum(e["present"] for e in emps)
    slots = total * W
    H = sum(e["hours"] for e in emps)
    k = {
        "total": total,
        "working_days": W,
        "present_days": P,
        "slots": slots,
        "present_pct": _pct(P, slots),
        "late": sum(e["late"] for e in emps),
        "late_employees": sum(1 for e in emps if e["late"]),
        "absent": sum(e["absent"] for e in emps),
        "absent_employees": sum(1 for e in emps if e["absent"]),
        "leave": sum(e["leave"] for e in emps),
        "ot_hours": round(sum(e["ot_minutes"] for e in emps) / 60.0, 2),
        "ot_employees": sum(1 for e in emps if e["ot_minutes"]),
        "avg_hours": (H / P) if P else None,
    }

    by_dept: "OrderedDict[str, list[dict]]" = OrderedDict()
    for e in sorted(emps, key=lambda x: (x["department_name"].lower(), x["full_name"].lower())):
        by_dept.setdefault(e["department_name"], []).append(e)
    dept_stats = []
    for name, es in by_dept.items():
        p = sum(e["present"] for e in es)
        sl = len(es) * W
        dept_stats.append(
            {
                "name": name,
                "headcount": len(es),
                "present": p,
                "slots": sl,
                "late": sum(e["late"] for e in es),
                "absent": sum(e["absent"] for e in es),
                "leave": sum(e["leave"] for e in es),
                "avg_hours": (sum(e["hours"] for e in es) / p) if p else None,
                "ot_hours": round(sum(e["ot_minutes"] for e in es) / 60.0, 2),
                "pct": _pct(p, sl),
            }
        )
    dept_stats.sort(key=lambda d: (-d["pct"], -d["headcount"], d["name"]))
    groups = [
        {"name": name, "slots": len(es) * W, "present": sum(e["present"] for e in es), "rows": es}
        for name, es in by_dept.items()
    ]
    exceptions = sorted(
        (r for r in rows if r["exception_status"]),
        key=lambda r: (r["exception_order"], r["date"], r["full_name"].lower()),
    )

    n_hol = sum(1 for d in days if d in holiday_names)
    box = [
        ("Report ID", report_id, "mono"),
        ("Generated", generated_at_label, ""),
        ("By", generated_by_email or "—", ""),
        ("Scope", f"{total} active employee{'s' if total != 1 else ''} · {len(by_dept)} department{'s' if len(by_dept) != 1 else ''}", ""),
        ("Working days", f"{W} · {_weekend_label(weekend_days)} weekend" + (f" · {n_hol} holiday{'s' if n_hol != 1 else ''}" if n_hol else ""), ""),
        ("Timezone", tz.key, ""),
    ]
    return {
        "period_label": f"{_range_label(start, end)} · {W} working day{'s' if W != 1 else ''} · {_scope_label(department_label)}",
        "box": box,
        "k": k,
        "chart": _chart(days, rows_by_day=rows_by_day, total=total, working=working, holiday_names=holiday_names),
        "departments": dept_stats,
        "exceptions": exceptions[:MAX_EXCEPTION_ROWS],
        "exceptions_total": len(exceptions),
        "groups": groups,
        "weekend_label": _weekend_label(weekend_days),
    }


def _employee_range_context(
    conn: Connection,
    scope: TenantScope,
    rows: list[dict],
    emp: dict,
    *,
    start: date,
    end: date,
    fmt: TenantFormatter,
    tz: ZoneInfo,
    holiday_names: dict[date, str],
    weekend_days: tuple[str, ...],
    facts: dict,
    report_id: str,
    generated_at_label: str,
    generated_by_email: str,
) -> dict:
    by_date = {r["date"]: r for r in rows}
    days_all = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    working = [d for d in days_all if d.strftime("%A") not in weekend_days and d not in holiday_names]
    W = len(working)
    lo, hi = _axis_bounds(rows, facts)
    policy_end = _minutes(facts["end"]) if facts.get("end") is not None else None

    day_rows: list[dict] = []
    for d in days_all:
        r = by_date.get(d)
        is_we = d.strftime("%A") in weekend_days
        is_hol = d in holiday_names
        if r is None:
            status = "holiday" if is_hol else ("weekend" if is_we else "pending")
            day_rows.append(
                {
                    "day_label": _short_day(d), "status": status, "in_label": "", "out_label": "",
                    "hours": None, "segments": [], "flags": [],
                    "flags_empty": holiday_names.get(d, "Public holiday") if is_hol else ("—" if is_we else "No record"),
                    "in_crop": None, "out_crop": None,
                }
            )
            continue
        day_rows.append(
            {
                **r,
                "segments": _timeline_segments(r["in_min"], r["out_min"], lo=lo, hi=hi, policy_end=policy_end),
            }
        )

    present = [r for r in rows if r["in_min"] is not None]
    dp = len(present)
    nl = sum(1 for r in rows if r["status"] == "late")
    ne = sum(1 for r in rows if r["status"] == "early")
    na = sum(1 for r in rows if r["status"] == "absent")
    nv = sum(1 for r in rows if r["status"] == "leave")
    hrs = sum(r["total_minutes"] or 0 for r in rows) / 60.0
    ot = sum(r["ot_minutes"] for r in rows)
    late_vals = [r["late_minutes"] for r in rows if r["status"] == "late"]
    late_minutes = sum(v for v in late_vals if v) if (late_vals and all(late_vals)) else (0 if not late_vals else None)

    reqs = _requests_in_period(conn, scope, employee_id=emp["employee_id"], start=start, end=end)
    absent_dates = {r["date"] for r in rows if r["status"] == "absent"}
    pending_exc = any(
        q["status_raw"] in ("submitted", "manager_approved") and q["date"] in absent_dates for q in reqs
    )
    k = {
        "working_days": W,
        "calendar_days": len(days_all),
        "weekend_days": sum(1 for d in days_all if d.strftime("%A") in weekend_days),
        "holiday_days": sum(1 for d in days_all if d in holiday_names and d.strftime("%A") not in weekend_days),
        "present": dp,
        "present_pct": _pct(dp, W),
        "late": nl,
        "late_minutes": late_minutes,
        "absent": na,
        "absent_hint": "exception pending" if pending_exc else ("no detection, not on leave" if na else "—"),
        "leave": nv,
        "early": ne,
        "hours": round(hrs, 2),
        "hours_per_day": (hrs / dp) if dp else 0.0,
        "ot_hours": round(ot / 60.0, 2),
    }

    name = emp["full_name"]
    insights = [
        f"{name} was present on {dp} of {W} working day{'s' if W != 1 else ''} ({_pct(dp, W)}%).",
        f"{nl} late arrival{'s' if nl != 1 else ''}" + (f" totalling {late_minutes} minutes." if nl and late_minutes else "."),
        f"{na} day{'s' if na != 1 else ''} with no detection and no approved leave." + (" An exception request is with the line manager." if pending_exc else ""),
        f"{hrs:.1f} hours worked, {k['hours_per_day']:.1f} h per attended day against {facts['required_hours']}.0 h required.",
        f"{ot / 60.0:.1f} h overtime recorded." if ot else "No overtime recorded.",
    ]
    if nv:
        insights.insert(3, f"{nv} day{'s' if nv != 1 else ''} on approved leave.")

    n_hol = sum(1 for d in days_all if d in holiday_names)
    box = [
        ("Report ID", report_id, "mono"),
        ("Generated", generated_at_label, ""),
        ("By", generated_by_email or "—", ""),
        ("Policy", facts["shift_label"], ""),
        ("Working days", f"{W} · {_weekend_label(weekend_days)} weekend" + (f" · {n_hol} holiday{'s' if n_hol != 1 else ''}" if n_hol else ""), ""),
        ("Timezone", tz.key, ""),
    ]
    return {
        "period_label": f"{_range_label(start, end)} · {W} working day{'s' if W != 1 else ''} · {name}",
        "box": box,
        "emp": emp,
        "policy": facts,
        "weekend_label": _weekend_label(weekend_days).replace("/", " · "),
        "k": k,
        "requests": reqs,
        "days": day_rows,
        "axis": _axis_labels(lo, hi, fmt),
        "insights": insights,
    }


def _employee_daily_context(
    conn: Connection,
    scope: TenantScope,
    rows: list[dict],
    emp: dict,
    *,
    the_date: date,
    fmt: TenantFormatter,
    tz: ZoneInfo,
    holiday_names: dict[date, str],
    weekend_days: tuple[str, ...],
    facts: dict,
    report_id: str,
    generated_at_label: str,
    generated_by_email: str,
    with_crops: bool,
) -> dict:
    r = rows[0] if rows else None
    is_we = the_date.strftime("%A") in weekend_days
    is_hol = the_date in holiday_names

    raw = _sightings_for_day(conn, scope, employee_id=emp["employee_id"], on_date=the_date, tz=tz)
    sight_rows: list[dict] = []
    for i, s in enumerate(raw):
        local = s.captured_at.astimezone(tz) if s.captured_at.tzinfo else s.captured_at.replace(tzinfo=timezone.utc).astimezone(tz)
        is_terminal = s.camera_name is None and s.device_id is not None
        cam = (
            f"{s.camera_name}" + (f" · {s.camera_location}" if s.camera_location else "")
            if s.camera_name
            else ("Attendance terminal" if is_terminal else "—")
        )
        sight_rows.append(
            {
                "minute": local.hour * 60 + local.minute,
                "time_label": fmt.format_time(local.time()),
                "camera": cam,
                "confidence": float(s.confidence) if s.confidence is not None else None,
                "method": "Terminal · device" if is_terminal else "Face · camera",
                "crop_path": s.face_crop_path,
                "crop": None,
                "kind": "Sighting",
                "pill_cls": "lv",
            }
        )
    if sight_rows:
        sight_rows[0]["kind"], sight_rows[0]["pill_cls"] = "First sighting · IN", "ok"
        sight_rows[-1]["kind"], sight_rows[-1]["pill_cls"] = "Last sighting · OUT", "ok"

    # Gaps between consecutive sightings (minutes, in local time).
    gaps: list[tuple[int, int]] = []
    for a, b in zip(sight_rows, sight_rows[1:]):
        if b["minute"] - a["minute"] > GAP_THRESHOLD_MINUTES:
            gaps.append((a["minute"], b["minute"]))
    away = sum(b - a for a, b in gaps)

    # Collapse very long days so the table stays readable.
    listed: list[dict] = sight_rows
    if len(sight_rows) > MAX_SIGHTING_ROWS:
        half = MAX_SIGHTING_ROWS // 2
        hidden = sight_rows[half:-half]
        listed = sight_rows[:half] + [
            {"gap_rows": len(hidden), "gap_from": hidden[0]["time_label"], "gap_to": hidden[-1]["time_label"]}
        ] + sight_rows[-half:]
    if with_crops:
        for s in listed:
            if "gap_rows" not in s:
                s["crop"] = _crop_to_data_url(s["crop_path"])

    if r is not None:
        status = r["status"]
        in_m, out_m = r["in_min"], r["out_min"]
        in_label, out_label, hours = r["in_label"], r["out_label"], r["hours"]
        late_minutes = r["late_minutes"] if r["late"] else 0
        ot_minutes = r["ot_minutes"]
        flags, flags_empty = r["flags"], (r["flags_empty"] if r["status"] in ("absent", "leave", "holiday") else "")
    else:
        status = "holiday" if is_hol else ("weekend" if is_we else "pending")
        in_m = out_m = None
        in_label = out_label = ""
        hours = None
        late_minutes = None
        ot_minutes = 0
        flags, flags_empty = [], (holiday_names.get(the_date, "Public holiday") if is_hol else ("Weekend" if is_we else "No attendance record for this date"))

    lo, hi = _axis_bounds([{"in_min": in_m, "out_min": out_m}] if in_m is not None else [], facts)
    policy_end = _minutes(facts["end"]) if facts.get("end") is not None else None
    span = (out_m - in_m) if (in_m is not None and out_m is not None) else 0
    if span < 0:
        span += 24 * 60
    kpi_cls = {"present": "ok", "late": "warn", "early": "warn", "absent": "bad", "leave": "info"}.get(status, "")

    cams_used = {s["camera"] for s in sight_rows}
    confs = [s["confidence"] for s in sight_rows if s["confidence"] is not None]
    name = emp["full_name"]
    status_word = {"present": "present", "late": "late", "early": "left early", "absent": "absent", "leave": "on leave"}.get(status, status)
    insights = []
    if in_label:
        insights.append(f"{name} was {status_word} on {the_date:%A}: first seen {in_label}, last seen {out_label or '—'}.")
        insights.append(
            f"{hours or 0:.1f} h recorded against {facts['required_hours']}.0 h required; "
            f"{max(0, span - away) / 60.0:.1f} h on site, {away} min away across {len(gaps)} gap{'s' if len(gaps) != 1 else ''}."
        )
    else:
        insights.append(f"{name} was {status_word} on {the_date:%A}; no recognised sighting was recorded.")
    if sight_rows:
        insights.append(
            f"{len(sight_rows)} recognised sighting{'s' if len(sight_rows) != 1 else ''} across "
            f"{len(cams_used)} camera{'s' if len(cams_used) != 1 else ''}"
            + (f", average confidence {sum(confs) / len(confs):.2f}." if confs else ".")
        )
    if r is not None and r["late"]:
        insights.append(f"Late by {late_minutes} minutes against the grace." if late_minutes else "Arrived after the policy grace.")
    elif in_label:
        insights.append("Arrived within the policy grace.")
    insights.append(f"Overtime of {ot_minutes} minutes recorded." if ot_minutes else "No overtime recorded.")

    day_kind = "working day" if not (is_we or is_hol) else ("holiday" if is_hol else "weekend")
    box = [
        ("Report ID", report_id, "mono"),
        ("Generated", generated_at_label, ""),
        ("By", generated_by_email or "—", ""),
        ("Policy", facts["shift_label"], ""),
        ("Date", f"{_medium_date(the_date)} · {day_kind}", ""),
        ("Timezone", tz.key, ""),
    ]
    return {
        "period_label": f"{_long_date(the_date)} · {name}",
        "box": box,
        "emp": emp,
        "policy": facts,
        "weekend_label": _weekend_label(weekend_days).replace("/", " · "),
        "day": {
            "status": status,
            "kpi_cls": kpi_cls,
            "date_label": _medium_date(the_date),
            "in_label": in_label,
            "out_label": out_label,
            "hours": hours,
            "late_minutes": late_minutes,
            "ot_minutes": ot_minutes,
            "onsite_hours": max(0, span - away) / 60.0,
            "away_minutes": away,
            "gaps": [
                {"from_label": fmt.format_time(_time_from_minutes(a)), "to_label": fmt.format_time(_time_from_minutes(b)), "minutes": b - a}
                for a, b in gaps
            ],
            "segments": _timeline_segments(in_m, out_m, lo=lo, hi=hi, policy_end=policy_end, gaps=gaps),
            "flags": flags,
            "flags_empty": flags_empty,
        },
        "axis": _axis_labels(lo, hi, fmt),
        "sightings": listed,
        "sightings_total": len(sight_rows),
        "gap_threshold": GAP_THRESHOLD_MINUTES,
        "insights": insights,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _render(template_name: str, ctx: dict) -> bytes:
    """Jinja → HTML → WeasyPrint. The stylesheet is attached as a CSS
    object with its own base URL so ``../fonts/*.ttf`` resolve from
    disk; one FontConfiguration is shared so @font-face applies."""

    html_str = _jinja_env.get_template(template_name).render(**ctx)

    # Lazy import — keeps the Excel path free of the cffi/system-lib
    # cost and lets tests that never render PDFs skip it.
    from weasyprint import CSS, HTML  # noqa: PLC0415
    from weasyprint.text.fonts import FontConfiguration  # noqa: PLC0415

    font_config = FontConfiguration()
    css = CSS(filename=str(_REPORT_CSS), font_config=font_config)
    pdf_bytes = HTML(string=html_str, base_url=str(_TEMPLATE_DIR)).write_pdf(
        stylesheets=[css], font_config=font_config
    )
    if pdf_bytes is None:  # pragma: no cover — defensive
        raise RuntimeError("WeasyPrint returned no PDF bytes")
    return pdf_bytes


def build_pdf(
    conn: Connection,
    scope: TenantScope,
    *,
    start_date: date,
    end_date: date,
    department_ids: Optional[list[int]] = None,
    employee_id: Optional[int] = None,
    generated_by_email: str = "",
    department_label: Optional[str] = None,
    include_employee_photos: bool = True,
) -> tuple[bytes, int]:
    """Render the Template 1 PDF and return ``(bytes, row_count)``.

    Side effects: SELECTs only. WeasyPrint never opens a network
    socket — fonts, logos and face crops are local files / data URLs.
    """

    fmt = load_tenant_formatter(conn, scope.tenant_id)
    tsettings = load_tenant_settings(conn, scope)
    tz = _tz(tsettings.timezone)
    weekend_days = tuple(tsettings.weekend_days)
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc.astimezone(tz)

    raw_rows = _query_rows(
        conn, scope, start_date=start_date, end_date=end_date,
        department_ids=department_ids, employee_id=employee_id,
    )
    holiday_names = _holidays_between(conn, scope, start_date, end_date)
    pcache = _policy_cache(fmt)

    sight: dict[tuple[int, date], Any] = {}
    if raw_rows:
        sight = _sightings_summary(
            conn, scope, start_date=start_date, end_date=end_date, tz=tz, employee_id=employee_id,
        )
    rows = [
        _fix_out_crop(
            _mk_row(
                r, fmt=fmt, pcache=pcache, holiday_names=holiday_names, weekend_days=weekend_days,
                sight=sight.get((int(r.employee_id), r.date)), with_crops=include_employee_photos,
            )
        )
        for r in raw_rows
    ]

    tenant_ctx = _tenant_summary(conn, tenant_id=scope.tenant_id)
    branding_ctx = _branding_for_tenant(conn, tenant_id=scope.tenant_id)
    generated_at_label = fmt.format_datetime(now_utc)
    single_day = start_date == end_date

    # Employee layouts only for a real, in-scope employee of this tenant.
    emp: Optional[dict] = None
    if employee_id is not None:
        emp = _employee_profile(conn, scope, employee_id)
        if emp is not None and department_ids is not None and emp["department_id"] not in department_ids:
            emp = None

    def _common(title: str, running_head: str, body_class: str) -> dict:
        return _common_context(
            tenant=tenant_ctx, branding=branding_ctx, fmt=fmt, tz=tz, now_utc=now_utc,
            generated_by_email=generated_by_email, show_photos=include_employee_photos,
            title=title, running_head=running_head, body_class=body_class,
        )

    if emp is not None:
        # Policy facts: the employee's most recent row, else the
        # tenant's first active policy, else generic.
        if raw_rows:
            facts = _facts_for(pcache, raw_rows[-1], fmt)
        else:
            prow = conn.execute(
                select(shift_policies.c.name, shift_policies.c.type, shift_policies.c.config)
                .where(shift_policies.c.tenant_id == scope.tenant_id)
                .order_by(shift_policies.c.id.asc())
                .limit(1)
            ).first()
            facts = _policy_facts(prow.type if prow else None, prow.config if prow else None, prow.name if prow else None, fmt)
        date_part = f"{start_date:%Y%m%d}" if single_day else f"{start_date:%Y%m%d}-{end_date:%Y%m%d}"
        report_id = f"EMP-{emp['employee_code']}-{date_part}"
        if single_day:
            title = f"{tenant_ctx['name']} — Employee Daily Attendance — {emp['full_name']}"
            ctx = _common(title, f"Employee Daily Attendance · {emp['full_name']} · {_medium_date(start_date)}", "compact")
            ctx.update(
                _employee_daily_context(
                    conn, scope, rows, emp, the_date=start_date, fmt=fmt, tz=tz,
                    holiday_names=holiday_names, weekend_days=weekend_days, facts=facts,
                    report_id=report_id, generated_at_label=generated_at_label,
                    generated_by_email=generated_by_email, with_crops=include_employee_photos,
                )
            )
            return _render("employee_daily.html", ctx), len(raw_rows)
        title = f"{tenant_ctx['name']} — Employee Attendance Report — {emp['full_name']}"
        ctx = _common(title, f"Employee Attendance Report · {emp['full_name']} · {_range_label(start_date, end_date)}", "compact")
        ctx.update(
            _employee_range_context(
                conn, scope, rows, emp, start=start_date, end=end_date, fmt=fmt, tz=tz,
                holiday_names=holiday_names, weekend_days=weekend_days, facts=facts,
                report_id=report_id, generated_at_label=generated_at_label,
                generated_by_email=generated_by_email,
            )
        )
        return _render("employee_range.html", ctx), len(raw_rows)

    stamp = f"{now_local:%H%M}"
    if single_day:
        report_id = f"ATT-{start_date:%Y%m%d}-{stamp}"
        title = f"{tenant_ctx['name']} — Daily Attendance Report — {_medium_date(start_date)}"
        ctx = _common(title, f"Daily Attendance Report · {_medium_date(start_date)}", "")
        ctx.update(
            _daily_context(
                conn, scope, rows, the_date=start_date, department_ids=department_ids,
                department_label=department_label, fmt=fmt, tz=tz, holiday_names=holiday_names,
                weekend_days=weekend_days, pcache=pcache, report_id=report_id,
                generated_at_label=generated_at_label, generated_by_email=generated_by_email,
            )
        )
        return _render("attendance_daily.html", ctx), len(raw_rows)

    report_id = f"ATT-{start_date:%Y%m%d}-{end_date:%Y%m%d}-{stamp}"
    title = f"{tenant_ctx['name']} — Attendance Report — {_range_label(start_date, end_date)}"
    ctx = _common(title, f"Attendance Report · {_range_label(start_date, end_date)}", "")
    ctx.update(
        _range_context(
            rows, start=start_date, end=end_date, department_label=department_label, fmt=fmt, tz=tz,
            holiday_names=holiday_names, weekend_days=weekend_days, report_id=report_id,
            generated_at_label=generated_at_label, generated_by_email=generated_by_email,
            with_crops=include_employee_photos,
        )
    )
    return _render("attendance_range.html", ctx), len(raw_rows)
