"""P28.7 — Daily lifecycle cron.

Runs at **00:01 in each tenant's timezone** (per-tenant schedules — one
cron job per tenant since timezones may differ). For each tenant:

1. Find employees where ``relieving_date IS NOT NULL AND relieving_date
   <= today (tenant local) AND status = 'active'``.
2. Flip them to ``status='inactive'`` with
   ``deactivation_reason='Auto-deactivated: relieving_date reached'``
   and ``deactivated_at=now()``.
3. Audit each as ``employee.auto_deactivated`` so the timeline is
   visible.
4. Reload the matcher cache for the tenant — one reload per tenant,
   not per employee.

The job is **idempotent**: running it twice in a day is a no-op (the
status filter excludes employees already inactive).

Manual trigger for testing + demos:

    docker compose exec backend python -m scripts.run_lifecycle_cron

The script accepts ``--tenant-slug <slug>`` to target a single tenant
for the validation walkthrough.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from maugood.attendance.repository import load_tenant_settings, local_tz_for
from maugood.auth.audit import write_audit
from maugood.config import get_settings
from maugood.db import (
    employees as t_employees,
    get_engine,
    make_admin_engine,
    tenant_context,
    tenants as t_tenants,
)
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

AUTO_DEACTIVATION_REASON = "Auto-deactivated: relieving_date reached"


def run_for_tenant(tenant_id: int, tenant_schema: str) -> int:
    """Run the lifecycle sweep for one tenant. Returns the count flipped.

    Caller is responsible for being inside the right tenant context;
    this helper opens its own ``tenant_context`` so it's safe to call
    standalone from a script.
    """

    scope = TenantScope(tenant_id=tenant_id)
    engine = get_engine()
    flipped = 0

    with tenant_context(tenant_schema):
        with engine.begin() as conn:
            settings = load_tenant_settings(conn, scope)
            today_local = datetime.now(timezone.utc).astimezone(
                local_tz_for(settings)
            ).date()

            # Find candidates first so we can audit each by id.
            candidates = conn.execute(
                select(
                    t_employees.c.id,
                    t_employees.c.employee_code,
                    t_employees.c.full_name,
                    t_employees.c.relieving_date,
                ).where(
                    t_employees.c.tenant_id == tenant_id,
                    t_employees.c.status == "active",
                    t_employees.c.relieving_date.is_not(None),
                    t_employees.c.relieving_date <= today_local,
                )
            ).all()

            if not candidates:
                return 0

            now = datetime.now(tz=timezone.utc)
            for emp in candidates:
                conn.execute(
                    update(t_employees)
                    .where(t_employees.c.id == emp.id)
                    .values(
                        status="inactive",
                        deactivated_at=now,
                        deactivation_reason=AUTO_DEACTIVATION_REASON,
                    )
                )
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=None,  # System action.
                    action="employee.auto_deactivated",
                    entity_type="employee",
                    entity_id=str(int(emp.id)),
                    after={
                        "employee_code": str(emp.employee_code),
                        "full_name": str(emp.full_name),
                        "relieving_date": emp.relieving_date.isoformat(),
                        "reason": AUTO_DEACTIVATION_REASON,
                    },
                )
                flipped += 1

    if flipped > 0:
        # One reload per tenant — picks up every flip in this batch.
        matcher_cache.invalidate_tenant(tenant_id)
        logger.info(
            "lifecycle cron: tenant_id=%d flipped %d employee(s) to inactive",
            tenant_id,
            flipped,
        )

    return flipped


def run_all_tenants() -> dict[int, int]:
    """Sweep every active tenant. Returns ``{tenant_id: count_flipped}``.

    Called by the APScheduler tick AND the standalone script. Tenants
    with bad timezones or partial config are logged + skipped — never
    poison the whole sweep.
    """

    admin_engine = make_admin_engine()
    summary: dict[int, int] = {}

    settings = get_settings()
    if settings.tenant_mode == "single":
        # Single-mode = pilot; main schema is the only tenant.
        try:
            count = run_for_tenant(settings.default_tenant_id, "main")
            summary[settings.default_tenant_id] = count
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "lifecycle cron failed for default tenant: %s",
                type(exc).__name__,
            )
        return summary

    with tenant_context("public"):
        with admin_engine.begin() as conn:
            rows = conn.execute(
                select(
                    t_tenants.c.id,
                    t_tenants.c.schema_name,
                    t_tenants.c.status,
                ).where(t_tenants.c.status == "active")
            ).all()

    for r in rows:
        try:
            count = run_for_tenant(int(r.id), str(r.schema_name))
            summary[int(r.id)] = count
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "lifecycle cron failed for tenant_id=%d: %s",
                int(r.id),
                type(exc).__name__,
            )

    return summary


class LifecycleScheduler:
    """Wraps an APScheduler with one cron job per tenant.

    Why one job per tenant: each tenant has its own timezone (P11 red
    line), so the "00:01 local" trigger differs. APScheduler supports
    cron triggers with explicit timezones — we register one for each.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: Optional[BackgroundScheduler] = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            scheduler = BackgroundScheduler(daemon=True)
            self._reschedule_all(scheduler)
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "lifecycle scheduler started: 00:01 daily per-tenant timezone"
            )

    def _reschedule_all(self, scheduler: BackgroundScheduler) -> None:
        """Iterate active tenants and add one cron job per."""

        settings = get_settings()
        if settings.tenant_mode == "single":
            scheduler.add_job(
                run_for_tenant,
                CronTrigger(hour=0, minute=1, timezone=settings.local_timezone),
                id="lifecycle-tenant-default",
                replace_existing=True,
                kwargs={
                    "tenant_id": settings.default_tenant_id,
                    "tenant_schema": "main",
                },
            )
            return

        admin_engine = make_admin_engine()
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                rows = conn.execute(
                    select(
                        t_tenants.c.id,
                        t_tenants.c.schema_name,
                        t_tenants.c.status,
                    ).where(t_tenants.c.status == "active")
                ).all()

        for r in rows:
            tenant_id = int(r.id)
            schema = str(r.schema_name)
            try:
                with tenant_context(schema):
                    with get_engine().begin() as conn:
                        settings_row = load_tenant_settings(
                            conn, TenantScope(tenant_id=tenant_id)
                        )
                tz_name = settings_row.timezone
            except Exception:  # noqa: BLE001
                tz_name = settings.local_timezone

            scheduler.add_job(
                run_for_tenant,
                CronTrigger(hour=0, minute=1, timezone=tz_name),
                id=f"lifecycle-tenant-{tenant_id}",
                replace_existing=True,
                kwargs={
                    "tenant_id": tenant_id,
                    "tenant_schema": schema,
                },
            )

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


lifecycle_scheduler = LifecycleScheduler()
