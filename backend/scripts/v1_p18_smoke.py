"""End-to-end smoke for v1.0 P18 — scheduled reports + email.

Walks the prompt's verification scenario:

  1. Configure email_config (provider=smtp, enabled=true).
  2. Create a weekly attendance schedule (PDF, recipients).
  3. Invoke ``run_schedule_now`` in-process so the file-recorder env
     (``HADIR_EMAIL_RECORDER_PATH``) is honoured by the same Python
     process that creates the email message. (The HTTP run-now
     endpoint runs inside uvicorn, which doesn't share env with this
     script.)
  4. Assert the run row landed, the captured email has the PDF
     attachment, and the schedule's last_run_at advanced.
  5. Anonymously fetch the signed-URL download to confirm the
     token gate works.

Cleans up so a re-run starts clean.
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import date, time, timedelta
from pathlib import Path
from typing import Optional

import httpx
from sqlalchemy import delete, insert, select, update

from hadir.db import (
    attendance_records,
    audit_log,
    email_config,
    employees,
    make_admin_engine,
    notifications_queue,
    report_runs,
    report_schedules,
    shift_policies,
    user_sessions,
)
from hadir.scheduled_reports.runner import run_schedule_now
from hadir.scheduled_reports.signed_url import make_token
from hadir.tenants.scope import TenantScope


BASE = "http://localhost:8000"
TENANT_ID = 1


def _provision_attendance(admin_engine) -> tuple[int, int]:
    today = date.today()
    with admin_engine.begin() as conn:
        # Avoid clashes with previous runs.
        for code in ("P18-A", "P18-B"):
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
                    delete(employees).where(
                        employees.c.id == int(existing.id)
                    )
                )
        a = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P18-A",
                    full_name="P18 Smoke A",
                    email="a@p18.hadir",
                    department_id=1,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        b = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P18-B",
                    full_name="P18 Smoke B",
                    email="b@p18.hadir",
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
        for emp_id, the_date, in_t, out_t in (
            (a, today, time(7, 28), time(15, 36)),
            (a, today - timedelta(days=1), time(7, 31), time(15, 30)),
            (b, today, time(7, 50), time(15, 5)),
        ):
            total = (out_t.hour * 60 + out_t.minute) - (
                in_t.hour * 60 + in_t.minute
            )
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    date=the_date,
                    in_time=in_t,
                    out_time=out_t,
                    total_minutes=total,
                    policy_id=policy_id,
                    late=False,
                    early_out=False,
                    short_hours=total < 480,
                    absent=False,
                    overtime_minutes=0,
                )
            )
    return a, b


def _cleanup(admin_engine, a: int, b: int) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            delete(report_runs).where(report_runs.c.tenant_id == TENANT_ID)
        )
        conn.execute(
            delete(report_schedules).where(
                report_schedules.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(
            delete(notifications_queue).where(
                notifications_queue.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(
            update(email_config)
            .where(email_config.c.tenant_id == TENANT_ID)
            .values(
                provider="smtp",
                smtp_host="",
                smtp_port=587,
                smtp_username="",
                smtp_password_encrypted=None,
                smtp_use_tls=True,
                graph_tenant_id="",
                graph_client_id="",
                graph_client_secret_encrypted=None,
                from_address="",
                from_name="",
                enabled=False,
            )
        )
        conn.execute(
            delete(attendance_records).where(
                attendance_records.c.employee_id.in_([a, b])
            )
        )
        conn.execute(
            delete(employees).where(employees.c.id.in_([a, b]))
        )
        conn.execute(
            delete(audit_log).where(
                audit_log.c.entity_type.in_(
                    ("report_schedule", "email_config", "report_run")
                )
            )
        )
        conn.execute(
            delete(user_sessions).where(
                user_sessions.c.tenant_id == TENANT_ID
            )
        )


def main() -> int:
    if not os.environ.get("HADIR_SMOKE_PASSWORD"):
        print("[p18] set HADIR_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    # File recorder path the running backend will pick up via
    # ``HADIR_EMAIL_RECORDER_PATH``. The docker compose exec command
    # sets the env when running the smoke; we read the file back here.
    recorder_path = os.environ.get(
        "HADIR_EMAIL_RECORDER_PATH", "/tmp/hadir-p18-recorder.jsonl"
    )
    Path(recorder_path).unlink(missing_ok=True)

    admin_engine = make_admin_engine()
    a_id, b_id = _provision_attendance(admin_engine)

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
            print("[p18] login OK")

            # 1) Configure email.
            cfg = c.patch(
                "/api/email-config",
                json={
                    "provider": "smtp",
                    "smtp_host": "smtp.test.example",
                    "smtp_username": "hadir-smoke",
                    "smtp_password": "rotate-me",
                    "from_address": "noreply@test.example",
                    "from_name": "Hadir",
                    "enabled": True,
                },
            )
            cfg.raise_for_status()
            print(
                f"[p18] email_config set: has_smtp_password="
                f"{cfg.json()['has_smtp_password']} enabled={cfg.json()['enabled']}"
            )
            assert "smtp_password" not in cfg.json()
            assert "smtp_password_encrypted" not in cfg.json()

            # 2) Create a weekly schedule (Monday 08:00).
            sched = c.post(
                "/api/report-schedules",
                json={
                    "name": "Weekly attendance",
                    "format": "pdf",
                    "filter_config": {"window_days": 7},
                    "recipients": [
                        "admin@pilot.hadir",
                        "hr@pilot.hadir",
                    ],
                    "schedule_cron": "0 8 * * 1",
                },
            )
            sched.raise_for_status()
            schedule_id = sched.json()["id"]
            print(
                f"[p18] schedule created id={schedule_id} "
                f"next_run_at={sched.json()['next_run_at']}"
            )

            # 3) Run now in-process so the file-recorder env is
            # honoured by the same Python process generating the
            # message. The HTTP run-now endpoint runs inside uvicorn
            # which doesn't share this script's env.
            scope = TenantScope(tenant_id=TENANT_ID)
            result = run_schedule_now(scope=scope, schedule_id=schedule_id)
            run_body = {
                "id": result.run_id,
                "status": result.status,
                "delivery_mode": result.delivery_mode,
                "recipients_delivered_to": result.recipients_delivered_to,
                "error_message": result.error_message,
            }
            print(
                f"[p18] run-now (attached): id={run_body['id']} "
                f"status={run_body['status']} "
                f"delivery_mode={run_body['delivery_mode']} "
                f"recipients={len(run_body['recipients_delivered_to'])}"
            )
            assert run_body["status"] == "succeeded", run_body
            assert run_body["delivery_mode"] == "attached"

            # Read back the file recorder.
            import json  # noqa: PLC0415

            recorded_lines = Path(recorder_path).read_text().splitlines()
            assert recorded_lines, "no email captured at recorder path"
            captured = json.loads(recorded_lines[-1])
            assert captured["attachments"], captured
            att = captured["attachments"][0]
            assert att["content_type"] == "application/pdf"
            assert att["filename"].endswith(".pdf")
            print(
                f"[p18] captured email: to={captured['to']} "
                f"attachment={att['filename']} size={att['size_bytes']}B"
            )

            # 4) Confirm the API surfaces the run + schedule update.
            runs_listing = c.get("/api/report-runs").json()
            assert any(r["id"] == run_body["id"] for r in runs_listing)
            sched_after = c.get("/api/report-schedules").json()
            this_sched = next(
                s for s in sched_after if s["id"] == schedule_id
            )
            assert this_sched["last_run_status"] == "succeeded"
            print(
                f"[p18] schedule.last_run_status={this_sched['last_run_status']} "
                f"next_run_at={this_sched['next_run_at']}"
            )

            # 5) Anonymous signed-URL download — make a token for the
            # run row and fetch.
            token = make_token(run_id=run_body["id"])
            anon = httpx.Client(base_url=BASE, timeout=10)
            try:
                dl = anon.get(
                    f"/api/reports/runs/{run_body['id']}/download?token={token}"
                )
                dl.raise_for_status()
                assert dl.content.startswith(b"%PDF-")
                print(
                    f"[p18] anonymous signed-URL download: "
                    f"{len(dl.content)}B Content-Type="
                    f"{dl.headers['content-type']}"
                )
                # Bad token → 403.
                bad = anon.get(
                    f"/api/reports/runs/{run_body['id']}/download?token=garbage"
                )
                assert bad.status_code == 403
                print(
                    f"[p18] bad token rejected with {bad.status_code}: "
                    f"{bad.json()['detail']!r}"
                )
            finally:
                anon.close()

        print("[p18] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p18] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        _cleanup(admin_engine, a_id, b_id)
        admin_engine.dispose()
        Path(recorder_path).unlink(missing_ok=True)
        print("[p18] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
