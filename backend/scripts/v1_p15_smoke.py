"""End-to-end smoke for v1.0 P15 — approvals inbox.

Walks the prompt's verification scenario: a Manager approves a
request and within seconds it shows up in HR's pending queue, while
the Manager's pending count drops and "decided by me" picks it up.
Exercises the wider P8-derived manager scope (department-only
manager) and confirms the inbox-summary badge counts move.

Run inside the backend container:

    docker compose exec -e HADIR_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p15_smoke
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import date, timedelta

import httpx
from sqlalchemy import delete, insert, select

from hadir.auth.passwords import hash_password
from hadir.db import (
    approved_leaves,
    audit_log,
    departments,
    employees,
    make_admin_engine,
    manager_assignments,
    request_attachments,
    requests as requests_table,
    roles,
    user_departments,
    user_roles,
    user_sessions,
    users,
)


BASE = "http://localhost:8000"
TENANT_ID = 1


def _make_user(
    engine,
    *,
    email,
    password,
    role_codes,
    full_name,
    department_codes=None,
):
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
        if department_codes:
            for d in department_codes:
                dept_id = int(
                    conn.execute(
                        select(departments.c.id).where(
                            departments.c.tenant_id == TENANT_ID,
                            departments.c.code == d,
                        )
                    ).scalar_one()
                )
                conn.execute(
                    insert(user_departments).values(
                        user_id=uid,
                        department_id=dept_id,
                        tenant_id=TENANT_ID,
                    )
                )
    return uid


def _cleanup_user(engine, user_id):
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
            delete(user_departments).where(
                user_departments.c.user_id == user_id
            )
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == user_id
            )
        )
        conn.execute(delete(users).where(users.c.id == user_id))


def main() -> int:
    if not os.environ.get("HADIR_SMOKE_PASSWORD"):
        print("[p15] set HADIR_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p15.hadir"
    manager_email = f"mgr-{suffix}@p15.hadir"
    hr_email = f"hr-{suffix}@p15.hadir"
    pwd = "P15Smoke!" + secrets.token_hex(4)

    admin_engine = make_admin_engine()

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P15 Smoke Employee",
        department_codes=["ENG"],
    )
    # Department-only manager (no manager_assignments row) — proves
    # the P15 widened scope.
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P15 ENG Manager",
        department_codes=["ENG"],
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P15 HR",
    )

    with admin_engine.begin() as conn:
        eng_dept = int(
            conn.execute(
                select(departments.c.id).where(
                    departments.c.tenant_id == TENANT_ID,
                    departments.c.code == "ENG",
                )
            ).scalar_one()
        )
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P15-{suffix}",
                    full_name="P15 Smoke Employee",
                    email=employee_email,
                    department_id=eng_dept,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            # Employee submits.
            login = c.post(
                "/api/auth/login",
                json={"email": employee_email, "password": pwd},
            )
            login.raise_for_status()
            target = (date.today() - timedelta(days=1)).isoformat()
            create = c.post(
                "/api/requests",
                json={
                    "type": "exception",
                    "reason_category": "Doctor",
                    "target_date_start": target,
                },
            )
            create.raise_for_status()
            rid = create.json()["id"]
            print(
                f"[p15] employee submitted request id={rid} "
                f"(department-only manager — no manager_assignments row)"
            )

            # Manager — initial pending count + summary badge.
            c.post("/api/auth/logout")
            c.post(
                "/api/auth/login",
                json={"email": manager_email, "password": pwd},
            ).raise_for_status()
            mgr_summary_before = c.get("/api/requests/inbox/summary").json()
            mgr_pending_before = c.get("/api/requests/inbox/pending").json()
            print(
                f"[p15] manager BEFORE: pending_count="
                f"{mgr_summary_before['pending_count']} "
                f"breached={mgr_summary_before['breached_count']}"
            )
            assert any(r["id"] == rid for r in mgr_pending_before), (
                "request should appear in the manager's pending queue "
                "via department membership"
            )

            decide = c.post(
                f"/api/requests/{rid}/manager-decide",
                json={"decision": "approve", "comment": "OK"},
            )
            decide.raise_for_status()
            print(f"[p15] manager approved → status={decide.json()['status']}")

            mgr_summary_after = c.get("/api/requests/inbox/summary").json()
            mgr_pending_after = c.get("/api/requests/inbox/pending").json()
            mgr_decided = c.get("/api/requests/inbox/decided").json()
            print(
                f"[p15] manager AFTER:  pending_count="
                f"{mgr_summary_after['pending_count']} "
                f"decided_by_me={len(mgr_decided)}"
            )
            assert all(r["id"] != rid for r in mgr_pending_after)
            assert any(r["id"] == rid for r in mgr_decided)

            # HR queue should now contain the approved request.
            c.post("/api/auth/logout")
            c.post(
                "/api/auth/login",
                json={"email": hr_email, "password": pwd},
            ).raise_for_status()
            hr_summary = c.get("/api/requests/inbox/summary").json()
            hr_pending = c.get("/api/requests/inbox/pending").json()
            print(
                f"[p15] HR pending_count={hr_summary['pending_count']} "
                f"breached={hr_summary['breached_count']}"
            )
            assert any(r["id"] == rid for r in hr_pending), (
                "manager-approved request should arrive in HR's pending queue"
            )
            row = next(r for r in hr_pending if r["id"] == rid)
            print(
                f"[p15] HR view of #{rid}: status={row['status']} "
                f"attachments={row['attachment_count']} "
                f"business_hours_open={row['business_hours_open']:.1f} "
                f"sla_breached={row['sla_breached']}"
            )

        print("[p15] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p15] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(request_attachments).where(
                    request_attachments.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(requests_table).where(
                    requests_table.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(audit_log).where(audit_log.c.entity_type == "request")
            )
            from hadir.db import attendance_records  # noqa: PLC0415

            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(delete(employees).where(employees.c.id == emp_id))
        for uid in (employee_uid, manager_uid, hr_uid):
            _cleanup_user(admin_engine, uid)
        admin_engine.dispose()
        print("[p15] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
