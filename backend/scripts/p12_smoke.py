"""Live smoke for P12 dashboards + Daily Attendance page.

Seeds two employees in two departments (ENG and OPS), one camera, a
handful of detection events at realistic times, and runs the
attendance recompute. Prints the relevant endpoint responses so an
operator (or this assistant) can verify the page numbers without
opening a browser.

Run inside the backend container:
    docker compose exec backend python -m scripts.p12_smoke
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import delete, insert, select

from hadir.attendance import repository as attendance_repo
from hadir.attendance.scheduler import recompute_today
from hadir.cameras import rtsp as rtsp_io
from hadir.config import get_settings
from hadir.db import (
    attendance_records,
    cameras,
    detection_events,
    employees,
    employee_photos,
    make_admin_engine,
)
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope


def main() -> int:
    admin = make_admin_engine()
    scope = TenantScope(tenant_id=1)

    with admin.begin() as conn:
        conn.execute(delete(attendance_records).where(attendance_records.c.tenant_id == 1))
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))

    tz = ZoneInfo(get_settings().local_timezone)
    today = datetime.now(timezone.utc).astimezone(tz).date()

    def at(h: int, m: int, s: int = 0) -> datetime:
        local_dt = datetime.combine(today, time(h, m, s), tzinfo=tz)
        return local_dt.astimezone(timezone.utc)

    with admin.begin() as conn:
        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="P12-cam",
                location="HQ Lobby",
                rtsp_url_encrypted=rtsp_io.encrypt_url("rtsp://fake/p12"),
                enabled=False,
            )
            .returning(cameras.c.id)
        ).scalar_one()

        eng_emp = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="OM0501",
                full_name="Tariq Al-Shukaili",
                email="tariq@p12.example",
                department_id=1,  # ENG
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        ops_emp = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="OM0502",
                full_name="Fatima Al-Kindi",
                email="fatima@p12.example",
                department_id=2,  # OPS
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()

        # ENG: on-time + slight overtime
        for h, m, t in ((7, 28, "t-eng-1"), (12, 5, "t-eng-2"), (15, 36, "t-eng-3")):
            conn.execute(
                insert(detection_events).values(
                    tenant_id=1,
                    camera_id=cam_id,
                    captured_at=at(h, m),
                    bbox={"x": 0, "y": 0, "w": 50, "h": 50},
                    face_crop_path="/dev/null",
                    employee_id=eng_emp,
                    confidence=0.94,
                    track_id=t,
                )
            )
        # OPS: late arrival + early out → both flags
        for h, m, t in ((7, 50, "t-ops-1"), (15, 5, "t-ops-2")):
            conn.execute(
                insert(detection_events).values(
                    tenant_id=1,
                    camera_id=cam_id,
                    captured_at=at(h, m),
                    bbox={"x": 0, "y": 0, "w": 50, "h": 50},
                    face_crop_path="/dev/null",
                    employee_id=ops_emp,
                    confidence=0.89,
                    track_id=t,
                )
            )

    matcher_cache.invalidate_all()
    upserted = recompute_today(scope)
    print(f"recompute_today upserted={upserted} rows")

    with admin.begin() as conn:
        rows = conn.execute(
            select(
                attendance_records.c.employee_id,
                attendance_records.c.in_time,
                attendance_records.c.out_time,
                attendance_records.c.late,
                attendance_records.c.early_out,
                attendance_records.c.short_hours,
                attendance_records.c.absent,
                attendance_records.c.overtime_minutes,
            ).where(attendance_records.c.tenant_id == 1)
        ).all()
    for r in rows:
        print(
            f"  emp={r.employee_id} in={r.in_time} out={r.out_time} "
            f"late={r.late} early_out={r.early_out} short={r.short_hours} "
            f"absent={r.absent} ot_min={r.overtime_minutes}"
        )

    # Note: the seeded data persists for the live walkthrough; the
    # operator can clean up by re-running this script with the cleanup
    # block commented in, or by `python -m scripts.p10_smoke` (which
    # also wipes attendance + events).
    print("seed data is left in place — run scripts.p10_smoke or wipe manually to clean.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
