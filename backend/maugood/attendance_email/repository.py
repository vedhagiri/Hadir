"""Tenant-scoped DB layer for attendance status emails.

Every function takes an explicit ``TenantScope`` and filters on
``tenant_id`` — the standard Maugood plumbing pattern. The
``attendance_email_log`` row doubles as queue entry and durable
delivery record; the unique constraint on
``(tenant_id, employee_id, date, status)`` makes ``enqueue``
idempotent across recompute ticks.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from typing import Optional

from sqlalchemy import func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from maugood.db import (
    attendance_email_log,
    attendance_records,
    departments,
    employees,
    tenant_settings,
)
from maugood.tenants.scope import TenantScope

CONFIG_DEFAULTS = {"present": False, "late": False, "absent": False}

MAX_ATTEMPTS = 3

STATUSES = ("present", "late", "absent")


def load_config(conn: Connection, scope: TenantScope) -> dict:
    """Read the tenant's toggle bag, merged over all-false defaults."""

    row = conn.execute(
        select(tenant_settings.c.attendance_email_config).where(
            tenant_settings.c.tenant_id == scope.tenant_id
        )
    ).first()
    out = dict(CONFIG_DEFAULTS)
    if row is not None and isinstance(row.attendance_email_config, dict):
        for key in STATUSES:
            if key in row.attendance_email_config:
                out[key] = bool(row.attendance_email_config[key])
    return out


def save_config(conn: Connection, scope: TenantScope, config: dict) -> None:
    existing = conn.execute(
        select(tenant_settings.c.tenant_id).where(
            tenant_settings.c.tenant_id == scope.tenant_id
        )
    ).first()
    if existing is None:
        conn.execute(
            insert(tenant_settings).values(
                tenant_id=scope.tenant_id,
                attendance_email_config=config,
            )
        )
        return
    conn.execute(
        update(tenant_settings)
        .where(tenant_settings.c.tenant_id == scope.tenant_id)
        .values(attendance_email_config=config)
    )


def enqueue(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
    status: str,
    recipient_kind: str = "employee",
) -> bool:
    """Insert one queue row; no-op when it already exists.

    Returns True when a new row was created.
    """

    if status not in STATUSES:
        raise ValueError(f"invalid attendance email status: {status}")
    if recipient_kind not in ("employee", "manager"):
        raise ValueError(f"invalid recipient kind: {recipient_kind}")
    # RETURNING yields a row only when the INSERT actually happened —
    # rowcount is unreliable for ON CONFLICT DO NOTHING under psycopg3.
    result = conn.execute(
        pg_insert(attendance_email_log)
        .values(
            tenant_id=scope.tenant_id,
            employee_id=employee_id,
            date=the_date,
            status=status,
            recipient_kind=recipient_kind,
        )
        .on_conflict_do_nothing(
            constraint="uq_attendance_email_log_emp_date_status_kind"
        )
        .returning(attendance_email_log.c.id)
    )
    return result.first() is not None


def requeue(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
    status: str,
) -> None:
    """Reset an existing log row so the next drain re-sends it.

    Manual-resend only — the automatic producers never call this, so
    the no-duplicates guarantee of the auto pipeline stands. The row
    keeps its id (and therefore its place in the delivery log); the
    previous send timestamps are cleared and attempts restart.
    """

    conn.execute(
        update(attendance_email_log)
        .where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.employee_id == employee_id,
            attendance_email_log.c.date == the_date,
            attendance_email_log.c.status == status,
        )
        .values(
            sent_at=None,
            failed_at=None,
            skipped_at=None,
            attempts=0,
            last_error=None,
        )
    )


def enqueue_with_manager(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
    status: str,
) -> bool:
    """Queue the employee row + a manager row when the employee has a
    resolvable reporting manager. Returns True when the employee row
    was newly created (the manager row rides along silently)."""

    created = enqueue(
        conn,
        scope,
        employee_id=employee_id,
        the_date=the_date,
        status=status,
        recipient_kind="employee",
    )
    if resolve_manager(conn, scope, employee_id=employee_id) is not None:
        enqueue(
            conn,
            scope,
            employee_id=employee_id,
            the_date=the_date,
            status=status,
            recipient_kind="manager",
        )
    return created


def resolve_manager(
    conn: Connection, scope: TenantScope, *, employee_id: int
) -> Optional[dict]:
    """The employee's reporting manager, or None.

    Priority: primary ``manager_assignments`` row → any assignment →
    ``employees.reports_to_user_id``. Returns the manager's user
    name + email (must be an active user with an email).
    """

    from maugood.db import manager_assignments, users  # noqa: PLC0415

    row = conn.execute(
        select(users.c.id, users.c.full_name, users.c.email)
        .select_from(
            manager_assignments.join(
                users, users.c.id == manager_assignments.c.manager_user_id
            )
        )
        .where(
            manager_assignments.c.tenant_id == scope.tenant_id,
            manager_assignments.c.employee_id == employee_id,
            users.c.is_active.is_(True),
            users.c.email.is_not(None),
        )
        .order_by(manager_assignments.c.is_primary.desc())
        .limit(1)
    ).first()
    if row is None:
        row = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email)
            .select_from(
                employees.join(
                    users, users.c.id == employees.c.reports_to_user_id
                )
            )
            .where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.id == employee_id,
                users.c.is_active.is_(True),
                users.c.email.is_not(None),
            )
            .limit(1)
        ).first()
    if row is None:
        return None
    return {
        "user_id": int(row.id),
        "name": str(row.full_name),
        "email": str(row.email),
    }


@dataclass(frozen=True, slots=True)
class PendingEmail:
    id: int
    employee_id: int
    date: date
    status: str
    attempts: int
    recipient_kind: str


def list_pending(
    conn: Connection, scope: TenantScope, *, limit: int = 200
) -> list[PendingEmail]:
    rows = conn.execute(
        select(
            attendance_email_log.c.id,
            attendance_email_log.c.employee_id,
            attendance_email_log.c.date,
            attendance_email_log.c.status,
            attendance_email_log.c.attempts,
            attendance_email_log.c.recipient_kind,
        )
        .where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.sent_at.is_(None),
            attendance_email_log.c.skipped_at.is_(None),
            attendance_email_log.c.attempts < MAX_ATTEMPTS,
        )
        .order_by(attendance_email_log.c.id)
        .limit(limit)
    ).all()
    return [
        PendingEmail(
            id=int(r.id),
            employee_id=int(r.employee_id),
            date=r.date,
            status=str(r.status),
            attempts=int(r.attempts),
            recipient_kind=str(r.recipient_kind),
        )
        for r in rows
    ]


def mark_sent(
    conn: Connection,
    scope: TenantScope,
    *,
    row_id: int,
    recipient_email: str,
    subject: str,
    in_time: Optional[time],
    out_time: Optional[time],
    late_minutes: Optional[int],
    total_minutes: Optional[int],
) -> None:
    conn.execute(
        update(attendance_email_log)
        .where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.id == row_id,
        )
        .values(
            sent_at=datetime.now(timezone.utc),
            attempts=attendance_email_log.c.attempts + 1,
            recipient_email=recipient_email,
            subject=subject,
            in_time=in_time,
            out_time=out_time,
            late_minutes=late_minutes,
            total_minutes=total_minutes,
            last_error=None,
        )
    )


def mark_failed(
    conn: Connection, scope: TenantScope, *, row_id: int, error: str
) -> None:
    conn.execute(
        update(attendance_email_log)
        .where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.id == row_id,
        )
        .values(
            failed_at=datetime.now(timezone.utc),
            attempts=attendance_email_log.c.attempts + 1,
            # Bounded — provider errors can embed long server replies.
            last_error=error[:500],
        )
    )


def mark_skipped(
    conn: Connection, scope: TenantScope, *, row_id: int, reason: str
) -> None:
    conn.execute(
        update(attendance_email_log)
        .where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.id == row_id,
        )
        .values(
            skipped_at=datetime.now(timezone.utc),
            last_error=reason[:500],
        )
    )


def list_log(
    conn: Connection,
    scope: TenantScope,
    *,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict], int]:
    """Read-only delivery log for the settings page, newest first."""

    total = int(
        conn.execute(
            select(func.count())
            .select_from(attendance_email_log)
            .where(attendance_email_log.c.tenant_id == scope.tenant_id)
        ).scalar()
        or 0
    )
    rows = conn.execute(
        select(
            attendance_email_log.c.id,
            attendance_email_log.c.employee_id,
            attendance_email_log.c.date,
            attendance_email_log.c.status,
            attendance_email_log.c.recipient_kind,
            attendance_email_log.c.recipient_email,
            attendance_email_log.c.subject,
            attendance_email_log.c.attempts,
            attendance_email_log.c.sent_at,
            attendance_email_log.c.failed_at,
            attendance_email_log.c.skipped_at,
            attendance_email_log.c.last_error,
            attendance_email_log.c.created_at,
            employees.c.full_name,
            employees.c.employee_code,
        )
        .join(
            employees,
            (employees.c.id == attendance_email_log.c.employee_id)
            & (employees.c.tenant_id == attendance_email_log.c.tenant_id),
        )
        .where(attendance_email_log.c.tenant_id == scope.tenant_id)
        .order_by(attendance_email_log.c.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [
        {
            "id": int(r.id),
            "employee_id": int(r.employee_id),
            "employee_name": str(r.full_name),
            "employee_code": str(r.employee_code),
            "date": r.date.isoformat(),
            "status": str(r.status),
            "recipient_kind": str(r.recipient_kind),
            "recipient_email": r.recipient_email,
            "subject": r.subject,
            "attempts": int(r.attempts),
            "sent_at": r.sent_at.isoformat() if r.sent_at else None,
            "failed_at": r.failed_at.isoformat() if r.failed_at else None,
            "skipped_at": r.skipped_at.isoformat() if r.skipped_at else None,
            "last_error": r.last_error,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return items, total


def prior_check_in(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
) -> Optional[time]:
    """The attendance row's ``in_time`` BEFORE the current upsert.

    Used by the producer to detect the None → value transition (the
    employee's first identified detection of the day).
    """

    row = conn.execute(
        select(attendance_records.c.in_time).where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.employee_id == employee_id,
            attendance_records.c.date == the_date,
        )
    ).first()
    return row.in_time if row is not None else None


def sweep_absent_for(
    conn: Connection, scope: TenantScope, *, the_date: date
) -> int:
    """Enqueue an absent email for every active employee whose
    attendance row on ``the_date`` is absent (and not a leave day).

    Idempotent — the unique constraint silently drops duplicates, so
    the worker can call this on every tick.
    """

    rows = conn.execute(
        select(attendance_records.c.employee_id)
        .join(
            employees,
            (employees.c.id == attendance_records.c.employee_id)
            & (employees.c.tenant_id == attendance_records.c.tenant_id),
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date == the_date,
            attendance_records.c.absent.is_(True),
            attendance_records.c.leave_type_id.is_(None),
            employees.c.status == "active",
        )
    ).all()
    created = 0
    for r in rows:
        if enqueue_with_manager(
            conn,
            scope,
            employee_id=int(r.employee_id),
            the_date=the_date,
            status="absent",
        ):
            created += 1
    return created


def enqueue_today_statuses(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
    config: dict,
    employee_ids: Optional[list[int]] = None,
    resend: bool = False,
) -> tuple[dict, list[dict]]:
    """Manual-send support: enqueue one email per active employee whose
    attendance row on ``the_date`` already carries a status, honouring
    the tenant toggles. ``employee_ids`` narrows to a selection (the
    Daily attendance checkboxes); None means every active employee.

    Status mapping mirrors the automatic producers — absent flag wins,
    otherwise a check-in maps to late/present, no check-in yet → not
    queued (there is nothing to notify about). The unique constraint
    silently drops anything already queued or sent, so pressing the
    button twice never double-emails.

    Returns ``(counts, details)`` — details carries one entry per
    considered employee so the UI can show exactly who got what.
    """

    query = (
        select(
            attendance_records.c.employee_id,
            attendance_records.c.in_time,
            attendance_records.c.late,
            attendance_records.c.absent,
            attendance_records.c.leave_type_id,
            employees.c.full_name,
            employees.c.employee_code,
        )
        .join(
            employees,
            (employees.c.id == attendance_records.c.employee_id)
            & (employees.c.tenant_id == attendance_records.c.tenant_id),
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date == the_date,
            employees.c.status == "active",
        )
        .order_by(employees.c.full_name)
    )
    if employee_ids is not None:
        query = query.where(
            attendance_records.c.employee_id.in_(employee_ids)
        )
    rows = conn.execute(query).all()
    counts = {"considered": len(rows), "queued": 0, "no_status": 0,
              "toggle_off": 0, "already_queued": 0}
    details: list[dict] = []
    for r in rows:
        entry = {
            "employee_id": int(r.employee_id),
            "employee_name": str(r.full_name),
            "employee_code": str(r.employee_code),
            "status": None,
            "outcome": "",
        }
        if r.absent and r.leave_type_id is None:
            status = "absent"
        elif r.in_time is not None:
            status = "late" if r.late else "present"
        else:
            counts["no_status"] += 1
            entry["outcome"] = "no_status"
            details.append(entry)
            continue
        entry["status"] = status
        if not config.get(status, False):
            counts["toggle_off"] += 1
            entry["outcome"] = "toggle_off"
            details.append(entry)
            continue
        if enqueue_with_manager(
            conn,
            scope,
            employee_id=int(r.employee_id),
            the_date=the_date,
            status=status,
        ):
            counts["queued"] += 1
            entry["outcome"] = "queued"
        elif resend:
            # Manual resend: reset the existing row so the drain
            # sends it again.
            requeue(
                conn,
                scope,
                employee_id=int(r.employee_id),
                the_date=the_date,
                status=status,
            )
            counts["queued"] += 1
            entry["outcome"] = "queued"
        else:
            counts["already_queued"] += 1
            entry["outcome"] = "already_queued"
        details.append(entry)
    return counts, details


def log_outcomes_for(
    conn: Connection,
    scope: TenantScope,
    *,
    the_date: date,
    employee_ids: list[int],
) -> dict[tuple[int, str], dict]:
    """Delivery state per (employee_id, status) on one date — used by
    the manual-send endpoint to resolve each queued row's final
    outcome after the drain."""

    if not employee_ids:
        return {}
    rows = conn.execute(
        select(
            attendance_email_log.c.employee_id,
            attendance_email_log.c.status,
            attendance_email_log.c.sent_at,
            attendance_email_log.c.failed_at,
            attendance_email_log.c.skipped_at,
            attendance_email_log.c.last_error,
            attendance_email_log.c.recipient_email,
            attendance_email_log.c.attempts,
        ).where(
            attendance_email_log.c.tenant_id == scope.tenant_id,
            attendance_email_log.c.date == the_date,
            attendance_email_log.c.employee_id.in_(employee_ids),
            attendance_email_log.c.recipient_kind == "employee",
        )
    ).all()
    return {
        (int(r.employee_id), str(r.status)): {
            "sent_at": r.sent_at,
            "failed_at": r.failed_at,
            "skipped_at": r.skipped_at,
            "last_error": r.last_error,
            "recipient_email": r.recipient_email,
            "attempts": int(r.attempts),
        }
        for r in rows
    }


def absent_rows_with_policy(
    conn: Connection, scope: TenantScope, *, the_date: date
) -> list[tuple[int, int]]:
    """(employee_id, policy_id) for every active employee marked
    absent (not on leave) on ``the_date`` — input for the same-day
    post-shift absent sweep."""

    rows = conn.execute(
        select(
            attendance_records.c.employee_id,
            attendance_records.c.policy_id,
        )
        .join(
            employees,
            (employees.c.id == attendance_records.c.employee_id)
            & (employees.c.tenant_id == attendance_records.c.tenant_id),
        )
        .where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.date == the_date,
            attendance_records.c.absent.is_(True),
            attendance_records.c.leave_type_id.is_(None),
            employees.c.status == "active",
        )
    ).all()
    return [(int(r.employee_id), int(r.policy_id)) for r in rows]


def delivery_context(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
) -> Optional[dict]:
    """Everything the worker needs to render + address one email.

    Fresh read at delivery time so the email carries the latest
    computed values, not a stale enqueue-time snapshot. Returns None
    when the employee row is gone (hard-deleted between enqueue and
    delivery).
    """

    emp = conn.execute(
        select(
            employees.c.id,
            employees.c.full_name,
            employees.c.employee_code,
            employees.c.email,
            employees.c.status,
            departments.c.name.label("department_name"),
        )
        .join(
            departments,
            (departments.c.id == employees.c.department_id)
            & (departments.c.tenant_id == employees.c.tenant_id),
            isouter=True,
        )
        .where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
    ).first()
    if emp is None:
        return None
    att = conn.execute(
        select(
            attendance_records.c.in_time,
            attendance_records.c.out_time,
            attendance_records.c.total_minutes,
            attendance_records.c.late,
            attendance_records.c.absent,
            attendance_records.c.policy_id,
        ).where(
            attendance_records.c.tenant_id == scope.tenant_id,
            attendance_records.c.employee_id == employee_id,
            attendance_records.c.date == the_date,
        )
    ).first()
    return {
        "employee_name": str(emp.full_name),
        "employee_code": str(emp.employee_code),
        "employee_email": str(emp.email) if emp.email else None,
        "employee_status": str(emp.status),
        "department_name": (
            str(emp.department_name) if emp.department_name else None
        ),
        "in_time": att.in_time if att is not None else None,
        "out_time": att.out_time if att is not None else None,
        "total_minutes": (
            int(att.total_minutes)
            if att is not None and att.total_minutes is not None
            else None
        ),
        "late": bool(att.late) if att is not None else False,
        "absent": bool(att.absent) if att is not None else False,
        "policy_id": int(att.policy_id) if att is not None else None,
    }
