"""End-to-end smoke for v1.0 P21 — Arabic + RTL.

Confirms that:

  1. Setting a user's ``preferred_language`` to ``ar`` causes the
     producer to render the notification subject + body in Arabic.
  2. The email recorder captures the Arabic copy verbatim — no
     UTF-8 corruption, no English fallback.

Runs in-process so the recorder env var reaches the same Python
process that produces + drains the notification.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from datetime import date
from pathlib import Path

from sqlalchemy import delete, insert, select, update

from hadir.auth.passwords import hash_password
from hadir.db import (
    departments,
    email_config,
    employees,
    make_admin_engine,
    notifications,
    requests as requests_table,
    roles,
    user_roles,
    users,
)
from hadir.notifications.producer import notify_approval_assigned
from hadir.notifications.worker import drain_one_tenant
from hadir.tenants.scope import TenantScope


TENANT_ID = 1


def _make_user(engine, *, email, password, role_code, full_name, lang=None):
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
                    preferred_language=lang,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        rid = int(
            conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == TENANT_ID, roles.c.code == role_code
                )
            ).scalar_one()
        )
        conn.execute(
            insert(user_roles).values(
                tenant_id=TENANT_ID, user_id=uid, role_id=rid
            )
        )
    return uid


def _cleanup_user(engine, uid: int) -> None:
    with engine.begin() as conn:
        conn.execute(
            delete(user_roles).where(
                user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == uid
            )
        )
        conn.execute(delete(users).where(users.c.id == uid))


def main() -> int:
    suffix = secrets.token_hex(3)
    recorder_path = os.environ.get(
        "HADIR_EMAIL_RECORDER_PATH", "/tmp/hadir-p21-recorder.jsonl"
    )
    Path(recorder_path).unlink(missing_ok=True)
    os.environ["HADIR_EMAIL_RECORDER_PATH"] = recorder_path

    engine = make_admin_engine()

    # Make sure email is wired up. ``HADIR_EMAIL_RECORDER_PATH`` makes
    # ``get_sender`` short-circuit to the file recorder regardless of
    # ``provider``; we just need the row to exist + ``enabled=True``.
    with engine.begin() as conn:
        existing = conn.execute(
            select(email_config.c.tenant_id).where(
                email_config.c.tenant_id == TENANT_ID
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(email_config).values(
                    tenant_id=TENANT_ID,
                    provider="smtp",
                    smtp_host="recorder.local",
                    from_address="hadir-smoke@example.com",
                    from_name="Hadir P21 smoke",
                    enabled=True,
                )
            )
        else:
            conn.execute(
                update(email_config)
                .where(email_config.c.tenant_id == TENANT_ID)
                .values(enabled=True)
            )

    # Manager who reads Arabic + Employee submitter (English).
    mgr_id = _make_user(
        engine,
        email=f"mgr-{suffix}@p21.test",
        password="p21-pw",
        role_code="Manager",
        full_name="مدير الاختبار",
        lang="ar",  # the load-bearing piece
    )
    emp_user_id = _make_user(
        engine,
        email=f"emp-{suffix}@p21.test",
        password="p21-pw",
        role_code="Employee",
        full_name="Employee Submitter",
    )

    # Synthetic employees + a request row so the producer has data to
    # interpolate.
    with engine.begin() as conn:
        dept_id = int(
            conn.execute(
                select(departments.c.id)
                .where(departments.c.tenant_id == TENANT_ID)
                .order_by(departments.c.id)
                .limit(1)
            ).scalar_one()
        )
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P21EMP{suffix}",
                    full_name="Employee Submitter",
                    email=f"emp-{suffix}@p21.test",
                    department_id=dept_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        req_id = int(
            conn.execute(
                insert(requests_table)
                .values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    type="exception",
                    reason_category="other",
                    reason_text="testing arabic copy",
                    target_date_start=date.today(),
                    target_date_end=date.today(),
                    status="submitted",
                )
                .returning(requests_table.c.id)
            ).scalar_one()
        )

    try:
        scope = TenantScope(tenant_id=TENANT_ID, tenant_schema="main")

        # 1. Fire the producer for an "approval assigned" event
        #    targeted at the Arabic-speaking manager.
        with engine.begin() as conn:
            notify_approval_assigned(
                conn,
                scope,
                request_id=req_id,
                target_user_ids=[mgr_id],
                stage="Manager",
                request_type="exception",
                submitter_name="Employee Submitter",
            )

        # 2. Inspect the in-app row directly: subject must be Arabic
        #    because the recipient's ``preferred_language='ar'``.
        with engine.begin() as conn:
            in_app_row = conn.execute(
                select(notifications.c.subject, notifications.c.body)
                .where(
                    notifications.c.tenant_id == TENANT_ID,
                    notifications.c.user_id == mgr_id,
                )
                .order_by(notifications.c.id.desc())
                .limit(1)
            ).first()
        if in_app_row is None:
            print("FAIL: no in-app notification row for the manager", file=sys.stderr)
            return 2
        subj, body = in_app_row
        # Cheap "is this Arabic?" check — at least one Arabic letter.
        if not any("؀" <= c <= "ۿ" for c in subj):
            print(
                f"FAIL: in-app subject is not Arabic: {subj!r}", file=sys.stderr
            )
            return 3
        print(f"OK in-app Arabic subject: {subj}")
        print(f"OK in-app Arabic body:    {body}")

        # 3. Drain the worker so the email lands in the recorder.
        drained = drain_one_tenant(scope=scope)
        print(f"OK drained: {drained}")

        # 4. Read the recorder file: at least one captured message
        #    must carry the Arabic subject.
        if not Path(recorder_path).exists():
            print(
                f"FAIL: recorder file missing at {recorder_path}", file=sys.stderr
            )
            return 4
        captured = [
            json.loads(line)
            for line in Path(recorder_path).read_text().splitlines()
            if line.strip()
        ]
        arabic_lines = [
            row
            for row in captured
            if any("؀" <= c <= "ۿ" for c in row.get("subject", ""))
        ]
        if not arabic_lines:
            print(
                "FAIL: recorder has no Arabic-subject email — captured "
                f"{[row.get('subject') for row in captured]}",
                file=sys.stderr,
            )
            return 5
        print(f"OK recorder captured Arabic email subject: {arabic_lines[0]['subject']}")
        print("OK P21 smoke")
        return 0
    finally:
        with engine.begin() as conn:
            conn.execute(
                delete(requests_table).where(requests_table.c.id == req_id)
            )
            conn.execute(delete(notifications).where(notifications.c.tenant_id == TENANT_ID))
            conn.execute(delete(employees).where(employees.c.id == emp_id))
        _cleanup_user(engine, mgr_id)
        _cleanup_user(engine, emp_user_id)
        Path(recorder_path).unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
