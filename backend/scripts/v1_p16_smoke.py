"""End-to-end smoke for v1.0 P16 — Admin override.

Provisions Employee + Manager + HR + Admin on the ``main`` tenant,
walks Employee submit → Manager approve → HR reject → Admin
override (approve), and asserts:

  * the override comment min-length is enforced (9 chars → 422);
  * the audit row carries the previous decider + the verbatim
    comment;
  * notifications_queue has one row each for the original Manager,
    HR decider, and the employee.

Run inside the backend container:

    docker compose exec -e MAUGOOD_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p16_smoke
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
    audit_log,
    departments,
    employees,
    make_admin_engine,
    manager_assignments,
    notifications_queue,
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
    if not os.environ.get("MAUGOOD_SMOKE_PASSWORD"):
        print("[p16] set MAUGOOD_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p16.maugood"
    manager_email = f"mgr-{suffix}@p16.maugood"
    hr_email = f"hr-{suffix}@p16.maugood"
    admin_email = f"adm-{suffix}@p16.maugood"
    pwd = "P16Smoke!" + secrets.token_hex(4)

    admin_engine = make_admin_engine()
    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P16 Smoke Employee",
        department_codes=["ENG"],
    )
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P16 Manager",
        department_codes=["ENG"],
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P16 HR",
    )
    admin_uid = _make_user(
        admin_engine,
        email=admin_email,
        password=pwd,
        role_codes=["Admin"],
        full_name="P16 Admin",
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
                    employee_code=f"P16-{suffix}",
                    full_name="P16 Smoke Employee",
                    email=employee_email,
                    department_id=eng_dept,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            # 1) Employee submits, Manager approves, HR rejects.
            target = (date.today() - timedelta(days=2)).isoformat()
            c.post(
                "/api/auth/login",
                json={"email": employee_email, "password": pwd},
            ).raise_for_status()
            req = c.post(
                "/api/requests",
                json={
                    "type": "exception",
                    "reason_category": "Doctor",
                    "target_date_start": target,
                },
            )
            req.raise_for_status()
            rid = req.json()["id"]
            print(f"[p16] employee submitted request id={rid} target={target}")

            c.post("/api/auth/logout")
            c.post(
                "/api/auth/login",
                json={"email": manager_email, "password": pwd},
            ).raise_for_status()
            c.post(
                f"/api/requests/{rid}/manager-decide",
                json={"decision": "approve", "comment": ""},
            ).raise_for_status()
            print("[p16] manager approved")

            c.post("/api/auth/logout")
            c.post(
                "/api/auth/login",
                json={"email": hr_email, "password": pwd},
            ).raise_for_status()
            hr_resp = c.post(
                f"/api/requests/{rid}/hr-decide",
                json={"decision": "reject", "comment": "policy violation"},
            )
            hr_resp.raise_for_status()
            print(
                f"[p16] HR rejected → status={hr_resp.json()['status']}"
            )

            # 2) Admin tries a 9-char comment — 422.
            c.post("/api/auth/logout")
            c.post(
                "/api/auth/login",
                json={"email": admin_email, "password": pwd},
            ).raise_for_status()
            short = c.post(
                f"/api/requests/{rid}/admin-override",
                json={"decision": "approve", "comment": "too short"},
            )
            assert short.status_code == 422, short.text
            print(
                f"[p16] short comment rejected with {short.status_code} "
                f"({short.json()['detail'][0]['msg']})"
            )

            # 3) Admin overrides with a real comment.
            verbatim_comment = (
                "Override per BRD §FR-REQ-006: HR re-evaluated the "
                "doctor's note in light of the policy update; the "
                "exception stands."
            )
            over = c.post(
                f"/api/requests/{rid}/admin-override",
                json={"decision": "approve", "comment": verbatim_comment},
            )
            over.raise_for_status()
            print(
                f"[p16] admin override → status={over.json()['status']}"
            )
            assert over.json()["status"] == "admin_approved"

            # 4) Audit row + queue rows in DB.
            with admin_engine.begin() as conn:
                audit = conn.execute(
                    select(
                        audit_log.c.action,
                        audit_log.c.before,
                        audit_log.c.after,
                    ).where(
                        audit_log.c.entity_type == "request",
                        audit_log.c.entity_id == str(rid),
                        audit_log.c.action == "request.admin.approve",
                    )
                ).first()
                queue_rows = conn.execute(
                    select(
                        notifications_queue.c.kind,
                        notifications_queue.c.recipient_user_id,
                        notifications_queue.c.payload,
                    ).where(
                        notifications_queue.c.tenant_id == TENANT_ID,
                        notifications_queue.c.request_id == rid,
                    )
                ).all()
            assert audit is not None
            assert audit.before["previous_stage"] == "hr"
            assert audit.before["previous_decider_user_id"] == hr_uid
            assert audit.after["comment"] == verbatim_comment
            print(
                f"[p16] audit row: previous_stage="
                f"{audit.before['previous_stage']!r} "
                f"previous_decider={audit.before['previous_decider_user_id']} "
                f"comment_kept_verbatim={audit.after['comment'] == verbatim_comment}"
            )
            kinds = sorted(r.kind for r in queue_rows)
            assert kinds == [
                "override.employee_notified",
                "override.hr_notified",
                "override.manager_notified",
            ], kinds
            print(
                f"[p16] notifications_queue rows: {kinds} "
                f"(employee_email_in_payload="
                f"{any(r.payload.get('recipient_email') == employee_email.lower() for r in queue_rows if r.kind == 'override.employee_notified')})"
            )

        print("[p16] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p16] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(notifications_queue).where(
                    notifications_queue.c.tenant_id == TENANT_ID
                )
            )
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
            from maugood.db import attendance_records  # noqa: PLC0415

            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(delete(employees).where(employees.c.id == emp_id))
        for uid in (employee_uid, manager_uid, hr_uid, admin_uid):
            _cleanup_user(admin_engine, uid)
        admin_engine.dispose()
        print("[p16] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
