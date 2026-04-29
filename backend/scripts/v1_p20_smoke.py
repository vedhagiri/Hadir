"""End-to-end smoke for v1.0 P20 — notifications.

Walks the prompt's verification scenarios:

  1. Approve a request end-to-end (Manager + HR) and confirm the
     Employee gets BOTH an in-app row (in ``notifications``) and an
     email (captured via the file recorder).
  2. Trigger an overtime flag and confirm the Manager gets an email.

The smoke runs in-process so the file-recorder env reaches the same
Python process building messages.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from datetime import date, time, timedelta
from pathlib import Path

from sqlalchemy import delete, insert, select, update

from maugood.attendance.engine import AttendanceRecord
from maugood.attendance import repository as attendance_repo
from maugood.attendance.scheduler import _maybe_notify_overtime
from maugood.auth.passwords import hash_password
from maugood.db import (
    attendance_records,
    audit_log,
    departments,
    email_config,
    employees,
    make_admin_engine,
    manager_assignments,
    notification_preferences,
    notifications,
    requests as requests_table,
    roles,
    shift_policies,
    user_roles,
    user_sessions,
    users,
)
from maugood.notifications.repository import list_for_user
from maugood.notifications.worker import drain_one_tenant
from maugood.notifications.producer import (
    notify_approval_assigned,
    notify_approval_decided,
    notify_overtime_flagged,
)
from maugood.tenants.scope import TenantScope


TENANT_ID = 1


def _make_user(
    engine, *, email, password, role_codes, full_name
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
            rid = int(
                conn.execute(
                    select(roles.c.id).where(
                        roles.c.tenant_id == TENANT_ID, roles.c.code == code
                    )
                ).scalar_one()
            )
            conn.execute(
                insert(user_roles).values(
                    user_id=uid, role_id=rid, tenant_id=TENANT_ID
                )
            )
    return uid


def _cleanup_user(engine, uid):
    with engine.begin() as conn:
        conn.execute(
            delete(notification_preferences).where(
                notification_preferences.c.user_id == uid
            )
        )
        conn.execute(
            delete(notifications).where(notifications.c.user_id == uid)
        )
        conn.execute(
            delete(user_sessions).where(user_sessions.c.user_id == uid)
        )
        conn.execute(
            delete(user_roles).where(user_roles.c.user_id == uid)
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == uid
            )
        )
        conn.execute(delete(users).where(users.c.id == uid))


def main() -> int:
    recorder_path = os.environ.get(
        "MAUGOOD_EMAIL_RECORDER_PATH", "/tmp/maugood-p20-recorder.jsonl"
    )
    Path(recorder_path).unlink(missing_ok=True)
    os.environ["MAUGOOD_EMAIL_RECORDER_PATH"] = recorder_path

    suffix = secrets.token_hex(3)
    employee_email = f"emp-{suffix}@p20.maugood"
    manager_email = f"mgr-{suffix}@p20.maugood"
    hr_email = f"hr-{suffix}@p20.maugood"
    pwd = "p20-smoke-" + secrets.token_hex(4)

    admin_engine = make_admin_engine()

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P20 Smoke Employee",
    )
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P20 Smoke Manager",
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P20 Smoke HR",
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
                    employee_code=f"P20-{suffix}",
                    full_name="P20 Smoke Employee",
                    email=employee_email,
                    department_id=eng_dept,
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
        # Enable email so the worker doesn't skip the tenant.
        conn.execute(
            update(email_config)
            .where(email_config.c.tenant_id == TENANT_ID)
            .values(
                provider="smtp",
                smtp_host="smtp.test.example",
                smtp_password_encrypted=None,
                from_address="noreply@test.example",
                from_name="Maugood",
                enabled=True,
            )
        )

    rc = 0
    scope = TenantScope(tenant_id=TENANT_ID)
    try:
        # 1) Direct producer call: simulate "manager_approved → HR
        # decides approve" workflow's terminal step. We use the
        # producers directly rather than the HTTP API so the
        # in-process file recorder catches the email.
        with admin_engine.begin() as conn:
            notify_approval_assigned(
                conn,
                scope,
                request_id=999,
                request_type="exception",
                submitter_name="P20 Smoke Employee",
                target_user_ids=[manager_uid],
                stage="Manager",
            )
            notify_approval_decided(
                conn,
                scope,
                request_id=999,
                employee_user_id=employee_uid,
                request_type="exception",
                new_status="hr_approved",
                decider_label="HR",
                comment="Approved with comment",
            )

        with admin_engine.begin() as conn:
            employee_inbox = list_for_user(
                conn, scope, user_id=employee_uid
            )
            manager_inbox = list_for_user(
                conn, scope, user_id=manager_uid
            )
        emp_subjects = [n.subject for n in employee_inbox]
        mgr_subjects = [n.subject for n in manager_inbox]
        assert any("hr approved" in s.lower() for s in emp_subjects), emp_subjects
        assert any("manager review" in s.lower() for s in mgr_subjects), mgr_subjects
        print(
            f"[p20] in-app rows: employee={len(employee_inbox)} "
            f"manager={len(manager_inbox)}"
        )

        # 2) Drain via the worker — recorder captures the emails.
        counts = drain_one_tenant(scope=scope)
        print(f"[p20] worker counts: {counts}")
        assert counts["sent"] >= 2, counts

        recorded = [
            json.loads(line)
            for line in Path(recorder_path).read_text().splitlines()
        ]
        assert recorded, "no emails captured"
        emp_emails = [r for r in recorded if employee_email in r["to"]]
        mgr_emails = [r for r in recorded if manager_email in r["to"]]
        assert emp_emails, f"no email for {employee_email}: {recorded}"
        assert mgr_emails, f"no email for {manager_email}: {recorded}"
        print(
            f"[p20] email captured: employee={len(emp_emails)} "
            f"manager={len(mgr_emails)} subjects={[r['subject'] for r in emp_emails + mgr_emails]}"
        )

        # 3) Overtime flag — direct producer call mirrors what the
        # scheduler's _maybe_notify_overtime helper invokes when a
        # row's overtime flips from 0 to >0 for the first time.
        Path(recorder_path).unlink(missing_ok=True)  # reset recorder
        with admin_engine.begin() as conn:
            notify_overtime_flagged(
                conn,
                scope,
                employee_id=emp_id,
                employee_code=f"P20-{suffix}",
                employee_full_name="P20 Smoke Employee",
                the_date=date.today(),
                overtime_minutes=42,
                manager_user_ids=[manager_uid],
            )
        counts2 = drain_one_tenant(scope=scope)
        print(f"[p20] overtime drain counts: {counts2}")
        recorded2 = [
            json.loads(line)
            for line in Path(recorder_path).read_text().splitlines()
        ]
        ot_mgr = [r for r in recorded2 if manager_email in r["to"]]
        ot_hr = [r for r in recorded2 if hr_email in r["to"]]
        assert ot_mgr, f"manager didn't receive overtime email: {recorded2}"
        assert ot_hr, f"HR didn't receive overtime email: {recorded2}"
        print(
            f"[p20] overtime emails: manager={ot_mgr[0]['subject']!r} "
            f"hr={ot_hr[0]['subject']!r}"
        )

        # 4) Preference red line — flip approval_decided email=false
        # for the employee, fire another decision, drain, and
        # confirm the email is skipped.
        Path(recorder_path).unlink(missing_ok=True)
        with admin_engine.begin() as conn:
            from maugood.notifications.repository import set_preference  # noqa: PLC0415

            set_preference(
                conn,
                scope,
                user_id=employee_uid,
                category="approval_decided",
                in_app=True,
                email=False,
            )
            notify_approval_decided(
                conn,
                scope,
                request_id=1001,
                employee_user_id=employee_uid,
                request_type="exception",
                new_status="hr_rejected",
                decider_label="HR",
                comment="No",
            )
        counts3 = drain_one_tenant(scope=scope)
        print(f"[p20] pref-off drain counts: {counts3}")
        assert counts3["skipped_pref"] >= 1, counts3
        recorded3 = (
            Path(recorder_path).read_text() if Path(recorder_path).exists() else ""
        )
        assert employee_email not in recorded3
        print("[p20] preference=false honoured — no email captured for employee")

        print("[p20] OK")
    except (AssertionError, Exception) as exc:
        print(f"[p20] FAIL — {type(exc).__name__}: {exc}", file=sys.stderr)
        rc = 1
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                update(email_config)
                .where(email_config.c.tenant_id == TENANT_ID)
                .values(
                    enabled=False,
                    smtp_host="",
                    smtp_username="",
                    from_address="",
                    from_name="",
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
        for uid in (employee_uid, manager_uid, hr_uid):
            _cleanup_user(admin_engine, uid)
        admin_engine.dispose()
        Path(recorder_path).unlink(missing_ok=True)
        print("[p20] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
