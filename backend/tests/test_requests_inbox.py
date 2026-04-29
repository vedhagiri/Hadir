"""Tests for v1.0 P15 — approvals inbox.

Two suites:

1. Pure SLA business-hours math from ``maugood.requests.sla``.
2. End-to-end inbox endpoints — `GET /api/requests/inbox/pending`,
   `/inbox/decided`, `/inbox/summary`, plus the widened manager
   scope and the manager-scope-vs-decision red lines.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.auth.passwords import hash_password
from maugood.db import (
    approved_leaves,
    audit_log,
    departments,
    employees,
    manager_assignments,
    request_attachments,
    requests as requests_table,
    roles,
    user_departments,
    user_roles,
    user_sessions,
    users,
)
from maugood.requests import sla as sla_mod


TENANT_ID = 1


# ---------------------------------------------------------------------------
# Pure SLA math
# ---------------------------------------------------------------------------


def _utc(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


def test_sla_zero_when_as_of_before_submitted() -> None:
    cfg = sla_mod.SlaConfig(
        business_hours_threshold=48,
        business_day_hours=8,
        weekend_days=("Friday", "Saturday"),
    )
    bh = sla_mod.business_hours_open(
        submitted_at=_utc(2026, 5, 4, 9),
        as_of=_utc(2026, 5, 4, 9),
        config=cfg,
    )
    assert bh == 0.0


def test_sla_skips_weekend_days() -> None:
    """Submitted Thu 09:00, as_of Sun 09:00 — Friday + Saturday are
    Omran weekends so they don't count, leaving Thu 09→24 (capped at
    8h) + Sun 00→09 (capped at 8h) = 16h.
    """

    cfg = sla_mod.SlaConfig(
        business_hours_threshold=48,
        business_day_hours=8,
        weekend_days=("Friday", "Saturday"),
    )
    # 2026-05-07 was a Thursday; 2026-05-10 a Sunday.
    bh = sla_mod.business_hours_open(
        submitted_at=_utc(2026, 5, 7, 9),
        as_of=_utc(2026, 5, 10, 9),
        config=cfg,
    )
    # Thu day cap 8h + Sun morning cap 8h = 16h.
    assert bh == 16.0


def test_sla_breached_after_threshold() -> None:
    cfg = sla_mod.SlaConfig(
        business_hours_threshold=8,
        business_day_hours=8,
        weekend_days=("Friday", "Saturday"),
    )
    bh = sla_mod.business_hours_open(
        submitted_at=_utc(2026, 5, 7, 9),  # Thursday
        as_of=_utc(2026, 5, 7, 22),
        config=cfg,
    )
    # Within Thu only: cap 8h reached → exactly 8.0.
    assert bh == 8.0
    assert sla_mod.is_breached(
        submitted_at=_utc(2026, 5, 7, 9),
        as_of=_utc(2026, 5, 7, 22),
        config=cfg,
    )


def test_sla_naive_dates_rejected() -> None:
    cfg = sla_mod.SlaConfig(
        business_hours_threshold=48,
        business_day_hours=8,
        weekend_days=(),
    )
    with pytest.raises(ValueError):
        sla_mod.business_hours_open(
            submitted_at=datetime(2026, 5, 7, 9),
            as_of=datetime(2026, 5, 8, 9),
            config=cfg,
        )


# ---------------------------------------------------------------------------
# Helpers for the API suite
# ---------------------------------------------------------------------------


def _make_user(
    engine: Engine,
    *,
    email: str,
    password: str,
    role_codes: list[str],
    full_name: str,
    department_codes: list[str] | None = None,
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


def _cleanup_user(engine: Engine, user_id: int) -> None:
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


@pytest.fixture
def inbox_world(admin_engine: Engine) -> Iterator[dict]:
    """Provision an Employee in ENG, a department-Manager (no
    explicit assignment but is a member of ENG), an HR user, and an
    Admin. Two requests already exist in the world: one submitted,
    one manager-rejected (terminal — should not appear in any
    pending queue).
    """

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p15.maugood"
    manager_email = f"mgr-{suffix}@p15.maugood"
    hr_email = f"hr-{suffix}@p15.maugood"
    admin_email = f"adm-{suffix}@p15.maugood"
    pwd = "p15-pw-" + secrets.token_hex(4)

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P15 Smoke Employee",
        department_codes=["ENG"],
    )
    # Department-only manager: no manager_assignments row, but a
    # member of ENG via user_departments.
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
    admin_uid = _make_user(
        admin_engine,
        email=admin_email,
        password=pwd,
        role_codes=["Admin"],
        full_name="P15 Admin",
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

    bundle = {
        "password": pwd,
        "employee": {"id": employee_uid, "email": employee_email},
        "manager": {"id": manager_uid, "email": manager_email},
        "hr": {"id": hr_uid, "email": hr_email},
        "admin": {"id": admin_uid, "email": admin_email},
        "employee_row_id": emp_id,
    }
    try:
        yield bundle
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
                delete(audit_log).where(
                    audit_log.c.entity_type == "request"
                )
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


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


def _submit_exception(client: TestClient, when: str = "2026-05-30") -> int:
    resp = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Doctor",
            "target_date_start": when,
        },
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


# ---------------------------------------------------------------------------
# Manager scope widening
# ---------------------------------------------------------------------------


def test_department_only_manager_can_see_and_decide(
    client: TestClient, inbox_world: dict
) -> None:
    """The manager has NO manager_assignments row — only a
    user_departments link — yet should see + decide via the wider
    P15 scope.
    """

    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid = _submit_exception(client)

    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["manager"]["email"],
        password=inbox_world["password"],
    )
    listing = client.get("/api/requests/inbox/pending")
    assert listing.status_code == 200
    assert any(r["id"] == rid for r in listing.json()), listing.text

    decide = client.post(
        f"/api/requests/{rid}/manager-decide",
        json={"decision": "approve", "comment": "OK"},
    )
    assert decide.status_code == 200, decide.text
    assert decide.json()["status"] == "manager_approved"


def test_manager_outside_department_403_on_decide(
    client: TestClient, inbox_world: dict, admin_engine: Engine
) -> None:
    """A manager assigned to OPS shouldn't decide on an ENG employee."""

    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid = _submit_exception(client, when="2026-06-01")

    suffix = secrets.token_hex(3)
    other_email = f"mgr-other-{suffix}@p15.maugood"
    other_pw = "other-" + secrets.token_hex(4)
    other_uid = _make_user(
        admin_engine,
        email=other_email,
        password=other_pw,
        role_codes=["Manager"],
        full_name="OPS Manager",
        department_codes=["OPS"],
    )
    try:
        client.post("/api/auth/logout")
        _login(client, email=other_email, password=other_pw)
        decide = client.post(
            f"/api/requests/{rid}/manager-decide",
            json={"decision": "approve", "comment": ""},
        )
        assert decide.status_code == 403
    finally:
        _cleanup_user(admin_engine, other_uid)


# ---------------------------------------------------------------------------
# Inbox endpoints
# ---------------------------------------------------------------------------


def test_inbox_pending_and_summary_for_each_role(
    client: TestClient, inbox_world: dict
) -> None:
    # Submit two requests so both manager + HR queues have something.
    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid_a = _submit_exception(client, when="2026-06-02")
    rid_b = _submit_exception(client, when="2026-06-03")

    # Manager — both submitted requests show up in pending.
    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["manager"]["email"],
        password=inbox_world["password"],
    )
    pending = client.get("/api/requests/inbox/pending").json()
    pending_ids = {r["id"] for r in pending}
    assert {rid_a, rid_b}.issubset(pending_ids)
    summary = client.get("/api/requests/inbox/summary").json()
    assert summary["pending_count"] == len(pending)

    # Manager approves rid_a → it leaves the manager queue and lands
    # in the HR queue.
    decide = client.post(
        f"/api/requests/{rid_a}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )
    assert decide.status_code == 200

    pending2 = client.get("/api/requests/inbox/pending").json()
    pending2_ids = {r["id"] for r in pending2}
    assert rid_a not in pending2_ids
    assert rid_b in pending2_ids

    decided = client.get("/api/requests/inbox/decided").json()
    assert any(r["id"] == rid_a for r in decided)

    # HR — rid_a is now in HR's pending queue.
    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["hr"]["email"],
        password=inbox_world["password"],
    )
    hr_pending = client.get("/api/requests/inbox/pending").json()
    assert any(r["id"] == rid_a for r in hr_pending)
    # rid_b never reached HR.
    assert not any(r["id"] == rid_b for r in hr_pending)
    hr_summary = client.get("/api/requests/inbox/summary").json()
    assert hr_summary["pending_count"] == len(hr_pending)


def test_admin_pending_includes_every_non_terminal(
    client: TestClient, inbox_world: dict
) -> None:
    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid = _submit_exception(client, when="2026-06-05")

    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["admin"]["email"],
        password=inbox_world["password"],
    )
    pending = client.get("/api/requests/inbox/pending").json()
    assert any(r["id"] == rid for r in pending)


def test_employee_inbox_pending_is_empty(
    client: TestClient, inbox_world: dict
) -> None:
    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    _submit_exception(client, when="2026-06-07")
    pending = client.get("/api/requests/inbox/pending").json()
    assert pending == []


# ---------------------------------------------------------------------------
# Response enrichment
# ---------------------------------------------------------------------------


def test_response_carries_attachment_count_and_sla(
    client: TestClient, inbox_world: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid = _submit_exception(client, when="2026-06-09")

    # Backdate submitted_at so the SLA breached flag fires
    # deterministically (default threshold 48 business hours).
    with admin_engine.begin() as conn:
        conn.execute(
            update(requests_table)
            .where(requests_table.c.id == rid)
            .values(
                submitted_at=datetime.now(timezone.utc) - timedelta(days=15)
            )
        )

    # Attach one PNG so attachment_count > 0.
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000a49444154789c6300010000000500010d0a2db40000000049454e44ae42"
        "6082"
    )
    upload = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("a.png", png, "image/png")},
    )
    assert upload.status_code == 201

    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["manager"]["email"],
        password=inbox_world["password"],
    )
    pending = client.get("/api/requests/inbox/pending").json()
    row = next(r for r in pending if r["id"] == rid)
    assert row["attachment_count"] == 1
    assert row["sla_breached"] is True
    assert row["business_hours_open"] >= 48


def test_primary_assignment_marker_for_manager(
    client: TestClient, inbox_world: dict, admin_engine: Engine
) -> None:
    """When the manager has a direct primary assignment to the
    employee, ``is_primary_for_viewer`` is True and the row sorts to
    the top of pending.
    """

    # Add a primary manager_assignments row.
    with admin_engine.begin() as conn:
        conn.execute(
            insert(manager_assignments).values(
                tenant_id=TENANT_ID,
                manager_user_id=inbox_world["manager"]["id"],
                employee_id=inbox_world["employee_row_id"],
                is_primary=True,
            )
        )

    _login(
        client,
        email=inbox_world["employee"]["email"],
        password=inbox_world["password"],
    )
    rid = _submit_exception(client, when="2026-06-12")

    client.post("/api/auth/logout")
    _login(
        client,
        email=inbox_world["manager"]["email"],
        password=inbox_world["password"],
    )
    pending = client.get("/api/requests/inbox/pending").json()
    row = next(r for r in pending if r["id"] == rid)
    assert row["is_primary_for_viewer"] is True
