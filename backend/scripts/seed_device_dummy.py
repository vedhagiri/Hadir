"""Dummy-data seed for device-based attendance (dev/testing only).

Simulates what a real terminal would have produced — WITHOUT a physical
device. It registers a device, syncs one employee, injects that employee's
taps for a day (face + fingerprint), processes them into detection_events,
and runs the real attendance recompute. Then it prints every table so you
can verify the end-to-end flow.

Re-runnable: every step is idempotent (unique keys + null-guards), so you
can run it repeatedly without creating duplicates.

Usage:
    docker compose exec -T -e MAUGOOD_ENV=dev backend \\
        python -m scripts.seed_device_dummy

Defaults target tenant ``inaisys`` + employee ``OM00044``; override via env:
    SEED_TENANT_SLUG, SEED_EMPLOYEE_CODE, SEED_DATE (YYYY-MM-DD).
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from maugood.attendance.scheduler import recompute_for
from maugood.db import (
    attendance_devices,
    attendance_records,
    detection_events,
    device_attendance_events,
    device_users,
    employees,
    get_engine,
    tenant_context,
)
from maugood.devices.crypto import encrypt_credentials
from maugood.tenants.scope import TenantScope

TENANT_SLUG = os.environ.get("SEED_TENANT_SLUG", "inaisys")
EMPLOYEE_CODE = os.environ.get("SEED_EMPLOYEE_CODE", "OM00044")
SEED_DATE = os.environ.get("SEED_DATE", "2026-08-03")

DEVICE_NAME = "Main Gate Terminal"
DEVICE_SERIAL = "DS7K1T-INAISYS01"

# The four taps: (event_serial, HH:MM UTC, verify_mode, direction).
# 03:42Z=09:12 IST, 07:30Z=13:00 IST, 08:15Z=13:45 IST, 13:00Z=18:30 IST.
TAPS = [
    ("EVT-88121", (3, 42), "face", "in"),
    ("EVT-88300", (7, 30), "fingerprint", "out"),
    ("EVT-88355", (8, 15), "fingerprint", "in"),
    ("EVT-88490", (13, 0), "face", "out"),
]


def _resolve_tenant() -> tuple[int, str]:
    with get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT id, schema_name FROM public.tenants WHERE slug = :s"),
            {"s": TENANT_SLUG},
        ).first()
    if row is None:
        raise SystemExit(f"tenant slug {TENANT_SLUG!r} not found")
    return int(row.id), str(row.schema_name)


def main() -> None:
    tenant_id, schema = _resolve_tenant()
    scope = TenantScope(tenant_id=tenant_id, tenant_schema=schema)
    the_date = date.fromisoformat(SEED_DATE)
    y, m, d = the_date.year, the_date.month, the_date.day

    print(f"→ tenant={TENANT_SLUG} (id={tenant_id}, schema={schema})")

    with tenant_context(schema):
        with get_engine().begin() as conn:
            # 1. employee
            emp = conn.execute(
                select(employees.c.id, employees.c.full_name).where(
                    employees.c.tenant_id == tenant_id,
                    employees.c.employee_code == EMPLOYEE_CODE,
                )
            ).first()
            if emp is None:
                raise SystemExit(
                    f"employee {EMPLOYEE_CODE!r} not found in {schema}"
                )
            employee_id = int(emp.id)
            print(f"→ employee={EMPLOYEE_CODE} ({emp.full_name}, id={employee_id})")

            # 2. device (find or create)
            dev = conn.execute(
                select(attendance_devices.c.id).where(
                    attendance_devices.c.tenant_id == tenant_id,
                    attendance_devices.c.serial_number == DEVICE_SERIAL,
                )
            ).first()
            if dev is None:
                device_id = conn.execute(
                    pg_insert(attendance_devices)
                    .values(
                        tenant_id=tenant_id,
                        name=DEVICE_NAME,
                        location="Building A",
                        driver="hikvision",
                        host="192.168.1.64",
                        port=80,
                        credentials_encrypted=encrypt_credentials("admin", "dummy"),
                        serial_number=DEVICE_SERIAL,
                        model="DS-K1T671MF",
                        enrollment_scope="all",
                        enabled=True,
                        health_status="online",
                    )
                    .returning(attendance_devices.c.id)
                ).scalar_one()
                print(f"→ created device id={device_id}")
            else:
                device_id = int(dev.id)
                print(f"→ device exists id={device_id}")

            # 3. device_users — upsert the employee (re-sync = one row)
            conn.execute(
                pg_insert(device_users)
                .values(
                    tenant_id=tenant_id,
                    device_id=device_id,
                    device_user_id=EMPLOYEE_CODE,
                    name=emp.full_name,
                    employee_id=employee_id,
                    mapping_status="mapped",
                    face_synced=True,
                    active=True,
                    synced_at=datetime.now(tz=timezone.utc),
                )
                .on_conflict_do_update(
                    constraint="uq_device_users_tenant_device_user",
                    set_={
                        "employee_id": employee_id,
                        "mapping_status": "mapped",
                        "synced_at": datetime.now(tz=timezone.utc),
                    },
                )
            )
            conn.execute(
                update(attendance_devices)
                .where(attendance_devices.c.id == device_id)
                .values(
                    users_synced=1,
                    last_user_sync_at=datetime.now(tz=timezone.utc),
                )
            )

            # 4. device_attendance_events — insert taps (idempotent on serial)
            for serial, (hh, mm), mode, direction in TAPS:
                occurred = datetime(y, m, d, hh, mm, 0, tzinfo=timezone.utc)
                conn.execute(
                    pg_insert(device_attendance_events)
                    .values(
                        tenant_id=tenant_id,
                        device_id=device_id,
                        device_user_id=EMPLOYEE_CODE,
                        event_serial=serial,
                        occurred_at=occurred,
                        verify_mode=mode,
                        direction=direction,
                        status="pending",
                        employee_id=employee_id,
                    )
                    .on_conflict_do_nothing(
                        constraint="uq_device_events_tenant_device_serial"
                    )
                )

            # 5. process pending events → detection_events (idempotent)
            pending = conn.execute(
                select(
                    device_attendance_events.c.id,
                    device_attendance_events.c.event_serial,
                    device_attendance_events.c.occurred_at,
                ).where(
                    device_attendance_events.c.tenant_id == tenant_id,
                    device_attendance_events.c.device_id == device_id,
                    device_attendance_events.c.detection_event_id.is_(None),
                )
            ).all()
            for ev in pending:
                det_id = conn.execute(
                    pg_insert(detection_events)
                    .values(
                        tenant_id=tenant_id,
                        source="device",
                        device_id=device_id,
                        camera_id=None,
                        captured_at=ev.occurred_at,
                        bbox={},
                        track_id=ev.event_serial,
                        employee_id=employee_id,
                        confidence=0.95,
                    )
                    .returning(detection_events.c.id)
                ).scalar_one()
                conn.execute(
                    update(device_attendance_events)
                    .where(device_attendance_events.c.id == ev.id)
                    .values(
                        status="processed",
                        detection_event_id=det_id,
                        processed_at=datetime.now(tz=timezone.utc),
                    )
                )
            print(f"→ processed {len(pending)} new event(s) into detection_events")

    # 6. recompute attendance for that day (opens its own tenant_context)
    ok = recompute_for(scope, employee_id=employee_id, the_date=the_date)
    print(f"→ recompute_for {SEED_DATE}: {'row upserted' if ok else 'NO POLICY resolved'}")

    # 7. show the result
    with tenant_context(schema):
        with get_engine().begin() as conn:
            rec = conn.execute(
                select(attendance_records).where(
                    attendance_records.c.tenant_id == tenant_id,
                    attendance_records.c.employee_id == employee_id,
                    attendance_records.c.date == the_date,
                )
            ).mappings().first()
    print("\n=== attendance_records ===")
    if rec is None:
        print("(no row — check the employee has an active shift policy)")
    else:
        for k in ("date", "in_time", "out_time", "total_minutes", "late",
                  "early_out", "short_hours", "absent", "overtime_minutes"):
            print(f"  {k:18} = {rec.get(k)}")
    print("\nDone. Open the Attendance page for this employee + date to see it.")


if __name__ == "__main__":
    main()
