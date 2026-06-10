"""Enqueue hooks for attendance status emails.

Two entry points:

* ``maybe_enqueue_on_recompute`` — called by the attendance scheduler
  inside the same transaction as the upsert. Fires present/late when
  the day's ``in_time`` transitions None → value (the employee's first
  identified detection of the day). Today-only: past-date recomputes
  (request approvals) never email.
* ``sweep_absent_yesterday`` — called from the email worker's tick.
  Once the tenant-local day rolls over, yesterday's absent rows are
  final (the scheduler only recomputes today), so each gets one absent
  email. The unique constraint keeps re-sweeps idempotent.

Both honour the tenant's Settings → Notifications toggles at enqueue
time; the worker re-checks them again at delivery time, so a flip in
either direction takes effect within one tick.

Failure isolation: callers wrap these in try/except — an email
problem must never break attendance computation itself.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy.engine import Connection

from maugood.attendance_email import repository as repo
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def maybe_enqueue_on_recompute(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date: date,
    today_local: date,
    prior_in_time: Optional[time],
    record,
) -> Optional[str]:
    """Enqueue a present/late email when the first check-in lands.

    Returns the enqueued status ("present"/"late") or None. Caller
    passes ``prior_in_time`` captured BEFORE the upsert and the
    tenant-local ``today`` so past-date recomputes are filtered out.
    """

    if the_date != today_local:
        return None
    if record.in_time is None or prior_in_time is not None:
        return None  # no check-in yet, or already emailed earlier

    status = "late" if record.late else "present"
    config = repo.load_config(conn, scope)
    if not config.get(status, False):
        return None

    created = repo.enqueue_with_manager(
        conn,
        scope,
        employee_id=employee_id,
        the_date=the_date,
        status=status,
    )
    if created:
        logger.info(
            "attendance email queued: tenant=%s employee=%s date=%s status=%s",
            scope.tenant_id,
            employee_id,
            the_date,
            status,
        )
        return status
    return None


def sweep_absent_after_shift(
    conn: Connection,
    scope: TenantScope,
    *,
    tz,
) -> int:
    """Same-day absent emails, fired once the employee's shift end has
    passed (the client-confirmed workflow: don't email "absent" while
    they could still arrive).

    Uses each absent row's resolved policy end time (Fixed ``end`` /
    Flex ``out_window_end``); rows whose policy has no resolvable end
    are left for the midnight sweep. Idempotent via the unique
    constraint, so running every worker tick is fine.
    """

    config = repo.load_config(conn, scope)
    if not config.get("absent", False):
        return 0
    from maugood.attendance.repository import (  # noqa: PLC0415
        policy_shift_end_times,
    )

    now_local = datetime.now(timezone.utc).astimezone(tz)
    today = now_local.date()
    rows = repo.absent_rows_with_policy(conn, scope, the_date=today)
    if not rows:
        return 0
    end_times = policy_shift_end_times(
        conn, scope, sorted({pid for _, pid in rows})
    )
    created = 0
    for employee_id, policy_id in rows:
        end = end_times.get(policy_id)
        if end is None or now_local.time() <= end:
            continue  # shift still open (or unknown) — not absent yet
        if repo.enqueue_with_manager(
            conn,
            scope,
            employee_id=employee_id,
            the_date=today,
            status="absent",
        ):
            created += 1
    if created:
        logger.info(
            "attendance email post-shift absent sweep: tenant=%s date=%s queued=%d",
            scope.tenant_id,
            today,
            created,
        )
    return created


def sweep_absent_yesterday(
    conn: Connection,
    scope: TenantScope,
    *,
    tz,
) -> int:
    """Enqueue absent emails for the tenant-local *yesterday*.

    Yesterday only — never further back, so enabling the toggle on an
    old install can't flood employees with historical absences.
    """

    config = repo.load_config(conn, scope)
    if not config.get("absent", False):
        return 0
    yesterday = (
        datetime.now(timezone.utc).astimezone(tz) - timedelta(days=1)
    ).date()
    created = repo.sweep_absent_for(conn, scope, the_date=yesterday)
    if created:
        logger.info(
            "attendance email absent sweep: tenant=%s date=%s queued=%d",
            scope.tenant_id,
            yesterday,
            created,
        )
    return created
