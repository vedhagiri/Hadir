"""End-to-end smoke for the device push ingest path.

Registers a push device, posts real Hikvision-shaped payloads at the live
HTTP endpoint, and asserts the whole chain: token routing → discovery →
dedup → attendance. Exercises the awkward cases too (keepalive, 1970
clock, unknown token, unmapped person + replay on mapping).

Dev only. Re-runnable — cleans up the device it creates.

    docker compose exec -T -e MAUGOOD_ENV=dev backend \\
        python -m scripts.smoke_device_push
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import delete, select

from maugood.db import (
    attendance_records,
    detection_events,
    device_attendance_events,
    device_users,
    employees,
    get_engine,
    tenant_context,
    tenants,
)
from maugood.devices import repository as repo
from maugood.devices import tokens
from maugood.tenants.scope import TenantScope

BASE = os.environ.get("SMOKE_BASE_URL", "http://localhost:8000")
TENANT_SLUG = os.environ.get("SMOKE_TENANT_SLUG", "inaisys")
EMPLOYEE_CODE = os.environ.get("SMOKE_EMPLOYEE_CODE", "OM00044")

_ok = 0
_fail = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global _ok, _fail
    if condition:
        _ok += 1
        print(f"  PASS  {label}")
    else:
        _fail += 1
        print(f"  FAIL  {label} {detail}")


def hik_payload(*, employee_no, name, serial, when, direction="checkIn"):
    return {
        "ipAddress": "192.168.1.64",
        "dateTime": when,
        "eventType": "AccessControllerEvent",
        "AccessControllerEvent": {
            "employeeNoString": employee_no,
            "name": name,
            "attendanceStatus": direction,
            "currentVerifyMode": "faceOrFpOrCardOrPw",
            "serialNo": serial,
            "deviceName": "Entrance",
        },
    }


def main() -> int:
    if os.environ.get("MAUGOOD_ENV") != "dev":
        print("refusing to run outside MAUGOOD_ENV=dev")
        return 2

    # --- resolve tenant + employee -------------------------------------
    with tenant_context("public"):
        with get_engine().begin() as conn:
            trow = conn.execute(
                select(tenants.c.id, tenants.c.schema_name).where(
                    tenants.c.slug == TENANT_SLUG
                )
            ).first()
    if trow is None:
        print(f"tenant {TENANT_SLUG!r} not found")
        return 2
    scope = TenantScope(tenant_id=int(trow.id), tenant_schema=str(trow.schema_name))
    print(f"tenant {TENANT_SLUG} → id={scope.tenant_id} schema={scope.tenant_schema}")

    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            emp = conn.execute(
                select(employees.c.id, employees.c.full_name).where(
                    employees.c.tenant_id == scope.tenant_id,
                    employees.c.employee_code == EMPLOYEE_CODE,
                )
            ).first()
    if emp is None:
        print(f"employee {EMPLOYEE_CODE!r} not found")
        return 2
    print(f"employee {EMPLOYEE_CODE} → id={emp.id} ({emp.full_name})")

    # --- register a push device ----------------------------------------
    token = tokens.mint_token()
    token_hash = tokens.hash_token(token)
    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            device_id = repo.create_push_device(
                conn,
                scope,
                name="Smoke Entrance",
                location="Smoke Test",
                driver="hikvision",
                enabled=True,
                push_token_hash=token_hash,
                push_token_encrypted=tokens.encrypt_token(token),
            )
    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.register(
                conn,
                token_hash=token_hash,
                tenant_id=scope.tenant_id,
                tenant_schema=scope.tenant_schema,
                device_id=device_id,
            )
    print(f"device id={device_id} token={token} (dev only — never log this)\n")

    url = f"{BASE}/hik/{token}?device_name=smoke-entrance"

    # Anchor both taps to a single *tenant-local* working day. Building
    # them from UTC offsets instead would straddle two local dates for any
    # tenant far enough from UTC — which is exactly the bug the per-tenant
    # timezone rule exists to prevent.
    from maugood.attendance.repository import load_tenant_settings, local_tz_for

    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            tz = local_tz_for(load_tenant_settings(conn, scope))
    # Five days back: inside the 7-day clock-sanity window, but clear of
    # any seeded or real attendance for this employee, so the in/out
    # assertions below measure our taps and nothing else.
    target_day = (datetime.now(tz=tz) - timedelta(days=5)).date()
    print(f"tenant timezone {tz} → posting taps for local day {target_day}")

    def local(h: int, m: int) -> datetime:
        return datetime(
            target_day.year, target_day.month, target_day.day, h, m, tzinfo=tz
        )

    t_in = local(8, 15)
    t_out = local(17, 40)

    try:
        with httpx.Client(timeout=30.0) as c:
            print("1. unknown token is refused")
            r = c.post(f"{BASE}/hik/0000-00000", json={})
            check("unknown token → 401", r.status_code == 401, f"got {r.status_code}")

            print("2. keepalive (no employeeNoString)")
            r = c.post(url, json={"dateTime": t_in.isoformat(), "eventType": "heartbeat"})
            check("keepalive → 200", r.status_code == 200, f"got {r.status_code}")

            print("3. mapped employee taps in and out")
            r = c.post(
                url,
                json=hik_payload(
                    employee_no=EMPLOYEE_CODE,
                    name="Harikrishnan",
                    serial=168,
                    when=t_in.isoformat(),
                ),
            )
            check("first tap → 200", r.status_code == 200, f"got {r.status_code}")
            r = c.post(
                url,
                json=hik_payload(
                    employee_no=EMPLOYEE_CODE,
                    name="Harikrishnan",
                    serial=174,
                    when=t_out.isoformat(),
                    direction="checkOut",
                ),
            )
            check("second tap → 200", r.status_code == 200, f"got {r.status_code}")

            print("4. duplicate re-post is idempotent")
            r = c.post(
                url,
                json=hik_payload(
                    employee_no=EMPLOYEE_CODE,
                    name="Harikrishnan",
                    serial=168,
                    when=t_in.isoformat(),
                ),
            )
            check("duplicate → 200", r.status_code == 200, f"got {r.status_code}")

            print("5. unknown person is held, not dropped")
            r = c.post(
                url,
                json=hik_payload(
                    employee_no="9931",
                    name="Nobody",
                    serial=173,
                    when=local(9, 2).isoformat(),
                ),
            )
            check("unknown person → 200", r.status_code == 200, f"got {r.status_code}")

            # Posted last on purpose: the device-level clock flag reflects
            # the most recent event, so a good event after this one would
            # (correctly) clear it.
            print("6. device with an unset clock (1970)")
            r = c.post(
                url,
                json=hik_payload(
                    employee_no=EMPLOYEE_CODE,
                    name="Harikrishnan",
                    serial=169,
                    when="1970-01-01T01:16:27+04:00",
                ),
            )
            check("1970 tap → 200", r.status_code == 200, f"got {r.status_code}")
    except httpx.HTTPError as exc:
        print(f"HTTP error talking to {BASE}: {exc}")
        return 2

    # --- verify what landed --------------------------------------------
    print("\n7. database state")
    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            evs = conn.execute(
                select(device_attendance_events).where(
                    device_attendance_events.c.tenant_id == scope.tenant_id,
                    device_attendance_events.c.device_id == device_id,
                )
            ).all()
            users = repo.list_device_users(conn, scope, device_id)
            dets = conn.execute(
                select(detection_events).where(
                    detection_events.c.tenant_id == scope.tenant_id,
                    detection_events.c.device_id == device_id,
                )
            ).all()
            dev = repo.get_device(conn, scope, device_id)

    serials = sorted(e.event_serial for e in evs)
    check(
        "4 taps stored, duplicate collapsed",
        len(evs) == 4,
        f"got {len(evs)} serials={serials}",
    )
    check(
        "1970 tap flagged clock_suspect",
        any(e.clock_suspect for e in evs),
        "no row flagged",
    )
    check(
        "1970 tap not booked in 1970",
        all(e.occurred_at.year >= 2020 for e in evs),
        f"years={[e.occurred_at.year for e in evs]}",
    )
    check(
        "2 people discovered from events",
        len(users) == 2,
        f"got {[u.device_user_id for u in users]}",
    )
    mapped = [u for u in users if u.employee_id is not None]
    unmapped = [u for u in users if u.employee_id is None]
    check("known code auto-mapped", len(mapped) == 1, f"got {len(mapped)}")
    check("unknown code left unmapped", len(unmapped) == 1, f"got {len(unmapped)}")
    check(
        "unknown person's tap held as skipped",
        any(e.status == "skipped" for e in evs),
        "nothing skipped",
    )
    check(
        "detection_events written with source=device",
        len(dets) >= 2 and all(d.source == "device" for d in dets),
        f"got {len(dets)}",
    )
    check(
        "camera_id is null on device rows",
        all(d.camera_id is None for d in dets),
        "a device row carries a camera_id",
    )
    check("device marked online", dev is not None and dev.health_status == "online")
    check("clock_suspect surfaced on device", dev is not None and dev.clock_suspect)
    check(
        "reported device_name captured",
        dev is not None and dev.reported_device_name == "smoke-entrance",
        f"got {dev.reported_device_name if dev else None}",
    )

    # Attendance for the specific local day the two real taps belong to.
    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            row = conn.execute(
                select(attendance_records).where(
                    attendance_records.c.tenant_id == scope.tenant_id,
                    attendance_records.c.employee_id == emp.id,
                    attendance_records.c.date == target_day,
                )
            ).first()
    check("attendance row produced for the tap day", row is not None)
    if row is not None:
        print(
            f"       → {row.date}  in={row.in_time} out={row.out_time} "
            f"total={row.total_minutes}min late={row.late}"
        )
        check(
            "in = first tap (08:15)",
            row.in_time is not None and row.in_time.hour == 8,
            f"got {row.in_time}",
        )
        check(
            "out = last tap (17:40), direction label ignored",
            row.out_time is not None and row.out_time.hour == 17,
            f"got {row.out_time}",
        )

    # --- replay on mapping ---------------------------------------------
    print("\n8. mapping the unknown person replays their held tap")
    if unmapped:
        duid = unmapped[0].device_user_id
        from maugood.devices import processor

        with tenant_context(scope.tenant_schema):
            with get_engine().begin() as conn:
                repo.map_device_user(
                    conn,
                    scope,
                    device_id=device_id,
                    device_user_id=duid,
                    employee_id=emp.id,
                )
        replayed = processor.replay_for_device_user(
            scope, device_id=device_id, device_user_id=duid, employee_id=emp.id
        )
        check("held tap replayed", replayed == 1, f"replayed={replayed}")

        with tenant_context(scope.tenant_schema):
            with get_engine().begin() as conn:
                still = conn.execute(
                    select(device_attendance_events.c.id).where(
                        device_attendance_events.c.tenant_id == scope.tenant_id,
                        device_attendance_events.c.device_id == device_id,
                        device_attendance_events.c.status == "skipped",
                    )
                ).all()
        check("nothing left skipped", len(still) == 0, f"{len(still)} still skipped")

    # --- cross-tenant isolation ----------------------------------------
    print("\n9. isolation: no other tenant sees this device's rows")
    with tenant_context("public"):
        with get_engine().begin() as conn:
            others = conn.execute(
                select(tenants.c.id, tenants.c.schema_name).where(
                    tenants.c.id != scope.tenant_id, tenants.c.status == "active"
                )
            ).all()
    leaked = 0
    for o in others:
        with tenant_context(str(o.schema_name)):
            with get_engine().begin() as conn:
                n = conn.execute(
                    select(device_attendance_events.c.id).where(
                        device_attendance_events.c.device_id == device_id
                    )
                ).all()
                leaked += len(n)
    check("zero rows visible in other tenants", leaked == 0, f"leaked={leaked}")

    # --- cleanup --------------------------------------------------------
    print("\n10. cleanup")
    with tenant_context(scope.tenant_schema):
        with get_engine().begin() as conn:
            conn.execute(
                delete(device_attendance_events).where(
                    device_attendance_events.c.device_id == device_id
                )
            )
            conn.execute(
                delete(device_users).where(device_users.c.device_id == device_id)
            )
            conn.execute(
                delete(detection_events).where(
                    detection_events.c.device_id == device_id
                )
            )
            repo.delete_device(conn, scope, device_id)
    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.delete_for_device(
                conn, tenant_id=scope.tenant_id, device_id=device_id
            )
    print("       smoke device removed")
    print(
        f"       NOTE: attendance rows for {EMPLOYEE_CODE} around {target_day} "
        "were left in place (the scheduler's next recompute settles them)"
    )

    print(f"\n{'=' * 52}\n  {_ok} passed, {_fail} failed\n{'=' * 52}")
    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
