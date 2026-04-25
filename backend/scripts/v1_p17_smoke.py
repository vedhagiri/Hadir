"""End-to-end smoke for v1.0 P17 — PDF attendance reports.

Mirrors the prompt's verification scenario: render a PDF for the
``main`` (Omran) tenant in its default teal branding, swap it to
navy, render again, and assert the rendered hex bytes change. Then
flip back so the suite leaves no trace.

Run inside the backend container:

    docker compose exec -e HADIR_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p17_smoke
"""

from __future__ import annotations

import os
import sys
from datetime import date, time, timedelta

import httpx
from sqlalchemy import delete, insert, select, update

from hadir.db import (
    attendance_records,
    employees,
    make_admin_engine,
    shift_policies,
    tenant_branding,
)


BASE = "http://localhost:8000"
TENANT_ID = 1


def main() -> int:
    if not os.environ.get("HADIR_SMOKE_PASSWORD"):
        print("[p17] set HADIR_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    admin_engine = make_admin_engine()
    today = date.today()

    # Seed two synthetic employees + a few attendance rows so the
    # report has something to render. We use distinct codes that
    # won't clash with the live pilot data.
    seed_codes = ("P17-A", "P17-B")
    with admin_engine.begin() as conn:
        # Avoid colliding with anything left from a previous run.
        for code in seed_codes:
            existing = conn.execute(
                select(employees.c.id).where(
                    employees.c.tenant_id == TENANT_ID,
                    employees.c.employee_code == code,
                )
            ).first()
            if existing is not None:
                conn.execute(
                    delete(attendance_records).where(
                        attendance_records.c.employee_id == int(existing.id)
                    )
                )
                conn.execute(
                    delete(employees).where(employees.c.id == int(existing.id))
                )

        a_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P17-A",
                    full_name="P17 Smoke Alice",
                    email="alice@p17.hadir",
                    department_id=1,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        b_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P17-B",
                    full_name="P17 Smoke Bob",
                    email="bob@p17.hadir",
                    department_id=2,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )

        policy_id = int(
            conn.execute(
                select(shift_policies.c.id)
                .where(shift_policies.c.tenant_id == TENANT_ID)
                .order_by(shift_policies.c.id.asc())
                .limit(1)
            ).scalar_one()
        )

        for emp_id, the_date, in_t, out_t, late, ot in (
            (a_id, today,                 time(7, 28), time(15, 36), False, 8),
            (a_id, today - timedelta(days=1), time(7, 31), time(15, 30), False, 0),
            (b_id, today,                 time(7, 50), time(15, 5),  True, 0),
        ):
            total = (out_t.hour * 60 + out_t.minute) - (in_t.hour * 60 + in_t.minute)
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    date=the_date,
                    in_time=in_t,
                    out_time=out_t,
                    total_minutes=total,
                    policy_id=policy_id,
                    late=late,
                    early_out=False,
                    short_hours=total < 480,
                    absent=False,
                    overtime_minutes=ot,
                )
            )

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            login = c.post(
                "/api/auth/login",
                json={
                    "email": "admin@pilot.hadir",
                    "password": os.environ["HADIR_SMOKE_PASSWORD"],
                },
            )
            login.raise_for_status()

            body = {
                "start": (today - timedelta(days=1)).isoformat(),
                "end": today.isoformat(),
            }

            # 1) Default (teal) branding.
            with admin_engine.begin() as conn:
                conn.execute(
                    update(tenant_branding)
                    .where(tenant_branding.c.tenant_id == TENANT_ID)
                    .values(primary_color_key="teal")
                )
            teal = c.post("/api/reports/attendance.pdf", json=body)
            teal.raise_for_status()
            assert teal.content.startswith(b"%PDF-")
            print(
                f"[p17] teal render: {len(teal.content)}B  "
                f"filename={teal.headers['content-disposition']}"
            )
            assert "hadir-attendance-main-" in teal.headers["content-disposition"]

            # 2) Swap to navy and re-render.
            with admin_engine.begin() as conn:
                conn.execute(
                    update(tenant_branding)
                    .where(tenant_branding.c.tenant_id == TENANT_ID)
                    .values(primary_color_key="navy")
                )
            navy = c.post("/api/reports/attendance.pdf", json=body)
            navy.raise_for_status()
            assert navy.content.startswith(b"%PDF-")
            print(f"[p17] navy render: {len(navy.content)}B")

            # 3) Bytes should differ — different accent hex propagates
            # to the rendered content stream.
            assert teal.content != navy.content, (
                "expected branding swap to change PDF bytes"
            )
            print("[p17] PDF bytes differ between teal and navy — branding applied")

            # 4) Excel still works (additive — don't regress P13).
            xlsx = c.post("/api/reports/attendance.xlsx", json=body)
            xlsx.raise_for_status()
            assert xlsx.content[:2] == b"PK"
            print(f"[p17] xlsx still works: {len(xlsx.content)}B")

        print("[p17] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p17] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        with admin_engine.begin() as conn:
            # Restore default branding so the live UI keeps the
            # operator's choice intact.
            conn.execute(
                update(tenant_branding)
                .where(tenant_branding.c.tenant_id == TENANT_ID)
                .values(primary_color_key="teal")
            )
            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id.in_([a_id, b_id])
                )
            )
            conn.execute(
                delete(employees).where(employees.c.id.in_([a_id, b_id]))
            )
        admin_engine.dispose()
        print("[p17] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
