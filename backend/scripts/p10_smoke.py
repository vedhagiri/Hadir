"""Live smoke for P10 attendance.

Seeds one employee + a camera, inserts three detection_events spread
across the working day (in-time, midday, out-time) timestamped in UTC
so the scheduler's local-timezone conversion gets exercised, runs
``recompute_today``, and prints the resulting ``attendance_records``
row. Cleans up after itself.

Run inside the backend container:
    docker compose exec backend python -m scripts.p10_smoke
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import delete, insert, select

from maugood.attendance import repository as attendance_repo
from maugood.attendance.scheduler import recompute_today
from maugood.cameras import rtsp as rtsp_io
from maugood.config import get_settings
from maugood.db import (
    attendance_records,
    cameras,
    detection_events,
    employees,
    make_admin_engine,
)
from maugood.tenants.scope import TenantScope


def main() -> int:
    admin = make_admin_engine()
    scope = TenantScope(tenant_id=1)

    # Tidy any leftover smoke state.
    with admin.begin() as conn:
        conn.execute(delete(attendance_records).where(attendance_records.c.tenant_id == 1))
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))

    tz = ZoneInfo(get_settings().local_timezone)
    today_local = datetime.now(timezone.utc).astimezone(tz).date()

    def local_at(h: int, m: int, s: int = 0) -> datetime:
        """Build a UTC timestamp whose local wall-clock is (h:m:s) today."""

        local_dt = datetime.combine(today_local, time(h, m, s), tzinfo=tz)
        return local_dt.astimezone(timezone.utc)

    with admin.begin() as conn:
        emp_id = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="SMOKE-10",
                full_name="Smoke Ten",
                email=None,
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="P10-smoke-cam",
                location="",
                rtsp_url_encrypted=rtsp_io.encrypt_url("rtsp://fake/p10"),
                enabled=False,
            )
            .returning(cameras.c.id)
        ).scalar_one()

        # Three events: on-time arrival, midday, on-time departure.
        for captured_at, track in (
            (local_at(7, 28, 42), "t1"),
            (local_at(12, 5, 11), "t2"),
            (local_at(15, 34, 12), "t3"),
        ):
            conn.execute(
                insert(detection_events).values(
                    tenant_id=1,
                    camera_id=cam_id,
                    captured_at=captured_at,
                    bbox={"x": 0, "y": 0, "w": 10, "h": 10},
                    face_crop_path="/dev/null",
                    embedding=None,
                    employee_id=emp_id,
                    confidence=0.93,
                    track_id=track,
                )
            )

    upserted = recompute_today(scope)
    print(f"recompute_today upserted={upserted} employees for {today_local}")

    with admin.begin() as conn:
        row = conn.execute(
            select(
                attendance_records.c.id,
                attendance_records.c.employee_id,
                attendance_records.c.date,
                attendance_records.c.in_time,
                attendance_records.c.out_time,
                attendance_records.c.total_minutes,
                attendance_records.c.late,
                attendance_records.c.early_out,
                attendance_records.c.short_hours,
                attendance_records.c.absent,
                attendance_records.c.overtime_minutes,
                attendance_records.c.policy_id,
            ).where(attendance_records.c.employee_id == emp_id)
        ).one()

    print(
        f"attendance: emp={row.employee_id} date={row.date} "
        f"in={row.in_time} out={row.out_time} "
        f"total_minutes={row.total_minutes} late={row.late} "
        f"early_out={row.early_out} short_hours={row.short_hours} "
        f"absent={row.absent} overtime={row.overtime_minutes} "
        f"policy_id={row.policy_id}"
    )

    # Now simulate an early-out by re-recomputing with the out_time
    # shifted; this proves the 15-min scheduler's upsert path flips the
    # row in place rather than creating a new one.
    with admin.begin() as conn:
        conn.execute(
            delete(detection_events).where(
                detection_events.c.employee_id == emp_id,
                detection_events.c.track_id == "t3",
            )
        )
        conn.execute(
            insert(detection_events).values(
                tenant_id=1,
                camera_id=cam_id,
                captured_at=local_at(15, 10, 0),  # before 15:15 → early_out
                bbox={"x": 0, "y": 0, "w": 10, "h": 10},
                face_crop_path="/dev/null",
                embedding=None,
                employee_id=emp_id,
                confidence=0.91,
                track_id="t3b",
            )
        )
    recompute_today(scope)

    with admin.begin() as conn:
        row2 = conn.execute(
            select(
                attendance_records.c.id,
                attendance_records.c.out_time,
                attendance_records.c.early_out,
                attendance_records.c.short_hours,
            ).where(attendance_records.c.employee_id == emp_id)
        ).one()
    print(
        f"after early-out recompute: same row id? {row.id == row2.id} "
        f"out_time={row2.out_time} early_out={row2.early_out} "
        f"short_hours={row2.short_hours}"
    )

    # Cleanup.
    with admin.begin() as conn:
        conn.execute(delete(attendance_records).where(attendance_records.c.tenant_id == 1))
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
    print("smoke cleaned up")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
