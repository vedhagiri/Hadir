"""POST /api/reports/attendance.xlsx — Admin / HR / Manager.

Manager scope is enforced server-side (P3 + P10 pattern): a Manager's
``department_id`` filter is intersected with their assigned set, and a
filter outside that set returns 403. Employee role gets 403 outright
on the report endpoint — pilot does not expose self-export here (the
self-view in P12 is sufficient).
"""

from __future__ import annotations

import logging
from datetime import date as date_type, timedelta
from io import BytesIO
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, current_user
from hadir.db import departments, get_engine, tenants
from hadir.reporting.attendance import build_xlsx
from hadir.reporting.pdf import build_pdf, filename_for
from hadir.tenants.scope import TenantScope
from sqlalchemy import select as sa_select

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reports", tags=["reports"])


class AttendanceReportRequest(BaseModel):
    """POST body for the attendance report.

    Both dates are inclusive; the server clamps the maximum span to
    something sensible (90 days) so an accidental range can't load the
    entire history into one workbook.
    """

    start: date_type
    end: date_type
    department_id: Optional[int] = None
    employee_id: Optional[int] = None
    # Pilot-only knob — keeps a curious operator from generating a
    # year of data accidentally. v1.0 reports run as background jobs.
    max_days: int = Field(default=90, ge=1, le=366)


@router.post("/attendance.xlsx")
def generate_attendance_xlsx(
    payload: AttendanceReportRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> StreamingResponse:
    """Build + stream an XLSX of attendance for the requested filters."""

    if "Employee" in user.roles and not (
        "Admin" in user.roles or "HR" in user.roles or "Manager" in user.roles
    ):
        raise HTTPException(
            status_code=403, detail="reports require Admin, HR, or Manager"
        )
    if not (
        "Admin" in user.roles or "HR" in user.roles or "Manager" in user.roles
    ):
        raise HTTPException(
            status_code=403, detail="reports require Admin, HR, or Manager"
        )

    if payload.start > payload.end:
        raise HTTPException(
            status_code=400, detail="start must be on or before end"
        )
    if (payload.end - payload.start).days + 1 > payload.max_days:
        raise HTTPException(
            status_code=400,
            detail=f"date range exceeds max_days={payload.max_days}",
        )

    scope = TenantScope(tenant_id=user.tenant_id)

    # Manager scope: intersect with assigned departments. If they pass
    # a department_id outside the set we return 403 — never silently
    # widen or narrow a result set the caller didn't ask for.
    department_ids: Optional[list[int]] = None
    is_admin_like = "Admin" in user.roles or "HR" in user.roles
    if is_admin_like:
        if payload.department_id is not None:
            department_ids = [payload.department_id]
    else:  # Manager-only
        allowed = set(user.departments)
        if not allowed:
            return _empty_response()
        if payload.department_id is not None:
            if payload.department_id not in allowed:
                raise HTTPException(
                    status_code=403, detail="not a member of this department"
                )
            department_ids = [payload.department_id]
        else:
            department_ids = sorted(allowed)

    engine = get_engine()
    with engine.begin() as conn:
        data, rows = build_xlsx(
            conn,
            scope,
            start_date=payload.start,
            end_date=payload.end,
            department_ids=department_ids,
            employee_id=payload.employee_id,
        )

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="report.generated",
            entity_type="report",
            entity_id=None,
            after={
                "start": payload.start.isoformat(),
                "end": payload.end.isoformat(),
                "department_id": payload.department_id,
                "employee_id": payload.employee_id,
                "rows": rows,
            },
        )
    logger.info(
        "report generated: actor=%s start=%s end=%s rows=%d",
        user.id,
        payload.start,
        payload.end,
        rows,
    )

    filename = f"attendance_{payload.start.isoformat()}_to_{payload.end.isoformat()}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        },
    )


@router.post("/attendance.pdf")
def generate_attendance_pdf(
    payload: AttendanceReportRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> StreamingResponse:
    """PDF cousin of the XLSX endpoint. Same role + scope gates,
    same body shape, branded letterhead per tenant.
    """

    # Role gates — copy of the XLSX endpoint's checks.
    if not (
        "Admin" in user.roles or "HR" in user.roles or "Manager" in user.roles
    ):
        raise HTTPException(
            status_code=403, detail="reports require Admin, HR, or Manager"
        )
    if payload.start > payload.end:
        raise HTTPException(
            status_code=400, detail="start must be on or before end"
        )
    if (payload.end - payload.start).days + 1 > payload.max_days:
        raise HTTPException(
            status_code=400,
            detail=f"date range exceeds max_days={payload.max_days}",
        )

    scope = TenantScope(tenant_id=user.tenant_id)

    department_ids: Optional[list[int]] = None
    is_admin_like = "Admin" in user.roles or "HR" in user.roles
    if is_admin_like:
        if payload.department_id is not None:
            department_ids = [payload.department_id]
    else:  # Manager-only
        allowed = set(user.departments)
        if not allowed:
            return _empty_pdf_response(scope, payload)
        if payload.department_id is not None:
            if payload.department_id not in allowed:
                raise HTTPException(
                    status_code=403, detail="not a member of this department"
                )
            department_ids = [payload.department_id]
        else:
            department_ids = sorted(allowed)

    engine = get_engine()
    with engine.begin() as conn:
        # Surface a friendly department label in the letterhead when
        # one is filtered.
        department_label: Optional[str] = None
        if department_ids and len(department_ids) == 1:
            row = conn.execute(
                sa_select(departments.c.code, departments.c.name).where(
                    departments.c.tenant_id == scope.tenant_id,
                    departments.c.id == department_ids[0],
                )
            ).first()
            if row is not None:
                department_label = f"{row.code} · {row.name}"

        data, rows = build_pdf(
            conn,
            scope,
            start_date=payload.start,
            end_date=payload.end,
            department_ids=department_ids,
            employee_id=payload.employee_id,
            generated_by_email=user.email,
            department_label=department_label,
        )

        # Schema name fuels the spec'd filename. Fall back to the
        # tenant id if the row's missing (shouldn't happen — guarded
        # by current_user already).
        slug_row = conn.execute(
            sa_select(tenants.c.schema_name).where(
                tenants.c.id == scope.tenant_id
            )
        ).first()
        slug = (
            str(slug_row.schema_name)
            if slug_row is not None
            else f"tenant-{scope.tenant_id}"
        )

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="report.generated",
            entity_type="report",
            entity_id=None,
            after={
                "format": "pdf",
                "start": payload.start.isoformat(),
                "end": payload.end.isoformat(),
                "department_id": payload.department_id,
                "employee_id": payload.employee_id,
                "rows": rows,
            },
        )
    logger.info(
        "pdf report generated: actor=%s start=%s end=%s rows=%d",
        user.id,
        payload.start,
        payload.end,
        rows,
    )

    filename = filename_for(
        schema_name=slug, start=payload.start, end=payload.end
    )
    return StreamingResponse(
        BytesIO(data),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        },
    )


def _empty_pdf_response(
    scope: TenantScope, payload: AttendanceReportRequest
) -> StreamingResponse:
    """Manager-only with no assigned departments returns an empty
    branded PDF (no employee sections) rather than a 4xx — same UX
    contract the XLSX endpoint follows for the same case."""

    engine = get_engine()
    with engine.begin() as conn:
        data, _ = build_pdf(
            conn,
            scope,
            start_date=payload.start,
            end_date=payload.end,
            department_ids=[],
            employee_id=payload.employee_id,
            generated_by_email="",
        )
        slug_row = conn.execute(
            sa_select(tenants.c.schema_name).where(
                tenants.c.id == scope.tenant_id
            )
        ).first()
        slug = (
            str(slug_row.schema_name)
            if slug_row is not None
            else f"tenant-{scope.tenant_id}"
        )
    filename = filename_for(
        schema_name=slug, start=payload.start, end=payload.end
    )
    return StreamingResponse(
        BytesIO(data),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        },
    )


def _empty_response() -> StreamingResponse:
    """Return a minimal empty XLSX (header-only) for the no-data case."""

    from openpyxl import Workbook  # noqa: PLC0415

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Attendance"
    ws.append(
        [
            "employee_code",
            "name",
            "date",
            "in_time",
            "out_time",
            "total_hours",
            "late",
            "early_out",
            "short",
            "overtime_minutes",
            "policy",
        ]
    )
    buf = BytesIO()
    wb.save(buf)
    return StreamingResponse(
        BytesIO(buf.getvalue()),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": 'attachment; filename="attendance_empty.xlsx"'
        },
    )


def yesterday_today_range(today: date_type) -> tuple[date_type, date_type]:
    """Helper used by the smoke test default range. Not part of the API."""

    return today - timedelta(days=1), today
