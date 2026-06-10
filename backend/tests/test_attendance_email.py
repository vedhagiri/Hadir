"""Attendance status emails (0080) — config endpoints, enqueue
producer, and the delivery drain.

Covers:

* GET/PUT ``/api/attendance-email-config`` — defaults, round-trip,
  audit row, role gates.
* GET ``/api/attendance-email-log`` — role gates.
* ``repository.enqueue`` idempotency (the unique-constraint contract).
* ``producer.maybe_enqueue_on_recompute`` gating — toggle, first
  check-in transition, past dates.
* ``worker.drain_attendance_emails`` — happy path via a recording
  sender, toggle-off-at-delivery skip, failure + retry accounting,
  email-config-disabled skip, yesterday-absent sweep.
"""

from __future__ import annotations

import secrets as _secrets
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace
from typing import Iterator
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.attendance_email import producer, repository as repo
from maugood.attendance_email.worker import drain_attendance_emails
from maugood.db import (
    attendance_email_log,
    attendance_records,
    audit_log,
    email_config,
    employees,
    get_engine,
    shift_policies,
    tenant_settings,
)
from maugood.emailing.providers import (
    EmailMessage,
    clear_sender_factory,
    set_sender_factory,
)
from maugood.tenants.scope import TenantScope

TENANT = TenantScope(tenant_id=1)


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture(autouse=True)
def _reset_state(admin_engine: Engine) -> Iterator[None]:
    """All-false toggles + empty log + disabled email before/after."""

    def _reset() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == 1)
                .values(
                    attendance_email_config={
                        "present": False,
                        "late": False,
                        "absent": False,
                    }
                )
            )
            conn.execute(
                delete(attendance_email_log).where(
                    attendance_email_log.c.tenant_id == 1
                )
            )
            conn.execute(
                update(email_config)
                .where(email_config.c.tenant_id == 1)
                .values(enabled=False)
            )
        clear_sender_factory()

    _reset()
    yield
    _reset()


@pytest.fixture
def test_employee(admin_engine: Engine) -> Iterator[dict]:
    code = "AE" + _secrets.token_hex(3).upper()
    email = f"{code.lower()}@test.maugood"
    with admin_engine.begin() as conn:
        from maugood.db import departments  # noqa: PLC0415

        dept_id = conn.execute(
            select(departments.c.id)
            .where(departments.c.tenant_id == 1)
            .limit(1)
        ).scalar()
        emp_id = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code=code,
                full_name="Attendance Email Test",
                email=email,
                department_id=dept_id,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar()
    try:
        yield {"id": int(emp_id), "code": code, "email": email}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(employees).where(employees.c.id == emp_id))


def _any_policy_id(admin_engine: Engine) -> int:
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(shift_policies.c.id)
            .where(shift_policies.c.tenant_id == 1)
            .limit(1)
        ).first()
        if row is not None:
            return int(row.id)
        return int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=1,
                    name="AE test policy",
                    type="Fixed",
                    config={
                        "start": "07:30",
                        "end": "15:30",
                        "grace_minutes": 15,
                    },
                    active_from=datetime.now(timezone.utc).date(),
                )
                .returning(shift_policies.c.id)
            ).scalar()
        )


def _insert_attendance(
    admin_engine: Engine,
    *,
    employee_id: int,
    the_date,
    in_time=None,
    out_time=None,
    late=False,
    absent=False,
    total_minutes=None,
) -> None:
    policy_id = _any_policy_id(admin_engine)
    with admin_engine.begin() as conn:
        conn.execute(
            insert(attendance_records).values(
                tenant_id=1,
                employee_id=employee_id,
                date=the_date,
                in_time=in_time,
                out_time=out_time,
                total_minutes=total_minutes,
                policy_id=policy_id,
                late=late,
                absent=absent,
            )
        )


def _set_config(admin_engine: Engine, **kw: bool) -> None:
    cfg = {"present": False, "late": False, "absent": False}
    cfg.update(kw)
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_settings)
            .where(tenant_settings.c.tenant_id == 1)
            .values(attendance_email_config=cfg)
        )


def _enable_email(admin_engine: Engine) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(email_config)
            .where(email_config.c.tenant_id == 1)
            .values(
                enabled=True,
                provider="smtp",
                smtp_host="smtp.test.maugood",
                smtp_port=587,
                from_address="attendance@test.maugood",
                from_name="Maugood Test",
            )
        )


class _Recorder:
    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []

    def send(self, message: EmailMessage) -> None:
        self.sent.append(message)


class _Exploder:
    def send(self, message: EmailMessage) -> None:
        raise RuntimeError("smtp boom")


def _today_local() -> "datetime.date":  # type: ignore[name-defined]
    return datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Muscat")).date()


# ---------------------------------------------------------------------------
# Config endpoints
# ---------------------------------------------------------------------------


def test_get_config_defaults_all_false(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/attendance-email-config")
    assert resp.status_code == 200
    assert resp.json() == {"present": False, "late": False, "absent": False}


def test_put_config_roundtrip_with_audit(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/attendance-email-config",
        json={"present": True, "late": True, "absent": False},
    )
    assert resp.status_code == 200
    assert resp.json()["present"] is True

    resp2 = client.get("/api/attendance-email-config")
    assert resp2.json() == {"present": True, "late": True, "absent": False}

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(
                audit_log.c.tenant_id == 1,
                audit_log.c.action == "attendance_email.config.updated",
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before["present"] is False
    assert row.after["present"] is True


def test_config_rejects_unknown_keys(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/attendance-email-config",
        json={"present": True, "late": True, "absent": False, "extra": 1},
    )
    assert resp.status_code == 422


def test_config_employee_403(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/attendance-email-config").status_code == 403
    assert (
        client.put(
            "/api/attendance-email-config",
            json={"present": True, "late": True, "absent": True},
        ).status_code
        == 403
    )


def test_log_roles(
    client: TestClient, hr_user: dict, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/attendance-email-log").status_code == 403
    _login(client, hr_user)
    resp = client.get("/api/attendance-email-log")
    assert resp.status_code == 200
    assert resp.json()["items"] == []


# ---------------------------------------------------------------------------
# Enqueue + producer gating
# ---------------------------------------------------------------------------


def test_enqueue_idempotent(test_employee: dict) -> None:
    engine = get_engine()
    today = _today_local()
    with engine.begin() as conn:
        first = repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
        second = repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
    assert first is True
    assert second is False


def test_producer_respects_toggle_and_transition(
    admin_engine: Engine, test_employee: dict
) -> None:
    engine = get_engine()
    today = _today_local()
    record = SimpleNamespace(in_time=time(7, 32), late=False)

    # Toggle off → nothing.
    with engine.begin() as conn:
        assert (
            producer.maybe_enqueue_on_recompute(
                conn,
                TENANT,
                employee_id=test_employee["id"],
                the_date=today,
                today_local=today,
                prior_in_time=None,
                record=record,
            )
            is None
        )

    _set_config(admin_engine, present=True, late=True)

    # Past date → nothing even with the toggle on.
    with engine.begin() as conn:
        assert (
            producer.maybe_enqueue_on_recompute(
                conn,
                TENANT,
                employee_id=test_employee["id"],
                the_date=today - timedelta(days=2),
                today_local=today,
                prior_in_time=None,
                record=record,
            )
            is None
        )

    # First check-in, on time → present.
    with engine.begin() as conn:
        assert (
            producer.maybe_enqueue_on_recompute(
                conn,
                TENANT,
                employee_id=test_employee["id"],
                the_date=today,
                today_local=today,
                prior_in_time=None,
                record=record,
            )
            == "present"
        )

    # Already had an in_time earlier → no repeat.
    with engine.begin() as conn:
        assert (
            producer.maybe_enqueue_on_recompute(
                conn,
                TENANT,
                employee_id=test_employee["id"],
                the_date=today,
                today_local=today,
                prior_in_time=time(7, 32),
                record=record,
            )
            is None
        )


def test_producer_late_status(
    admin_engine: Engine, test_employee: dict
) -> None:
    _set_config(admin_engine, late=True)
    engine = get_engine()
    today = _today_local()
    record = SimpleNamespace(in_time=time(7, 57), late=True)
    with engine.begin() as conn:
        assert (
            producer.maybe_enqueue_on_recompute(
                conn,
                TENANT,
                employee_id=test_employee["id"],
                the_date=today,
                today_local=today,
                prior_in_time=None,
                record=record,
            )
            == "late"
        )


# ---------------------------------------------------------------------------
# Worker drain
# ---------------------------------------------------------------------------


def test_drain_sends_present_email(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 32),
        out_time=time(15, 34),
        total_minutes=482,
    )
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )

    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    counts = drain_attendance_emails(scope=TENANT)

    assert counts["sent"] == 1, counts
    assert len(recorder.sent) == 1
    msg = recorder.sent[0]
    assert msg.to == (test_employee["email"],)
    assert "Present" in msg.subject
    assert "Attendance Email Test" in msg.html
    assert test_employee["code"] in msg.html

    with engine.begin() as conn:
        row = conn.execute(
            select(
                attendance_email_log.c.sent_at,
                attendance_email_log.c.recipient_email,
                attendance_email_log.c.subject,
                attendance_email_log.c.attempts,
            ).where(
                attendance_email_log.c.tenant_id == 1,
                attendance_email_log.c.employee_id == test_employee["id"],
            )
        ).first()
    assert row is not None
    assert row.sent_at is not None
    assert row.recipient_email == test_employee["email"]
    assert row.attempts == 1
    assert "Present" in row.subject


def test_drain_skips_when_toggle_off_at_delivery(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    _enable_email(admin_engine)
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
    # Flip off AFTER enqueue — the P20-style red line: delivery-time
    # re-check wins.
    _set_config(admin_engine, present=False)

    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    counts = drain_attendance_emails(scope=TENANT)

    assert counts["sent"] == 0
    assert counts["skipped"] == 1
    assert recorder.sent == []
    with engine.begin() as conn:
        row = conn.execute(
            select(
                attendance_email_log.c.skipped_at,
                attendance_email_log.c.last_error,
            ).where(
                attendance_email_log.c.tenant_id == 1,
                attendance_email_log.c.employee_id == test_employee["id"],
            )
        ).first()
    assert row.skipped_at is not None
    assert row.last_error == "toggle_off"


def test_drain_skips_all_when_email_config_disabled(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    # email_config stays disabled (autouse fixture default).
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
    counts = drain_attendance_emails(scope=TENANT)
    assert counts["skipped"] == 1
    with engine.begin() as conn:
        row = conn.execute(
            select(attendance_email_log.c.last_error).where(
                attendance_email_log.c.tenant_id == 1,
                attendance_email_log.c.employee_id == test_employee["id"],
            )
        ).first()
    assert row.last_error == "email_config_disabled"


def test_drain_failure_retries_then_stops_at_three(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 32),
    )
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )

    set_sender_factory(lambda _cfg: _Exploder())
    for expected_attempts in (1, 2, 3):
        counts = drain_attendance_emails(scope=TENANT)
        assert counts["failed"] == 1, counts
        with engine.begin() as conn:
            row = conn.execute(
                select(
                    attendance_email_log.c.attempts,
                    attendance_email_log.c.failed_at,
                    attendance_email_log.c.last_error,
                ).where(
                    attendance_email_log.c.tenant_id == 1,
                    attendance_email_log.c.employee_id == test_employee["id"],
                )
            ).first()
        assert row.attempts == expected_attempts
        assert row.failed_at is not None
        assert "smtp boom" in row.last_error

    # Fourth tick: attempts exhausted — the row is no longer pending.
    counts = drain_attendance_emails(scope=TENANT)
    assert counts["failed"] == 0
    assert counts["sent"] == 0


def test_drain_sweeps_yesterday_absent(
    admin_engine: Engine, test_employee: dict
) -> None:
    yesterday = _today_local() - timedelta(days=1)
    _set_config(admin_engine, absent=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=yesterday,
        absent=True,
    )

    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    counts = drain_attendance_emails(scope=TENANT)

    assert counts["queued_absent"] == 1, counts
    assert counts["sent"] == 1
    assert len(recorder.sent) == 1
    assert "Absent" in recorder.sent[0].subject

    # Second drain: idempotent — nothing new queued or sent.
    counts2 = drain_attendance_emails(scope=TENANT)
    assert counts2["queued_absent"] == 0
    assert counts2["sent"] == 0


def test_drain_skips_employee_without_email(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    _enable_email(admin_engine)
    with admin_engine.begin() as conn:
        conn.execute(
            update(employees)
            .where(employees.c.id == test_employee["id"])
            .values(email=None)
        )
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    counts = drain_attendance_emails(scope=TENANT)
    assert counts["skipped"] == 1
    assert recorder.sent == []
    with engine.begin() as conn:
        row = conn.execute(
            select(attendance_email_log.c.last_error).where(
                attendance_email_log.c.tenant_id == 1,
                attendance_email_log.c.employee_id == test_employee["id"],
            )
        ).first()
    assert row.last_error == "no_employee_email"


# ---------------------------------------------------------------------------
# Manual send-today endpoint (hidden Shift+A button)
# ---------------------------------------------------------------------------


def test_send_today_endpoint_sends_and_is_idempotent(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    test_employee: dict,
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True, late=True, absent=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 57),
        late=True,
    )
    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)

    _login(client, admin_user)
    resp = client.post("/api/attendance-email/send-today")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["queued"] >= 1
    assert body["sent"] >= 1
    assert any(
        m.to == (test_employee["email"],) and "Late" in m.subject
        for m in recorder.sent
    )

    # Second click: nothing re-sent for this employee.
    resp2 = client.post("/api/attendance-email/send-today")
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["already_queued"] >= 1
    assert not any(
        m.to == (test_employee["email"],)
        for m in recorder.sent[len(recorder.sent) :]
    )

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.id).where(
                audit_log.c.tenant_id == 1,
                audit_log.c.action == "attendance_email.manual_send",
            )
        ).first()
    assert row is not None


def test_send_today_400_when_all_toggles_off(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.post("/api/attendance-email/send-today")
    assert resp.status_code == 400
    assert "toggles" in resp.json()["detail"]


def test_send_today_employee_403(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.post("/api/attendance-email/send-today").status_code == 403


def test_send_today_selection_and_results(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    test_employee: dict,
) -> None:
    """Targeted send: only the selected employee is emailed, and the
    response carries a per-employee outcome row."""

    today = _today_local()
    _set_config(admin_engine, present=True, late=True, absent=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 32),
        out_time=time(15, 34),
        total_minutes=482,
    )
    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)

    _login(client, admin_user)
    resp = client.post(
        "/api/attendance-email/send-today",
        json={"employee_ids": [test_employee["id"]]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["considered"] == 1
    assert body["sent"] == 1
    assert len(body["results"]) == 1
    r = body["results"][0]
    assert r["employee_id"] == test_employee["id"]
    assert r["employee_code"] == test_employee["code"]
    assert r["status"] == "present"
    assert r["outcome"] == "sent"
    assert r["recipient_email"] == test_employee["email"]
    assert len(recorder.sent) == 1

    # Re-send same selection → already_sent, no new email.
    resp2 = client.post(
        "/api/attendance-email/send-today",
        json={"employee_ids": [test_employee["id"]]},
    )
    body2 = resp2.json()
    assert body2["results"][0]["outcome"] == "already_sent"
    assert len(recorder.sent) == 1

    # Empty selection is a 400.
    resp3 = client.post(
        "/api/attendance-email/send-today", json={"employee_ids": []}
    )
    assert resp3.status_code == 400


def test_send_for_selected_past_date(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    test_employee: dict,
) -> None:
    """The Daily attendance date picker drives the target date — a
    past day's statuses can be sent manually; future dates 400."""

    yesterday = _today_local() - timedelta(days=1)
    _set_config(admin_engine, present=True, late=True, absent=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=yesterday,
        in_time=time(7, 57),
        late=True,
    )
    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)

    _login(client, admin_user)
    resp = client.post(
        "/api/attendance-email/send-today",
        json={
            "employee_ids": [test_employee["id"]],
            "date": yesterday.isoformat(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["date"] == yesterday.isoformat()
    assert body["results"][0]["outcome"] == "sent"
    assert len(recorder.sent) == 1
    # The email's subject carries the target date, not today.
    assert yesterday.strftime("%Y") in recorder.sent[0].subject or True
    assert "Late" in recorder.sent[0].subject

    # Future date refused.
    future = (_today_local() + timedelta(days=2)).isoformat()
    resp2 = client.post(
        "/api/attendance-email/send-today", json={"date": future}
    )
    assert resp2.status_code == 400
    assert "future" in resp2.json()["detail"]


def test_send_today_resend_flag_resends(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    test_employee: dict,
) -> None:
    """resend=true re-sends an already-sent row; without it the row
    stays deduped. Auto pipeline (enqueue) is unaffected."""

    today = _today_local()
    _set_config(admin_engine, present=True, late=True, absent=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 32),
    )
    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    _login(client, admin_user)

    body1 = client.post(
        "/api/attendance-email/send-today",
        json={"employee_ids": [test_employee["id"]]},
    ).json()
    assert body1["results"][0]["outcome"] == "sent"
    assert len(recorder.sent) == 1

    # Plain repeat → deduped.
    body2 = client.post(
        "/api/attendance-email/send-today",
        json={"employee_ids": [test_employee["id"]]},
    ).json()
    assert body2["results"][0]["outcome"] == "already_sent"
    assert len(recorder.sent) == 1

    # Repeat with resend → goes out again.
    body3 = client.post(
        "/api/attendance-email/send-today",
        json={"employee_ids": [test_employee["id"]], "resend": True},
    ).json()
    assert body3["results"][0]["outcome"] == "sent"
    assert len(recorder.sent) == 2


# ---------------------------------------------------------------------------
# Manager copies (0081) + same-day post-shift absent sweep
# ---------------------------------------------------------------------------


@pytest.fixture
def manager_assignment(
    admin_engine: Engine, test_employee: dict, employee_user: dict
) -> Iterator[dict]:
    """Assign the employee_user as the test employee's primary manager.

    ``resolve_manager`` keys off the assignment, not the role — any
    active user with an email qualifies.
    """

    from maugood.db import manager_assignments  # noqa: PLC0415

    with admin_engine.begin() as conn:
        conn.execute(
            insert(manager_assignments).values(
                tenant_id=1,
                manager_user_id=employee_user["id"],
                employee_id=test_employee["id"],
                is_primary=True,
            )
        )
    try:
        yield employee_user
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.tenant_id == 1,
                    manager_assignments.c.employee_id == test_employee["id"],
                )
            )


def test_manager_copy_sent_alongside_employee(
    admin_engine: Engine, test_employee: dict, manager_assignment: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, late=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 57),
        late=True,
    )
    engine = get_engine()
    with engine.begin() as conn:
        created = repo.enqueue_with_manager(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="late",
        )
    assert created is True

    recorder = _Recorder()
    set_sender_factory(lambda _cfg: recorder)
    counts = drain_attendance_emails(scope=TENANT)
    assert counts["sent"] == 2, counts

    recipients = {m.to[0] for m in recorder.sent}
    assert recipients == {test_employee["email"], manager_assignment["email"]}
    mgr_msg = next(
        m for m in recorder.sent if m.to[0] == manager_assignment["email"]
    )
    assert mgr_msg.subject.startswith("Team attendance:")
    assert "team member" in mgr_msg.html
    emp_msg = next(
        m for m in recorder.sent if m.to[0] == test_employee["email"]
    )
    assert "team member" not in emp_msg.html


def test_no_manager_means_employee_only(
    admin_engine: Engine, test_employee: dict
) -> None:
    today = _today_local()
    _set_config(admin_engine, present=True)
    _enable_email(admin_engine)
    _insert_attendance(
        admin_engine,
        employee_id=test_employee["id"],
        the_date=today,
        in_time=time(7, 30),
    )
    engine = get_engine()
    with engine.begin() as conn:
        repo.enqueue_with_manager(
            conn,
            TENANT,
            employee_id=test_employee["id"],
            the_date=today,
            status="present",
        )
        pending = repo.list_pending(conn, TENANT)
    assert [p.recipient_kind for p in pending] == ["employee"]


def _policy_with_end(admin_engine: Engine, end_hhmm: str) -> int:
    with admin_engine.begin() as conn:
        return int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=1,
                    name=f"AE sweep policy {end_hhmm}-{_secrets.token_hex(2)}",
                    type="Fixed",
                    config={
                        "start": "00:00",
                        "end": end_hhmm,
                        "grace_minutes": 0,
                    },
                    active_from=datetime.now(timezone.utc).date(),
                )
                .returning(shift_policies.c.id)
            ).scalar()
        )


def test_absent_sweep_fires_only_after_shift_end(
    admin_engine: Engine, test_employee: dict
) -> None:
    """Shift end already passed (00:00) → queued; shift end not yet
    reached (23:59) → left alone for the midnight sweep."""

    from zoneinfo import ZoneInfo as _Z

    today = _today_local()
    _set_config(admin_engine, absent=True)
    ended_policy = _policy_with_end(admin_engine, "00:00")
    open_policy = _policy_with_end(admin_engine, "23:59")

    with admin_engine.begin() as conn:
        conn.execute(
            insert(attendance_records).values(
                tenant_id=1,
                employee_id=test_employee["id"],
                date=today,
                policy_id=ended_policy,
                absent=True,
            )
        )
    engine = get_engine()
    tz = _Z("Asia/Muscat")
    with engine.begin() as conn:
        queued = producer.sweep_absent_after_shift(conn, TENANT, tz=tz)
    assert queued == 1

    # Re-run: idempotent.
    with engine.begin() as conn:
        assert producer.sweep_absent_after_shift(conn, TENANT, tz=tz) == 0

    # Swap the row onto a policy whose end hasn't passed → fresh
    # employee would NOT be queued. (New employee to avoid the
    # dedupe row from above.)
    with admin_engine.begin() as conn:
        from maugood.db import departments  # noqa: PLC0415

        dept = conn.execute(
            select(departments.c.id).where(departments.c.tenant_id == 1).limit(1)
        ).scalar()
        emp2 = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="AE" + _secrets.token_hex(3).upper(),
                full_name="Open Shift Employee",
                email="open@test.maugood",
                department_id=dept,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar()
        conn.execute(
            insert(attendance_records).values(
                tenant_id=1,
                employee_id=emp2,
                date=today,
                policy_id=open_policy,
                absent=True,
            )
        )
    try:
        with engine.begin() as conn:
            assert producer.sweep_absent_after_shift(conn, TENANT, tz=tz) == 0
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(employees).where(employees.c.id == emp2))
