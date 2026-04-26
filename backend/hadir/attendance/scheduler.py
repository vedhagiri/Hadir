"""APScheduler wrapper that recomputes today's attendance rows.

Runs every ``HADIR_ATTENDANCE_RECOMPUTE_MINUTES`` (default 15). Also
recomputes once on startup so the first lifespan tick lands rows before
anyone hits ``GET /api/attendance``.

Historical days are **not** recomputed — per the pilot-plan, once
``date`` rolls over we treat yesterday as frozen. v1.0 introduces a
separate "late recompute" flow.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler

from hadir.attendance import engine as attendance_engine
from hadir.attendance import repository as attendance_repo
from hadir.config import get_settings
from hadir.db import get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_JOB_ID = "attendance-recompute-today"


def recompute_for(
    scope: TenantScope,
    *,
    employee_id: int,
    the_date,
) -> bool:
    """Recompute the attendance row for one employee on one date.

    Unlike ``recompute_today`` this does **not** restrict to today —
    it's the path used by P13 request approvals to reflect a newly-
    approved exception or leave on a past date. The contract is the
    same: pure engine call + ``ON CONFLICT`` upsert. Returns ``True``
    when a row was upserted, ``False`` if no policy resolves for the
    employee/date pair.
    """

    from hadir.db import tenant_context  # noqa: PLC0415

    with tenant_context(scope.tenant_schema):
        return _recompute_for_inner(scope, employee_id=employee_id, the_date=the_date)


def _maybe_notify_overtime(
    conn,
    scope: TenantScope,
    *,
    employee_id: int,
    the_date,
    prior_overtime: Optional[int],
    record,
) -> None:
    """Fire ``overtime_flagged`` only when overtime crosses the
    zero → positive boundary for this employee + date.

    Suppresses repeat fires when the same recompute pass touches a
    row that already had overtime — the producer would skip
    duplicates anyway, but the cleaner gate keeps the audit log
    tidy.
    """

    new_ot = int(record.overtime_minutes or 0)
    if new_ot <= 0:
        return
    if prior_overtime is not None and prior_overtime > 0:
        return  # already flagged earlier today

    from hadir.db import employees as _employees  # noqa: PLC0415
    from hadir.notifications.producer import (  # noqa: PLC0415
        notify_overtime_flagged,
    )
    from sqlalchemy import select as _select  # noqa: PLC0415

    emp_row = conn.execute(
        _select(
            _employees.c.id,
            _employees.c.employee_code,
            _employees.c.full_name,
        ).where(
            _employees.c.tenant_id == scope.tenant_id,
            _employees.c.id == employee_id,
        )
    ).first()
    if emp_row is None:
        return

    # Manager scope = explicit assignments + department-membership
    # union (matches P15). Pull the visible-set the same way the
    # request inbox does so the manager who'd act on this rate
    # gets the bell.
    from hadir.manager_assignments.repository import (  # noqa: PLC0415
        get_manager_visible_employee_ids,
    )
    from hadir.db import manager_assignments as _ma  # noqa: PLC0415

    direct_managers = [
        int(r.manager_user_id)
        for r in conn.execute(
            _select(_ma.c.manager_user_id).where(
                _ma.c.tenant_id == scope.tenant_id,
                _ma.c.employee_id == employee_id,
            )
        ).all()
    ]
    notify_overtime_flagged(
        conn,
        scope,
        employee_id=int(emp_row.id),
        employee_code=str(emp_row.employee_code),
        employee_full_name=str(emp_row.full_name),
        the_date=the_date,
        overtime_minutes=new_ot,
        manager_user_ids=direct_managers,
    )


def _recompute_for_inner(
    scope: TenantScope, *, employee_id: int, the_date
) -> bool:
    engine = get_engine()
    with engine.begin() as conn:
        settings = attendance_repo.load_tenant_settings(conn, scope)
        policy_map = attendance_repo.resolve_policies_for_employees(
            conn, scope, the_date=the_date, employee_ids=[employee_id]
        )
        policy = policy_map.get(employee_id)
        if policy is None:
            logger.warning(
                "attendance recompute_for: no policy for employee %s on %s",
                employee_id,
                the_date,
            )
            return False
        events = attendance_repo.events_for(
            conn, scope, employee_id=employee_id, the_date=the_date
        )
        leaves = attendance_repo.leaves_for_employee_on(
            conn, scope, employee_id=employee_id, the_date=the_date
        )
        todays_holidays = attendance_repo.holidays_on(
            conn, scope, the_date=the_date
        )
        record = attendance_engine.compute(
            employee_id=employee_id,
            the_date=the_date,
            policy=policy,
            events=events,
            leaves=leaves,
            holidays=todays_holidays,
            weekend_days=settings.weekend_days,
        )
        # Capture prior overtime BEFORE the upsert so we can detect
        # the zero → positive flip.
        prior_overtime = attendance_repo.existing_overtime_minutes(
            conn, scope, employee_id=employee_id, the_date=the_date
        )
        attendance_repo.upsert_attendance(conn, scope, record)
        _maybe_notify_overtime(
            conn,
            scope,
            employee_id=employee_id,
            the_date=the_date,
            prior_overtime=prior_overtime,
            record=record,
        )
    return True


def recompute_today(scope: TenantScope) -> int:
    """Recompute the attendance_records row for every active employee today.

    Returns the number of rows upserted. Keeps itself resilient: a single
    employee blowing up doesn't abort the others.

    v1.0 P1: this is a non-request entry point, so we set the tenant
    context explicitly. Every connection borrowed inside the block
    runs against ``scope.tenant_schema`` via the checkout event.
    """

    from hadir.db import tenant_context  # noqa: PLC0415

    with tenant_context(scope.tenant_schema):
        return _recompute_today_inner(scope)


def _recompute_today_inner(scope: TenantScope) -> int:
    engine = get_engine()

    # P11: timezone is tenant-scoped. Read it (and the weekend
    # days) once per recompute pass.
    with engine.begin() as conn:
        settings = attendance_repo.load_tenant_settings(conn, scope)
    tz = attendance_repo.local_tz_for(settings)
    today = datetime.now(timezone.utc).astimezone(tz).date()

    with engine.begin() as conn:
        employee_ids = attendance_repo.active_employee_ids(conn, scope)
        # P9: resolve per-employee via the policy_assignments cascade.
        policy_map = attendance_repo.resolve_policies_for_employees(
            conn, scope, the_date=today, employee_ids=employee_ids
        )
        # P11: holidays are tenant-wide; load once.
        todays_holidays = attendance_repo.holidays_on(
            conn, scope, the_date=today
        )
    if not policy_map:
        logger.warning(
            "attendance: no active policy resolves for tenant %s on %s",
            scope.tenant_id,
            today,
        )
        return 0

    upserted = 0
    for emp_id in employee_ids:
        policy = policy_map.get(emp_id)
        if policy is None:
            # Employee with no resolvable policy — skip silently. The
            # missing-policy log line above already flagged the tenant.
            continue
        try:
            with engine.begin() as conn:
                events = attendance_repo.events_for(
                    conn, scope, employee_id=emp_id, the_date=today
                )
                # P11: per-employee leaves overlapping today.
                leaves = attendance_repo.leaves_for_employee_on(
                    conn, scope, employee_id=emp_id, the_date=today
                )
                record = attendance_engine.compute(
                    employee_id=emp_id,
                    the_date=today,
                    policy=policy,
                    events=events,
                    leaves=leaves,
                    holidays=todays_holidays,
                    weekend_days=settings.weekend_days,
                )
                prior_overtime = attendance_repo.existing_overtime_minutes(
                    conn, scope, employee_id=emp_id, the_date=today
                )
                attendance_repo.upsert_attendance(conn, scope, record)
                _maybe_notify_overtime(
                    conn,
                    scope,
                    employee_id=emp_id,
                    the_date=today,
                    prior_overtime=prior_overtime,
                    record=record,
                )
            upserted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "attendance: recompute failed for employee %s: %s",
                emp_id,
                type(exc).__name__,
            )
    logger.info(
        "attendance recompute done: tenant=%s date=%s upserted=%d",
        scope.tenant_id,
        today,
        upserted,
    )

    # P26: Prometheus counter — opaque tenant id only.
    try:
        from hadir.metrics import observe_attendance_recomputed  # noqa: PLC0415

        observe_attendance_recomputed(scope.tenant_id, upserted)
    except Exception:  # noqa: BLE001
        pass

    return upserted


class AttendanceScheduler:
    """Thin supervisor for the periodic recompute job."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: BackgroundScheduler | None = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            settings = get_settings()
            scope = TenantScope(tenant_id=settings.default_tenant_id)
            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(
                recompute_today,
                "interval",
                minutes=settings.attendance_recompute_minutes,
                id=_JOB_ID,
                replace_existing=True,
                kwargs={"scope": scope},
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "attendance scheduler started: interval=%dmin",
                settings.attendance_recompute_minutes,
            )
            # P26: bump ``hadir_scheduler_jobs_failed_total`` on
            # any unhandled exception inside ``recompute_today``.
            try:
                from hadir.metrics import (  # noqa: PLC0415
                    install_scheduler_failure_listener,
                )

                install_scheduler_failure_listener(
                    scheduler,
                    job_name="attendance_recompute",
                    tenant_id=scope.tenant_id,
                )
            except Exception:  # noqa: BLE001
                pass

            # Seed once on startup so a fresh boot has rows immediately.
            def _seed() -> None:
                try:
                    recompute_today(scope)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "attendance: startup seed failed: %s", type(exc).__name__
                    )

            threading.Thread(
                target=_seed, name="attendance-seed", daemon=True
            ).start()

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


attendance_scheduler = AttendanceScheduler()
