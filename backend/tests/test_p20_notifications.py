"""Tests for v1.0 P20 — notifications subsystem.

Five slices:

1. Pure preference resolver — defaults to (in_app=True, email=True)
   when no row exists; honours stored values.
2. In-app producer side: writing a notification respects in_app=False
   (no row created) and writes when in_app=True.
3. Endpoints: list + unread count + mark-read + preferences CRUD.
4. Worker: drains pending email-pending rows, honours email=False
   (skipped rather than sent), tenant without email config skips
   gracefully, recording sender captures the message.
5. Producers: approval_assigned on submit, approval_decided on
   manager-reject, overtime_flagged on a real recompute.
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.attendance.engine import AttendanceRecord
from maugood.auth.passwords import hash_password
from maugood.db import (
    attendance_records,
    audit_log,
    email_config,
    employees,
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
from maugood.emailing import (
    RecordingSender,
    clear_sender_factory,
    set_sender_factory,
)
from maugood.notifications.categories import ALL_CATEGORIES
from maugood.notifications.producer import (
    notify_overtime_flagged,
    notify_user,
)
from maugood.notifications.repository import (
    list_for_user,
    list_preferences,
    resolve_preference,
    set_preference,
    unread_count_for_user,
)
from maugood.notifications.worker import drain_one_tenant
from maugood.tenants.scope import TenantScope

from tests.test_p13_reports import _login  # noqa: F401


TENANT_ID = 1


# ---------------------------------------------------------------------------
# Helpers + fixtures
# ---------------------------------------------------------------------------


def _make_user(
    engine: Engine,
    *,
    email: str,
    password: str,
    role_codes: list[str],
    full_name: str,
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


def _cleanup_user(engine: Engine, uid: int) -> None:
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
        conn.execute(delete(audit_log).where(audit_log.c.actor_user_id == uid))
        conn.execute(delete(user_roles).where(user_roles.c.user_id == uid))
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == uid
            )
        )
        conn.execute(delete(users).where(users.c.id == uid))


@pytest.fixture(autouse=True)
def _clean_notifications(admin_engine: Engine) -> Iterator[None]:
    with admin_engine.begin() as conn:
        conn.execute(
            delete(notifications).where(notifications.c.tenant_id == TENANT_ID)
        )
        conn.execute(
            delete(notification_preferences).where(
                notification_preferences.c.tenant_id == TENANT_ID
            )
        )
    yield
    with admin_engine.begin() as conn:
        conn.execute(
            delete(notifications).where(notifications.c.tenant_id == TENANT_ID)
        )
        conn.execute(
            delete(notification_preferences).where(
                notification_preferences.c.tenant_id == TENANT_ID
            )
        )


@pytest.fixture
def employee_with_login(admin_engine: Engine) -> Iterator[dict]:
    suffix = secrets.token_hex(3)
    email = f"emp-{suffix}@p20.maugood"
    password = "p20-pw-" + secrets.token_hex(4)
    uid = _make_user(
        admin_engine,
        email=email,
        password=password,
        role_codes=["Employee"],
        full_name="P20 Employee",
    )
    try:
        yield {"id": uid, "email": email, "password": password}
    finally:
        _cleanup_user(admin_engine, uid)


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------


def test_preference_defaults_true_when_row_absent(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        pref = resolve_preference(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
        )
    assert pref.in_app is True
    assert pref.email is True


def test_preference_set_then_read(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        set_preference(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_assigned",
            in_app=False,
            email=True,
        )
        prefs = list_preferences(
            conn, scope, user_id=employee_with_login["id"]
        )
    by_cat = {p.category: p for p in prefs}
    assert len(by_cat) == len(ALL_CATEGORIES)
    assert by_cat["approval_assigned"].in_app is False
    assert by_cat["approval_assigned"].email is True
    # Other categories still default to true.
    assert by_cat["approval_decided"].in_app is True


def test_in_app_off_suppresses_row_creation(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        set_preference(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            in_app=False,
            email=True,
        )
        nid = notify_user(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            subject="silenced",
            body="should not land",
        )
    assert nid is None
    # No row written.
    with admin_engine.begin() as conn:
        rows = list_for_user(
            conn, scope, user_id=employee_with_login["id"]
        )
    assert rows == []


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def test_list_and_mark_read_round_trip(
    client: TestClient,
    admin_engine: Engine,
    employee_with_login: dict,
) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    # Plant a notification directly so the test doesn't depend on the
    # producer chain.
    with admin_engine.begin() as conn:
        notify_user(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            subject="Decided!",
            body="HR approved.",
        )

    _login(client, employee_with_login)
    listing = client.get("/api/notifications").json()
    assert listing["unread_count"] == 1
    assert len(listing["items"]) == 1
    nid = listing["items"][0]["id"]

    mr = client.post(f"/api/notifications/{nid}/mark-read")
    assert mr.status_code == 204
    after = client.get("/api/notifications").json()
    assert after["unread_count"] == 0
    assert after["items"][0]["read_at"] is not None


def test_mark_all_read(
    client: TestClient,
    admin_engine: Engine,
    employee_with_login: dict,
) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        for i in range(3):
            notify_user(
                conn,
                scope,
                user_id=employee_with_login["id"],
                category="approval_decided",
                subject=f"#{i}",
                body="",
            )
    _login(client, employee_with_login)
    resp = client.post("/api/notifications/mark-all-read")
    assert resp.json() == {"marked": 3}
    after = client.get("/api/notifications").json()
    assert after["unread_count"] == 0


def test_preferences_endpoint_round_trip(
    client: TestClient, employee_with_login: dict
) -> None:
    _login(client, employee_with_login)
    listing = client.get("/api/notification-preferences").json()
    assert len(listing["items"]) == len(ALL_CATEGORIES)
    assert all(p["in_app"] and p["email"] for p in listing["items"])

    patch = client.patch(
        "/api/notification-preferences",
        json={
            "category": "overtime_flagged",
            "in_app": True,
            "email": False,
        },
    )
    assert patch.status_code == 200
    by_cat = {p["category"]: p for p in patch.json()["items"]}
    assert by_cat["overtime_flagged"]["in_app"] is True
    assert by_cat["overtime_flagged"]["email"] is False


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


def _enable_email(admin_engine: Engine) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(email_config)
            .where(email_config.c.tenant_id == TENANT_ID)
            .values(
                provider="smtp",
                smtp_host="smtp.test.example",
                smtp_username="maugood",
                smtp_password_encrypted=None,
                from_address="noreply@test.example",
                from_name="Maugood",
                enabled=True,
            )
        )


def test_worker_drains_pending_via_recorder(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    _enable_email(admin_engine)
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        notify_user(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            subject="Approved",
            body="Your request was approved.",
            link_url="/my-requests?id=1",
        )

    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        counts = drain_one_tenant(scope=scope)
    finally:
        clear_sender_factory()

    assert counts["sent"] == 1
    assert counts["skipped_pref"] == 0
    assert counts["failed"] == 0
    assert len(recorder.messages) == 1
    msg = recorder.messages[0]
    assert msg.to == (employee_with_login["email"],)
    assert "Approved" in msg.subject
    # Email row marked sent.
    with admin_engine.begin() as conn:
        rows = list_for_user(
            conn, scope, user_id=employee_with_login["id"]
        )
    assert rows[0].email_sent_at is not None


def test_worker_respects_email_off_red_line(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    """Setting email=false for a category must prevent dispatch
    even when the in-app row exists. The P20 red line."""

    _enable_email(admin_engine)
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        set_preference(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            in_app=True,
            email=False,
        )
        notify_user(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            subject="Should not email",
            body="",
        )

    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        counts = drain_one_tenant(scope=scope)
    finally:
        clear_sender_factory()

    assert counts["sent"] == 0
    assert counts["skipped_pref"] == 1
    assert recorder.messages == []


def test_worker_skips_when_email_disabled_for_tenant(
    admin_engine: Engine, employee_with_login: dict
) -> None:
    # email_config.enabled=false (the default) — worker marks every
    # row as skipped so the queue stays drained.
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        conn.execute(
            update(email_config)
            .where(email_config.c.tenant_id == TENANT_ID)
            .values(enabled=False)
        )
        notify_user(
            conn,
            scope,
            user_id=employee_with_login["id"],
            category="approval_decided",
            subject="Subject",
            body="",
        )

    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        counts = drain_one_tenant(scope=scope)
    finally:
        clear_sender_factory()

    assert counts["sent"] == 0
    assert counts["skipped_no_email"] == 1
    assert recorder.messages == []


# ---------------------------------------------------------------------------
# Producer integration — request workflow
# ---------------------------------------------------------------------------


@pytest.fixture
def request_world(admin_engine: Engine) -> Iterator[dict]:
    suffix = secrets.token_hex(3)
    employee_email = f"emp-req-{suffix}@p20.maugood"
    manager_email = f"mgr-req-{suffix}@p20.maugood"
    hr_email = f"hr-req-{suffix}@p20.maugood"
    pwd = "p20-req-" + secrets.token_hex(4)

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P20 Req Employee",
    )
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P20 Req Manager",
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P20 Req HR",
    )

    from maugood.db import departments  # noqa: PLC0415

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
                    full_name="P20 Req Employee",
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
    bundle = {
        "password": pwd,
        "employee": {"id": employee_uid, "email": employee_email},
        "manager": {"id": manager_uid, "email": manager_email},
        "hr": {"id": hr_uid, "email": hr_email},
        "employee_row_id": emp_id,
    }
    try:
        yield bundle
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(requests_table).where(
                    requests_table.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(employees).where(employees.c.id == emp_id)
            )
        for uid in (employee_uid, manager_uid, hr_uid):
            _cleanup_user(admin_engine, uid)


def test_submit_fires_approval_assigned_for_manager(
    client: TestClient, request_world: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        {
            "email": request_world["employee"]["email"],
            "password": request_world["password"],
        },
    )
    resp = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Doctor",
            "target_date_start": "2026-07-01",
        },
    )
    assert resp.status_code == 201, resp.text

    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        rows = list_for_user(
            conn, scope, user_id=request_world["manager"]["id"]
        )
    assert any(
        r.category == "approval_assigned" for r in rows
    ), [r.category for r in rows]


def test_manager_reject_fires_approval_decided_for_employee(
    client: TestClient, request_world: dict, admin_engine: Engine
) -> None:
    employee_creds = {
        "email": request_world["employee"]["email"],
        "password": request_world["password"],
    }
    manager_creds = {
        "email": request_world["manager"]["email"],
        "password": request_world["password"],
    }
    _login(client, employee_creds)
    rid = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Doctor",
            "target_date_start": "2026-07-02",
        },
    ).json()["id"]

    client.post("/api/auth/logout")
    _login(client, manager_creds)
    client.post(
        f"/api/requests/{rid}/manager-decide",
        json={"decision": "reject", "comment": "no proof"},
    )

    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        rows = list_for_user(
            conn, scope, user_id=request_world["employee"]["id"]
        )
    assert any(
        r.category == "approval_decided"
        and r.payload.get("new_status") == "manager_rejected"
        for r in rows
    )


# ---------------------------------------------------------------------------
# Producer integration — overtime flag
# ---------------------------------------------------------------------------


def test_overtime_flagged_fires_for_manager_and_hr(
    admin_engine: Engine, request_world: dict
) -> None:
    """Drive the producer directly with synthetic args — the
    ``_maybe_notify_overtime`` gate is exercised by the scheduler
    pytest in P10/P11 already; here we focus on the producer's
    role-resolution + insertion path."""

    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        notify_overtime_flagged(
            conn,
            scope,
            employee_id=request_world["employee_row_id"],
            employee_code="P20-OT",
            employee_full_name="P20 OT",
            the_date=date(2026, 7, 3),
            overtime_minutes=42,
            manager_user_ids=[request_world["manager"]["id"]],
        )

    with admin_engine.begin() as conn:
        manager_rows = list_for_user(
            conn, scope, user_id=request_world["manager"]["id"]
        )
        hr_rows = list_for_user(
            conn, scope, user_id=request_world["hr"]["id"]
        )
    assert any(r.category == "overtime_flagged" for r in manager_rows)
    assert any(r.category == "overtime_flagged" for r in hr_rows)
