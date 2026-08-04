"""Turn staged device taps into ``detection_events`` + attendance.

This is the seam that lets a terminal reuse the whole existing pipeline.
``attendance/repository.py::events_for`` filters only on
``(tenant_id, employee_id, captured_at)`` — it has never known or cared
whether a camera or a terminal produced the row. So a device tap becomes a
``detection_events`` row with ``source='device'`` and every downstream
concern (policies, Ramadan, leave, holidays, reports) works unchanged.

Kept out of the request path deliberately: the terminal gets its ``200``
the moment the tap is staged, and this runs behind it. A slow recompute can
never time out a device post and trigger a retry storm.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from maugood.attendance.repository import load_tenant_settings, local_tz_for
from maugood.db import (
    detection_events,
    device_attendance_events,
    device_users,
    get_engine,
    tenant_context,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Device matching happens on the terminal, which reports a decision rather
# than a similarity score. We record a nominal confidence so reports that
# read the column don't special-case device rows.
_DEVICE_CONFIDENCE = 1.0


def _process_row(
    conn: Connection,
    scope: TenantScope,
    *,
    event_id: int,
    device_id: int,
    employee_id: int,
    occurred_at,
    event_serial: str,
) -> Optional[int]:
    """Write the detection row and link it back. Returns its id."""

    det_id = conn.execute(
        pg_insert(detection_events)
        .values(
            tenant_id=scope.tenant_id,
            source="device",
            device_id=device_id,
            camera_id=None,
            captured_at=occurred_at,
            bbox={},
            track_id=event_serial or f"dev-{event_id}",
            employee_id=employee_id,
            confidence=_DEVICE_CONFIDENCE,
        )
        .returning(detection_events.c.id)
    ).scalar_one()

    conn.execute(
        update(device_attendance_events)
        .where(
            device_attendance_events.c.id == event_id,
            device_attendance_events.c.tenant_id == scope.tenant_id,
        )
        .values(
            detection_event_id=det_id,
            status="processed",
            processed_at=datetime.now(tz=timezone.utc),
        )
    )
    return int(det_id)


def drain_pending(
    scope: TenantScope, *, limit: int = 500, device_id: Optional[int] = None
) -> int:
    """Process staged taps for one tenant. Returns how many were handled.

    ``device_id`` narrows the sweep to a single terminal — used by the
    operator-triggered "Sync now", so one device's catch-up can't be
    charged the cost of draining every other device in the tenant.

    Recompute runs **after** the transaction commits, because
    ``recompute_for`` opens its own connection and tenant context — calling
    it inside our transaction would deadlock against our own uncommitted
    detection rows.
    """

    from maugood.attendance.scheduler import recompute_for  # noqa: PLC0415

    to_recompute: set[tuple[int, object]] = set()

    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            settings = load_tenant_settings(conn, scope)
            tz = local_tz_for(settings)

            where = [
                device_attendance_events.c.tenant_id == scope.tenant_id,
                device_attendance_events.c.status == "pending",
                device_attendance_events.c.employee_id.isnot(None),
            ]
            if device_id is not None:
                where.append(device_attendance_events.c.device_id == device_id)

            rows = conn.execute(
                select(
                    device_attendance_events.c.id,
                    device_attendance_events.c.device_id,
                    device_attendance_events.c.employee_id,
                    device_attendance_events.c.occurred_at,
                    device_attendance_events.c.event_serial,
                )
                .where(*where)
                .order_by(device_attendance_events.c.occurred_at.asc())
                .limit(limit)
            ).all()

            for r in rows:
                try:
                    _process_row(
                        conn,
                        scope,
                        event_id=r.id,
                        device_id=r.device_id,
                        employee_id=r.employee_id,
                        occurred_at=r.occurred_at,
                        event_serial=r.event_serial,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "device event processing failed: id=%s device_id=%s",
                        r.id,
                        r.device_id,
                    )
                    conn.execute(
                        update(device_attendance_events)
                        .where(device_attendance_events.c.id == r.id)
                        .values(
                            status="failed",
                            last_error=str(exc)[:500],
                            attempts=device_attendance_events.c.attempts + 1,
                        )
                    )
                    continue

                # The attendance day is the tenant's local day, never the
                # server's — the P11 red line.
                to_recompute.add(
                    (r.employee_id, r.occurred_at.astimezone(tz).date())
                )

    for employee_id, the_date in to_recompute:
        try:
            recompute_for(scope, employee_id=employee_id, the_date=the_date)
        except Exception:  # noqa: BLE001
            logger.exception(
                "attendance recompute failed after device events: "
                "employee_id=%s date=%s",
                employee_id,
                the_date,
            )

    if to_recompute:
        logger.info(
            "device events drained: tenant_id=%s processed=%s recomputed=%s",
            scope.tenant_id,
            len(to_recompute),
            len(to_recompute),
        )
    return len(to_recompute)


def resync_device(scope: TenantScope, *, device_id: int) -> dict[str, int]:
    """Operator-triggered catch-up for one device. "Sync now".

    A push terminal cannot be polled — it dials us. So "sync" here does not
    mean *fetch from the device*; it means **re-drive everything already
    received that has not become attendance yet**. Three recoveries, in
    order:

    1. **adopted** — taps parked as ``skipped`` because their device user
       was unmapped at arrival, whose user has since been mapped. The
       mapping endpoint replays automatically; this catches the cases it
       could not, e.g. a mapping written out of band or a replay that
       failed midway.
    2. **retried** — taps that hit an error during processing. Re-armed
       rather than abandoned; ``attempts`` already records the history.
    3. **processed** — the resulting drain, which writes the
       ``detection_events`` rows and recomputes each affected day.

    Taps whose person is genuinely still unmapped stay ``skipped``. They
    are not failures and this must not touch them — mapping is the only
    thing that can resolve them, and quietly discarding them here would
    destroy the audit trail the parking exists to preserve.
    """

    adopted = 0
    retried = 0

    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            # Adopt: skipped taps whose device user now resolves to an
            # employee. Correlated subquery rather than a join so the
            # tenant filter applies to both tables independently.
            mapped_employee = (
                select(device_users.c.employee_id)
                .where(
                    device_users.c.tenant_id == scope.tenant_id,
                    device_users.c.device_id == device_id,
                    device_users.c.device_user_id
                    == device_attendance_events.c.device_user_id,
                    device_users.c.employee_id.isnot(None),
                )
                .limit(1)
                .scalar_subquery()
            )
            adopted = int(
                conn.execute(
                    update(device_attendance_events)
                    .where(
                        device_attendance_events.c.tenant_id == scope.tenant_id,
                        device_attendance_events.c.device_id == device_id,
                        device_attendance_events.c.status == "skipped",
                        mapped_employee.isnot(None),
                    )
                    .values(employee_id=mapped_employee, status="pending")
                ).rowcount
                or 0
            )

            # Retry: previously failed taps that do have an employee.
            retried = int(
                conn.execute(
                    update(device_attendance_events)
                    .where(
                        device_attendance_events.c.tenant_id == scope.tenant_id,
                        device_attendance_events.c.device_id == device_id,
                        device_attendance_events.c.status == "failed",
                        device_attendance_events.c.employee_id.isnot(None),
                    )
                    .values(status="pending", last_error=None)
                ).rowcount
                or 0
            )

    processed = drain_pending(scope, device_id=device_id)

    logger.info(
        "device resync: tenant_id=%s device_id=%s adopted=%s retried=%s "
        "processed=%s",
        scope.tenant_id,
        device_id,
        adopted,
        retried,
        processed,
    )
    return {"adopted": adopted, "retried": retried, "processed": processed}


def replay_for_device_user(
    scope: TenantScope, *, device_id: int, device_user_id: str, employee_id: int
) -> int:
    """Re-process taps that arrived before this person was mapped.

    Taps from an unrecognised device id are parked as ``skipped`` rather
    than dropped, precisely so mapping can recover them. Without this, every
    tap between a terminal going live and an operator finishing the mapping
    would be lost with nothing to show it ever happened.
    """

    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            result = conn.execute(
                update(device_attendance_events)
                .where(
                    device_attendance_events.c.tenant_id == scope.tenant_id,
                    device_attendance_events.c.device_id == device_id,
                    device_attendance_events.c.device_user_id == device_user_id,
                    device_attendance_events.c.status == "skipped",
                )
                .values(employee_id=employee_id, status="pending")
            )
            revived = int(result.rowcount or 0)

    if revived:
        drain_pending(scope)
    return revived
