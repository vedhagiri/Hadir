"""Tests for v1.0 P18 — scheduled reports + email.

Three suites:

1. Pure helpers — secret round-trip, signed-URL HMAC, cron parsing.
2. Email config + schedule CRUD — secrets never appear in API
   responses, ``has_*`` flags flip, ``test`` endpoint dispatches via
   the recording sender.
3. End-to-end run-now — schedule + recording sender + DB row check.
"""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.config import get_settings
from maugood.db import (
    attendance_records,
    email_config,
    employees,
    notifications,
    report_runs,
    report_schedules,
    shift_policies,
)
from maugood.emailing import (
    EmailMessage,
    RecordingSender,
    clear_sender_factory,
    set_sender_factory,
)
from maugood.emailing.secrets import decrypt_secret, encrypt_secret
from maugood.scheduled_reports.runner import compute_next_run
from maugood.scheduled_reports.signed_url import (
    TokenError,
    make_token,
    validate_token,
)


# Shared P13 helper (logs in via the auth router).
from tests.test_p13_reports import _login, seeded_attendance  # noqa: F401


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_secret_round_trip_through_fernet() -> None:
    plain = "very-secret-password-321"
    cipher = encrypt_secret(plain)
    assert cipher
    assert cipher != plain
    assert decrypt_secret(cipher) == plain


def test_secret_empty_in_empty_out() -> None:
    assert encrypt_secret("") == ""
    assert decrypt_secret("") == ""
    assert decrypt_secret(None) == ""


def test_signed_url_token_round_trip_and_tamper() -> None:
    token = make_token(run_id=42, ttl_seconds=600)
    validate_token(token, expected_run_id=42)

    with pytest.raises(TokenError):
        validate_token(token, expected_run_id=43)

    # Tamper the signature
    parts = token.split(".")
    bad = ".".join([parts[0], parts[1], parts[2][:-1] + ("A" if parts[2][-1] != "A" else "B")])
    with pytest.raises(TokenError):
        validate_token(bad, expected_run_id=42)


def test_signed_url_token_expiry() -> None:
    # ttl_seconds=-1 → the token's exp is already in the past.
    token = make_token(run_id=1, ttl_seconds=-1)
    with pytest.raises(TokenError):
        validate_token(token, expected_run_id=1)


def test_compute_next_run_picks_future() -> None:
    base = datetime(2026, 5, 4, 7, 30, tzinfo=timezone.utc)
    nxt = compute_next_run("0 8 * * *", after=base)
    assert nxt.tzinfo is not None
    assert nxt > base
    assert nxt.hour == 8 and nxt.minute == 0


# ---------------------------------------------------------------------------
# Email config CRUD
# ---------------------------------------------------------------------------


def test_email_config_get_default_response_no_secrets(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/email-config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] in ("smtp", "microsoft_graph")
    # Hard requirement — no plain-text secret keys ever surface.
    assert "smtp_password" not in body
    assert "graph_client_secret" not in body
    assert "smtp_password_encrypted" not in body
    assert "graph_client_secret_encrypted" not in body
    assert body["has_smtp_password"] is False
    assert body["has_graph_client_secret"] is False


def test_email_config_patch_rotates_secret_and_sets_flag(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    resp = client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "smtp_host": "smtp.test.example",
            "smtp_username": "maugood@test.example",
            "smtp_password": "rotation-1",
            "from_address": "noreply@test.example",
            "from_name": "Maugood",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["has_smtp_password"] is True
    assert body["smtp_host"] == "smtp.test.example"

    # Backing column is ciphertext, not the input string.
    with admin_engine.begin() as conn:
        cipher = conn.execute(
            select(email_config.c.smtp_password_encrypted).where(
                email_config.c.tenant_id == 1
            )
        ).scalar_one()
    assert cipher and "rotation-1" not in cipher
    assert decrypt_secret(cipher) == "rotation-1"

    # Empty smtp_password keeps the existing ciphertext (UI knows
    # this — ``***`` placeholder).
    resp2 = client.patch(
        "/api/email-config",
        json={"smtp_password": ""},
    )
    assert resp2.status_code == 200
    with admin_engine.begin() as conn:
        cipher2 = conn.execute(
            select(email_config.c.smtp_password_encrypted).where(
                email_config.c.tenant_id == 1
            )
        ).scalar_one()
    assert cipher2 == cipher


def test_email_config_patch_employee_403(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.patch(
        "/api/email-config",
        json={"smtp_host": "x"},
    )
    assert resp.status_code == 403


def test_email_config_test_endpoint_uses_recording_sender(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    # Configure from_address.
    client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "from_address": "noreply@test.example",
            "from_name": "Maugood",
            "enabled": True,
        },
    )

    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        resp = client.post(
            "/api/email-config/test", json={"to": "you@example.com"}
        )
    finally:
        clear_sender_factory()
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    assert len(recorder.messages) == 1
    msg = recorder.messages[0]
    assert msg.to == ("you@example.com",)
    assert "Maugood" in msg.subject


# ---------------------------------------------------------------------------
# Schedule CRUD
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_email_config(admin_engine: Engine) -> Iterator[None]:
    """Each test starts with a default email_config row — no host,
    no secrets, provider=smtp, enabled=false."""

    def _reset() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                update(email_config)
                .where(email_config.c.tenant_id == 1)
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

    _reset()
    yield
    _reset()


@pytest.fixture
def clean_schedules(admin_engine: Engine) -> Iterator[None]:
    with admin_engine.begin() as conn:
        conn.execute(delete(report_runs).where(report_runs.c.tenant_id == 1))
        conn.execute(
            delete(report_schedules).where(report_schedules.c.tenant_id == 1)
        )
        conn.execute(
            delete(notifications).where(
                notifications.c.tenant_id == 1
            )
        )
    yield
    with admin_engine.begin() as conn:
        conn.execute(delete(report_runs).where(report_runs.c.tenant_id == 1))
        conn.execute(
            delete(report_schedules).where(report_schedules.c.tenant_id == 1)
        )
        conn.execute(
            delete(notifications).where(
                notifications.c.tenant_id == 1
            )
        )


@pytest.mark.usefixtures("clean_schedules")
def test_schedule_crud_round_trip(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    create = client.post(
        "/api/report-schedules",
        json={
            "name": "Weekly attendance",
            "format": "pdf",
            "filter_config": {"window_days": 7},
            "recipients": ["hr@test.example"],
            "schedule_cron": "0 8 * * 1",
        },
    )
    assert create.status_code == 201, create.text
    sched = create.json()
    assert sched["next_run_at"] is not None
    assert sched["active"] is True

    listing = client.get("/api/report-schedules").json()
    assert any(s["id"] == sched["id"] for s in listing)

    patch = client.patch(
        f"/api/report-schedules/{sched['id']}",
        json={"active": False},
    )
    assert patch.status_code == 200
    assert patch.json()["active"] is False

    delete_resp = client.delete(f"/api/report-schedules/{sched['id']}")
    assert delete_resp.status_code == 204
    after = client.get("/api/report-schedules").json()
    assert all(s["id"] != sched["id"] for s in after)


@pytest.mark.usefixtures("clean_schedules")
def test_schedule_create_rejects_invalid_cron(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.post(
        "/api/report-schedules",
        json={
            "name": "Bad",
            "format": "pdf",
            "recipients": ["hr@test.example"],
            "schedule_cron": "this is not cron",
        },
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Run-now end-to-end
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_schedules")
def test_run_now_attached_path_records_run_and_email(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded_attendance,
) -> None:
    _login(client, admin_user)
    # Configure email + a schedule.
    client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "smtp_host": "smtp.test.example",
            "smtp_password": "ignored-by-recorder",
            "from_address": "noreply@test.example",
            "from_name": "Maugood",
            "enabled": True,
        },
    )
    today = seeded_attendance["today"]
    create = client.post(
        "/api/report-schedules",
        json={
            "name": "Daily PDF",
            "format": "pdf",
            "filter_config": {"window_days": 7},
            "recipients": ["hr@test.example", "boss@test.example"],
            "schedule_cron": "0 8 * * *",
        },
    )
    schedule_id = create.json()["id"]

    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        resp = client.post(
            f"/api/report-schedules/{schedule_id}/run-now",
            json={},
        )
    finally:
        clear_sender_factory()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "succeeded"
    assert body["delivery_mode"] == "attached"
    assert sorted(body["recipients_delivered_to"]) == [
        "boss@test.example",
        "hr@test.example",
    ]

    # Sender captured one message with one PDF attachment.
    assert len(recorder.messages) == 1
    msg = recorder.messages[0]
    assert sorted(msg.to) == sorted(body["recipients_delivered_to"])
    assert len(msg.attachments) == 1
    fname, ctype, data = msg.attachments[0]
    assert fname.endswith(".pdf")
    assert ctype == "application/pdf"
    assert data.startswith(b"%PDF-")

    # Run row updated, schedule's last_run_status is succeeded.
    with admin_engine.begin() as conn:
        run_row = conn.execute(
            select(
                report_runs.c.status,
                report_runs.c.delivery_mode,
                report_runs.c.recipients_delivered_to,
                report_runs.c.file_size_bytes,
            ).where(report_runs.c.id == body["id"])
        ).first()
        sched_row = conn.execute(
            select(
                report_schedules.c.last_run_status,
                report_schedules.c.next_run_at,
            ).where(report_schedules.c.id == schedule_id)
        ).first()
    assert run_row.status == "succeeded"
    assert run_row.delivery_mode == "attached"
    assert run_row.file_size_bytes is not None
    assert sched_row.last_run_status == "succeeded"
    assert sched_row.next_run_at is not None


@pytest.mark.usefixtures("clean_schedules")
def test_run_now_link_path_when_over_threshold(
    client: TestClient,
    admin_user: dict,
    seeded_attendance,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Drop the size cap to 0 MB so even a tiny PDF crosses the
    threshold and the runner falls back to the link delivery path.
    """

    _login(client, admin_user)
    client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "smtp_host": "smtp.test.example",
            "smtp_password": "x",
            "from_address": "noreply@test.example",
            "enabled": True,
        },
    )
    create = client.post(
        "/api/report-schedules",
        json={
            "name": "Big report",
            "format": "pdf",
            "recipients": ["hr@test.example"],
            "schedule_cron": "0 8 * * *",
        },
    )
    schedule_id = create.json()["id"]

    # ``get_settings()`` rebuilds from env per call; setting the env
    # var here flips the threshold for the runner's read.
    monkeypatch.setenv("MAUGOOD_EMAIL_ATTACHMENT_MAX_MB", "0")
    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        resp = client.post(
            f"/api/report-schedules/{schedule_id}/run-now",
            json={},
        )
    finally:
        clear_sender_factory()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "succeeded"
    assert body["delivery_mode"] == "link"
    msg = recorder.messages[0]
    assert msg.attachments == ()
    # The HTML body must contain the signed URL the runner generated.
    assert "/api/reports/runs/" in msg.html
    assert "token=" in msg.html


# ---------------------------------------------------------------------------
# Signed URL endpoint
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_schedules")
def test_signed_url_download_endpoint_streams_file(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded_attendance,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _login(client, admin_user)
    client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "smtp_host": "smtp.test.example",
            "smtp_password": "x",
            "from_address": "noreply@test.example",
            "enabled": True,
        },
    )
    create = client.post(
        "/api/report-schedules",
        json={
            "name": "DL test",
            "format": "pdf",
            "recipients": ["hr@test.example"],
            "schedule_cron": "0 8 * * *",
        },
    )
    schedule_id = create.json()["id"]

    monkeypatch.setenv("MAUGOOD_EMAIL_ATTACHMENT_MAX_MB", "0")
    recorder = RecordingSender()
    set_sender_factory(lambda _cfg: recorder)
    try:
        run = client.post(
            f"/api/report-schedules/{schedule_id}/run-now",
            json={},
        ).json()
    finally:
        clear_sender_factory()

    run_id = run["id"]
    token = make_token(run_id=run_id)
    # Anonymous (no auth cookies) — the token is the gate.
    client.cookies.clear()
    resp = client.get(
        f"/api/reports/runs/{run_id}/download?token={token}"
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/pdf")
    assert resp.content.startswith(b"%PDF-")


def test_signed_url_rejects_bad_token(client: TestClient) -> None:
    client.cookies.clear()
    resp = client.get("/api/reports/runs/9999/download?token=not-a-token")
    assert resp.status_code == 403


def test_signed_url_rejects_run_id_mismatch(client: TestClient) -> None:
    client.cookies.clear()
    token = make_token(run_id=1)
    resp = client.get(f"/api/reports/runs/2/download?token={token}")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Belt-and-braces — secrets never logged through the audit log either.
# ---------------------------------------------------------------------------


def test_audit_for_email_patch_does_not_carry_secret(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    resp = client.patch(
        "/api/email-config",
        json={
            "provider": "smtp",
            "smtp_password": "do-not-log-this",
            "from_address": "x@test.example",
        },
    )
    assert resp.status_code == 200
    from maugood.db import audit_log  # noqa: PLC0415

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.tenant_id == 1,
                audit_log.c.action == "email_config.updated",
            ).order_by(audit_log.c.id.desc()).limit(1)
        ).all()
    assert rows
    payload = rows[0].after or {}
    blob = str(payload).lower()
    assert "do-not-log-this" not in blob
    assert payload.get("smtp_password_rotated") is True
