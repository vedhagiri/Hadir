"""End-to-end smoke for v1.0 P13 — request state machine.

Walks the full happy path (Employee → Manager approve → HR approve)
plus both rejection paths (manager reject; HR reject) and an
admin-override against the live stack on the ``main`` (pilot) tenant.

Pre-requisites:

* The ``main`` schema is at head; provisions a fresh Employee +
  Manager + HR + Admin user with non-reserved TLDs (Pydantic
  EmailStr rejects ``.test``).
* ``MAUGOOD_SMOKE_PASSWORD`` must equal the seeded pilot Admin password.

Run inside the backend container:

    docker compose exec -e MAUGOOD_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p13_smoke
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import date, timedelta

import httpx
from sqlalchemy import delete, insert, select

from maugood.auth.passwords import hash_password
from maugood.db import (
    approved_leaves,
    attendance_records,
    audit_log,
    departments,
    employees,
    leave_types,
    make_admin_engine,
    manager_assignments,
    requests as requests_table,
    roles,
    user_roles,
    user_sessions,
    users,
)


BASE = "http://localhost:8000"
TENANT_ID = 1


def _provision_user(
    engine, *, email: str, password: str, role_codes: list[str], full_name: str
) -> int:
    pwh = hash_password(password)
    with engine.begin() as conn:
        uid = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name=full_name,
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        for code in role_codes:
            rid = conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == TENANT_ID, roles.c.code == code
                )
            ).scalar_one()
            conn.execute(
                insert(user_roles).values(
                    user_id=uid, role_id=int(rid), tenant_id=TENANT_ID
                )
            )
    return uid


def _cleanup_user(engine, user_id: int) -> None:
    with engine.begin() as conn:
        conn.execute(
            delete(user_sessions).where(user_sessions.c.user_id == user_id)
        )
        conn.execute(
            delete(audit_log).where(audit_log.c.actor_user_id == user_id)
        )
        conn.execute(
            delete(user_roles).where(user_roles.c.user_id == user_id)
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == user_id
            )
        )
        conn.execute(delete(users).where(users.c.id == user_id))


def main() -> int:
    if not os.environ.get("MAUGOOD_SMOKE_PASSWORD"):
        print("[p13] set MAUGOOD_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p13.maugood"
    manager_email = f"mgr-{suffix}@p13.maugood"
    hr_email = f"hr-{suffix}@p13.maugood"
    admin_email = f"adm-{suffix}@p13.maugood"
    pwd = "P13Smoke!" + secrets.token_hex(4)

    admin_engine = make_admin_engine()

    employee_uid = _provision_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P13 Smoke Employee",
    )
    manager_uid = _provision_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P13 Smoke Manager",
    )
    hr_uid = _provision_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P13 Smoke HR",
    )
    admin_uid = _provision_user(
        admin_engine,
        email=admin_email,
        password=pwd,
        role_codes=["Admin"],
        full_name="P13 Smoke Admin",
    )

    # employees row + manager_assignment + leave type id
    with admin_engine.begin() as conn:
        eng_dept = conn.execute(
            select(departments.c.id).where(
                departments.c.tenant_id == TENANT_ID,
                departments.c.code == "ENG",
            )
        ).scalar_one()
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P13-{suffix}",
                    full_name="P13 Smoke Employee",
                    email=employee_email,
                    department_id=int(eng_dept),
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        conn.execute(
            insert(manager_assignments).values(
                tenant_id=TENANT_ID,
                manager_user_id=manager_uid,
                employee_id=emp_id,
                is_primary=True,
            )
        )
        leave_type_id = int(
            conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == TENANT_ID,
                    leave_types.c.code == "Annual",
                )
            ).scalar_one()
        )

    today = date.today()
    happy_start = today + timedelta(days=7)
    happy_end = today + timedelta(days=9)

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            # ---- HAPPY PATH (leave) -----------------------------------
            login = c.post(
                "/api/auth/login",
                json={"email": employee_email, "password": pwd},
            )
            login.raise_for_status()
            create = c.post(
                "/api/requests",
                json={
                    "type": "leave",
                    "reason_category": "Annual",
                    "reason_text": "Family trip",
                    "target_date_start": happy_start.isoformat(),
                    "target_date_end": happy_end.isoformat(),
                    "leave_type_id": leave_type_id,
                },
            )
            create.raise_for_status()
            req = create.json()
            print(
                f"[p13] HAPPY: employee submitted request id={req['id']} "
                f"manager_user_id={req['manager_user_id']} "
                f"status={req['status']}"
            )
            assert req["status"] == "submitted"
            assert req["manager_user_id"] == manager_uid
            req_id = req["id"]

            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": manager_email, "password": pwd}).raise_for_status()
            mgr = c.post(
                f"/api/requests/{req_id}/manager-decide",
                json={"decision": "approve", "comment": "OK"},
            )
            mgr.raise_for_status()
            print(f"[p13] HAPPY: manager-decide approve → {mgr.json()['status']}")

            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": hr_email, "password": pwd}).raise_for_status()
            hr = c.post(
                f"/api/requests/{req_id}/hr-decide",
                json={"decision": "approve", "comment": "approved"},
            )
            hr.raise_for_status()
            print(f"[p13] HAPPY: hr-decide approve → {hr.json()['status']}")
            assert hr.json()["status"] == "hr_approved"

            # Side effects: approved_leaves row + attendance recompute pass.
            with admin_engine.begin() as conn:
                lr = conn.execute(
                    select(
                        approved_leaves.c.id,
                        approved_leaves.c.start_date,
                        approved_leaves.c.end_date,
                        approved_leaves.c.leave_type_id,
                    ).where(
                        approved_leaves.c.tenant_id == TENANT_ID,
                        approved_leaves.c.employee_id == emp_id,
                    )
                ).all()
            assert len(lr) == 1, lr
            assert str(lr[0].start_date) == happy_start.isoformat()
            assert str(lr[0].end_date) == happy_end.isoformat()
            print(
                f"[p13] HAPPY: approved_leaves row exists "
                f"id={lr[0].id} start={lr[0].start_date} end={lr[0].end_date}"
            )

            # Attendance recompute should have written rows for each day.
            with admin_engine.begin() as conn:
                attn = conn.execute(
                    select(
                        attendance_records.c.date,
                        attendance_records.c.absent,
                        attendance_records.c.leave_type_id,
                    ).where(
                        attendance_records.c.tenant_id == TENANT_ID,
                        attendance_records.c.employee_id == emp_id,
                    )
                ).all()
            covered_dates = {str(r.date) for r in attn}
            print(
                f"[p13] HAPPY: attendance rows after approval: "
                f"{sorted(covered_dates)}"
            )
            for r in attn:
                if str(r.date) in (
                    happy_start.isoformat(),
                    happy_end.isoformat(),
                ):
                    print(
                        f"        {r.date}: absent={r.absent} "
                        f"leave_type_id={r.leave_type_id}"
                    )

            # ---- MANAGER REJECTION (terminal) -------------------------
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": employee_email, "password": pwd}).raise_for_status()
            create2 = c.post(
                "/api/requests",
                json={
                    "type": "exception",
                    "reason_category": "Forgot to badge",
                    "target_date_start": (today - timedelta(days=2)).isoformat(),
                },
            )
            create2.raise_for_status()
            rid2 = create2.json()["id"]

            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": manager_email, "password": pwd}).raise_for_status()
            r2 = c.post(
                f"/api/requests/{rid2}/manager-decide",
                json={"decision": "reject", "comment": "no proof"},
            )
            r2.raise_for_status()
            print(f"[p13] MGR-REJECT: status={r2.json()['status']} (terminal)")
            assert r2.json()["status"] == "manager_rejected"

            # HR-decide on the rejected row → 409
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": hr_email, "password": pwd}).raise_for_status()
            blocked = c.post(
                f"/api/requests/{rid2}/hr-decide",
                json={"decision": "approve", "comment": "try"},
            )
            assert blocked.status_code == 409
            print(f"[p13] MGR-REJECT: HR-decide blocked with 409 — '{blocked.json()['detail']}'")

            # ---- HR REJECTION (terminal) ------------------------------
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": employee_email, "password": pwd}).raise_for_status()
            rid3 = c.post(
                "/api/requests",
                json={
                    "type": "exception",
                    "reason_category": "Lateness",
                    "target_date_start": (today - timedelta(days=3)).isoformat(),
                },
            ).json()["id"]
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": manager_email, "password": pwd}).raise_for_status()
            c.post(
                f"/api/requests/{rid3}/manager-decide",
                json={"decision": "approve", "comment": ""},
            ).raise_for_status()
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": hr_email, "password": pwd}).raise_for_status()
            r3 = c.post(
                f"/api/requests/{rid3}/hr-decide",
                json={"decision": "reject", "comment": "policy violation"},
            )
            r3.raise_for_status()
            print(f"[p13] HR-REJECT: status={r3.json()['status']} (terminal)")
            assert r3.json()["status"] == "hr_rejected"

            # ---- ADMIN OVERRIDE (mandatory comment) -------------------
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": admin_email, "password": pwd}).raise_for_status()
            empty = c.post(
                f"/api/requests/{rid3}/admin-override",
                json={"decision": "approve", "comment": ""},
            )
            assert empty.status_code == 422, empty.text
            print(f"[p13] ADMIN-OVERRIDE: empty comment rejected with {empty.status_code}")
            over = c.post(
                f"/api/requests/{rid3}/admin-override",
                json={
                    "decision": "approve",
                    "comment": "Admin override per BRD §FR-REQ-006",
                },
            )
            over.raise_for_status()
            print(f"[p13] ADMIN-OVERRIDE: status={over.json()['status']} (terminal HR row was overridden)")
            assert over.json()["status"] == "admin_approved"

        print("[p13] OK")
    except AssertionError as exc:
        print(f"[p13] FAIL — {exc}", file=sys.stderr)
        rc = 1
    except httpx.HTTPStatusError as exc:
        print(
            f"[p13] HTTP error: {exc.response.status_code} {exc.response.text}",
            file=sys.stderr,
        )
        rc = 1
    finally:
        # Cleanup so re-running starts fresh.
        with admin_engine.begin() as conn:
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(requests_table).where(
                    requests_table.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(audit_log).where(
                    audit_log.c.entity_type == "request",
                )
            )
            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(employees).where(employees.c.id == emp_id)
            )
        for uid in (employee_uid, manager_uid, hr_uid, admin_uid):
            _cleanup_user(admin_engine, uid)
        admin_engine.dispose()
        print("[p13] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
