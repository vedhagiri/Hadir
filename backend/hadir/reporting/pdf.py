"""Attendance PDF report builder (v1.0 P17).

WeasyPrint renders ``templates/attendance.html`` with a Jinja context
populated from the same query the Excel builder uses (so the two
exports never disagree). Branding (accent colour + font + logo) comes
from ``tenant_branding``; the logo is embedded as a ``data:`` URL so
the renderer doesn't need network access at print time.

The Excel builder partitions by ISO week; the PDF partitions by
employee — one section per person with daily rows + totals, page-
break between employees on multi-employee reports. That matches the
operator workflow: HR hands a single block to a single person rather
than scrolling through a mixed sheet.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Iterator, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import and_, select
from sqlalchemy.engine import Connection

from hadir.branding.constants import (
    DEFAULT_FONT_KEY,
    DEFAULT_PRIMARY_COLOR_KEY,
    FONT_OPTIONS,
)
from hadir.branding.repository import get_branding
from hadir.db import (
    attendance_records,
    departments,
    employees,
    shift_policies,
    tenants,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


# -- Hex fallback per palette key ------------------------------------------
# WeasyPrint 62 understands ``oklch()`` natively, but the smoke + tests
# want a stable colour string they can grep for in the rendered output
# (and one that round-trips through every reader). Keeping a deliberate
# hex-per-key map here means the PDF reflects branding without depending
# on the renderer's OKLCH support.
HEX_PALETTE: dict[str, dict[str, str]] = {
    "teal":   {"accent": "#117a7a", "soft": "#e6f5f5"},
    "navy":   {"accent": "#1e3a8a", "soft": "#e6ecf5"},
    "slate":  {"accent": "#475569", "soft": "#eef1f5"},
    "forest": {"accent": "#1f7a3a", "soft": "#e6f5ec"},
    "plum":   {"accent": "#7a1f7a", "soft": "#f5e6f5"},
    "clay":   {"accent": "#a3522e", "soft": "#f5ebe6"},
    "rose":   {"accent": "#a31752", "soft": "#f5e6ec"},
    "amber":  {"accent": "#b07a00", "soft": "#f5efdc"},
}


_TEMPLATE_DIR = Path(__file__).parent / "templates"

_jinja_env = Environment(
    loader=FileSystemLoader(_TEMPLATE_DIR),
    autoescape=select_autoescape(("html", "xml")),
    trim_blocks=True,
    lstrip_blocks=True,
)


def _format_time(t: Optional[time]) -> str:
    return t.strftime("%H:%M:%S") if t is not None else ""


def _logo_data_url(logo_path: Optional[str]) -> Optional[str]:
    """Encode the tenant's logo as a ``data:`` URL.

    Missing files return ``None`` — the template falls back to the
    tenant initial in an accent-soft tile.
    """

    if not logo_path:
        return None
    try:
        p = Path(logo_path)
        if not p.is_file():
            return None
        raw = p.read_bytes()
    except OSError as exc:  # pragma: no cover — disk-shape edge case
        logger.warning("could not read tenant logo %s: %s", logo_path, exc)
        return None
    mime, _ = mimetypes.guess_type(str(logo_path))
    if mime is None:
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _query_rows(
    conn: Connection,
    scope: TenantScope,
    *,
    start_date: date,
    end_date: date,
    department_ids: Optional[list[int]],
    employee_id: Optional[int],
) -> list:
    stmt = (
        select(
            employees.c.id.label("employee_id"),
            employees.c.employee_code,
            employees.c.full_name,
            departments.c.code.label("department_code"),
            attendance_records.c.date,
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.late,
            attendance_records.c.early_out,
            attendance_records.c.short_hours,
            attendance_records.c.absent,
            attendance_records.c.overtime_minutes,
            shift_policies.c.name.label("policy_name"),
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
            )
            .join(
                shift_policies,
                and_(
                    shift_policies.c.id == attendance_records.c.policy_id,
                    shift_policies.c.tenant_id
                    == attendance_records.c.tenant_id,
                ),
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


def _build_employees(rows: list) -> list[dict]:
    """Group flat rows by employee + compute per-employee totals."""

    by_employee: dict[int, dict] = {}
    for r in rows:
        emp = by_employee.get(int(r.employee_id))
        if emp is None:
            emp = {
                "employee_id": int(r.employee_id),
                "employee_code": str(r.employee_code),
                "full_name": str(r.full_name),
                "department_code": str(r.department_code),
                "days": [],
                "totals": {
                    "days": 0,
                    "late": 0,
                    "early_out": 0,
                    "short_hours": 0,
                    "absent": 0,
                    "overtime_minutes": 0,
                },
            }
            by_employee[int(r.employee_id)] = emp

        total_hours = (
            round(r.total_minutes / 60.0, 2)
            if r.total_minutes is not None
            else None
        )
        emp["days"].append(
            {
                "date": r.date.isoformat(),
                "in_time": _format_time(r.in_time),
                "out_time": _format_time(r.out_time),
                "total_hours": total_hours,
                "late": bool(r.late),
                "early_out": bool(r.early_out),
                "short_hours": bool(r.short_hours),
                "absent": bool(r.absent),
                "overtime_minutes": int(r.overtime_minutes),
                "policy_name": str(r.policy_name),
            }
        )
        t = emp["totals"]
        t["days"] += 1
        if r.late:
            t["late"] += 1
        if r.early_out:
            t["early_out"] += 1
        if r.short_hours:
            t["short_hours"] += 1
        if r.absent:
            t["absent"] += 1
        t["overtime_minutes"] += int(r.overtime_minutes)

    out = list(by_employee.values())
    for emp in out:
        emp["totals"]["overtime_hours"] = round(
            emp["totals"]["overtime_minutes"] / 60.0, 2
        )
    return out


def _summary(rows: list, employees_grouped: list[dict], *, day_count: int) -> dict:
    return {
        "employee_count": len(employees_grouped),
        "total_days": len(rows),
        "late_count": sum(1 for r in rows if r.late),
        "overtime_hours": round(
            sum(int(r.overtime_minutes) for r in rows) / 60.0, 2
        ),
        "day_count": day_count,
    }


def _branding_for_tenant(conn: Connection, *, tenant_id: int) -> dict:
    """Return a context-ready dict — accent hex, soft hex, font CSS,
    and an optional ``data:`` URL for the logo."""

    branding = get_branding(conn, tenant_id=tenant_id)
    palette = HEX_PALETTE.get(
        branding.primary_color_key,
        HEX_PALETTE[DEFAULT_PRIMARY_COLOR_KEY],
    )
    font_family = FONT_OPTIONS.get(
        branding.font_key, FONT_OPTIONS[DEFAULT_FONT_KEY]
    )
    return {
        "primary_color_key": branding.primary_color_key,
        "font_key": branding.font_key,
        "accent_hex": palette["accent"],
        "accent_soft_hex": palette["soft"],
        "font_family": font_family,
        "logo_data_url": _logo_data_url(branding.logo_path),
    }


def _tenant_summary(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(
            tenants.c.id, tenants.c.name, tenants.c.schema_name
        ).where(tenants.c.id == tenant_id)
    ).first()
    assert row is not None, f"tenant id {tenant_id} not found"
    return {
        "id": int(row.id),
        "name": str(row.name),
        "schema_name": str(row.schema_name),
    }


def filename_for(
    *, schema_name: str, start: date, end: date
) -> str:
    """Build the spec'd filename:
    ``hadir-attendance-{tenant_slug}-{from}-to-{to}.pdf``.
    """

    return (
        f"hadir-attendance-{schema_name}-{start.isoformat()}"
        f"-to-{end.isoformat()}.pdf"
    )


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
) -> tuple[bytes, int]:
    """Render the PDF and return ``(bytes, row_count)``.

    Pure side effects: a SELECT against attendance + branding + tenant.
    The HTML render runs entirely in process; WeasyPrint never opens
    a network socket because the logo is data-URL'd inline.
    """

    rows = _query_rows(
        conn,
        scope,
        start_date=start_date,
        end_date=end_date,
        department_ids=department_ids,
        employee_id=employee_id,
    )
    employees_grouped = _build_employees(rows)

    day_count = (end_date - start_date).days + 1
    summary = _summary(rows, employees_grouped, day_count=day_count)

    branding_ctx = _branding_for_tenant(conn, tenant_id=scope.tenant_id)
    tenant_ctx = _tenant_summary(conn, tenant_id=scope.tenant_id)

    template = _jinja_env.get_template("attendance.html")
    html_str = template.render(
        tenant=tenant_ctx,
        branding=branding_ctx,
        summary=summary,
        employees=employees_grouped,
        start_label=start_date.isoformat(),
        end_label=end_date.isoformat(),
        generated_at_label=datetime.now(timezone.utc).strftime(
            "%Y-%m-%d %H:%M UTC"
        ),
        generated_by_email=generated_by_email or "—",
        filters={"department_label": department_label},
    )

    # Lazy-import WeasyPrint so a test that doesn't render PDFs (e.g.
    # the existing Excel suite) never pays the import cost or risks
    # missing system libs in a sandbox.
    from weasyprint import HTML  # noqa: PLC0415

    pdf_bytes = HTML(string=html_str).write_pdf()
    if pdf_bytes is None:  # pragma: no cover — defensive
        raise RuntimeError("WeasyPrint returned no PDF bytes")
    return pdf_bytes, len(rows)
