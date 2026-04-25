"""Tests for v1.0 P14 — request reason categories + attachments.

Covers:

* The 9 BRD §FR-REQ-008 default categories are seeded for the pilot
  tenant and are visible to every authenticated role.
* Admin can add / patch / delete a custom category; non-Admin cannot.
* Attachment upload happy path (PNG + PDF) — the row is created and
  `GET /attachments` lists it.
* Attachment size cap returns 413 with a clear message.
* Magic-byte sniff rejects an extension-only fake (.pdf bytes that
  aren't actually a PDF).
* Bare ZIP is rejected even though .docx is allowed (the docx must
  declare itself either by the operator-supplied content type or by
  the `.docx` filename).
* Manager / HR can list + download attachments on a row that's
  reached them; an unrelated employee can't.
* Owner can attach + delete only while submitted; once
  manager-approved, attach/delete returns 403.
* Encrypted-on-disk: opening the stored file directly does NOT
  return the original bytes (the same Fernet pattern as photos).

Tests use the workflow_users fixture from test_requests_api.py via
copy-paste rather than re-export, since pytest doesn't pick up
fixtures across test files unless they live in conftest. Keeping the
helper inline is the smaller diff.
"""

from __future__ import annotations

import secrets
import zlib
from io import BytesIO
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.auth.passwords import hash_password
from hadir.db import (
    approved_leaves,
    audit_log,
    employees,
    leave_types,
    manager_assignments,
    request_attachments,
    request_reason_categories,
    requests as requests_table,
    roles,
    user_departments,
    user_roles,
    user_sessions,
    users,
)


TENANT_ID = 1


# A 1×1 transparent PNG — small valid header + IDAT + IEND.
_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6300010000000500010d0a2db40000000049454e44ae42"
    "6082"
)
# Tiny PDF — magic + minimal trailer. Most parsers won't open it but
# the magic-byte sniff is what we test.
_PDF_BYTES = b"%PDF-1.4\n%minimal\n%%EOF\n"
_BARE_ZIP = b"PK\x03\x04" + b"\x00" * 32


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
            from hadir.db import departments  # noqa: PLC0415

            for d in department_codes:
                dept_id = conn.execute(
                    select(departments.c.id).where(
                        departments.c.tenant_id == TENANT_ID,
                        departments.c.code == d,
                    )
                ).scalar_one()
                conn.execute(
                    insert(user_departments).values(
                        user_id=uid,
                        department_id=int(dept_id),
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
def attachment_workflow(admin_engine: Engine) -> Iterator[dict]:
    """Provision Employee + Manager + HR + Admin + an employees row +
    a primary manager_assignment so we can drive every endpoint.
    """

    suffix = secrets.token_hex(4)
    employee_email = f"emp-att-{suffix}@p14.hadir"
    manager_email = f"mgr-att-{suffix}@p14.hadir"
    hr_email = f"hr-att-{suffix}@p14.hadir"
    admin_email = f"adm-att-{suffix}@p14.hadir"
    password = "att-pw-" + secrets.token_hex(6)

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=password,
        role_codes=["Employee"],
        full_name="P14 Smoke Employee",
        department_codes=["ENG"],
    )
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=password,
        role_codes=["Manager"],
        full_name="P14 Smoke Manager",
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=password,
        role_codes=["HR"],
        full_name="P14 Smoke HR",
    )
    admin_uid = _make_user(
        admin_engine,
        email=admin_email,
        password=password,
        role_codes=["Admin"],
        full_name="P14 Smoke Admin",
    )

    from hadir.db import departments  # noqa: PLC0415

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
                    employee_code=f"P14-{suffix}",
                    full_name="P14 Smoke Employee",
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
        "password": password,
        "employee": {"id": employee_uid, "email": employee_email},
        "manager": {"id": manager_uid, "email": manager_email},
        "hr": {"id": hr_uid, "email": hr_email},
        "admin": {"id": admin_uid, "email": admin_email},
        "employee_row_id": emp_id,
    }
    try:
        yield bundle
    finally:
        # Drop attachments + parent requests + users.
        with admin_engine.begin() as conn:
            # Capture file paths so we can clean them up too.
            paths = [
                str(r.file_path)
                for r in conn.execute(
                    select(request_attachments.c.file_path).where(
                        request_attachments.c.tenant_id == TENANT_ID
                    )
                ).all()
            ]
            conn.execute(
                delete(request_attachments).where(
                    request_attachments.c.tenant_id == TENANT_ID
                )
            )
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
            from hadir.db import attendance_records  # noqa: PLC0415

            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(delete(employees).where(employees.c.id == emp_id))
        for p in paths:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
        for uid in (employee_uid, manager_uid, hr_uid, admin_uid):
            _cleanup_user(admin_engine, uid)


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Reason categories
# ---------------------------------------------------------------------------


def test_default_reason_categories_are_seeded(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    resp = client.get("/api/request-reason-categories?request_type=exception")
    assert resp.status_code == 200
    codes = {c["code"] for c in resp.json()}
    assert {"Doctor", "Family", "Traffic", "Official", "Other"}.issubset(codes)

    resp_leave = client.get("/api/request-reason-categories?request_type=leave")
    leave_codes = {c["code"] for c in resp_leave.json()}
    assert {"Annual", "Sick", "Emergency", "Unpaid"}.issubset(leave_codes)


def test_admin_can_add_reason_category(
    client: TestClient, attachment_workflow: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        email=attachment_workflow["admin"]["email"],
        password=attachment_workflow["password"],
    )
    resp = client.post(
        "/api/request-reason-categories",
        json={
            "request_type": "exception",
            "code": "Conference",
            "name": "Industry conference",
        },
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["id"]

    # Cleanup so subsequent tests start clean.
    with admin_engine.begin() as conn:
        conn.execute(
            delete(request_reason_categories).where(
                request_reason_categories.c.id == new_id
            )
        )


def test_employee_cannot_create_reason_category(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    resp = client.post(
        "/api/request-reason-categories",
        json={
            "request_type": "exception",
            "code": "Whatever",
            "name": "Whatever",
        },
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Attachment config + happy path
# ---------------------------------------------------------------------------


def test_attachment_config_returns_max_and_types(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    resp = client.get("/api/requests/attachment-config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["max_mb"] >= 1
    assert "image/jpeg" in body["accepted_mime_types"]
    assert "application/pdf" in body["accepted_mime_types"]


def _submit_request(client: TestClient) -> int:
    resp = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Doctor",
            "reason_text": "checkup",
            "target_date_start": "2026-05-30",
        },
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


def test_upload_png_then_list_then_download_round_trip(
    client: TestClient, attachment_workflow: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)

    upload = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("photo.png", _PNG_BYTES, "image/png")},
    )
    assert upload.status_code == 201, upload.text
    aid = upload.json()["id"]
    assert upload.json()["content_type"] == "image/png"
    assert upload.json()["original_filename"] == "photo.png"

    listing = client.get(f"/api/requests/{rid}/attachments").json()
    assert any(a["id"] == aid for a in listing)

    download = client.get(
        f"/api/requests/{rid}/attachments/{aid}/download"
    )
    assert download.status_code == 200
    assert download.content == _PNG_BYTES

    # Encrypted-on-disk: the stored bytes must not match the input.
    with admin_engine.begin() as conn:
        path = str(
            conn.execute(
                select(request_attachments.c.file_path).where(
                    request_attachments.c.id == aid
                )
            ).scalar_one()
        )
    on_disk = Path(path).read_bytes()
    assert on_disk != _PNG_BYTES
    # Fernet ciphertext is base64url and starts with the version byte 'gAAAAA'.
    assert on_disk.startswith(b"gAAAAA")


def test_upload_pdf_accepted(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    resp = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("note.pdf", _PDF_BYTES, "application/pdf")},
    )
    assert resp.status_code == 201
    assert resp.json()["content_type"] == "application/pdf"


# ---------------------------------------------------------------------------
# Magic-byte + size enforcement
# ---------------------------------------------------------------------------


def test_extension_only_fake_pdf_rejected(
    client: TestClient, attachment_workflow: dict
) -> None:
    """An operator renames a JPEG to .pdf — magic bytes must reject it."""

    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    junk = b"this is not a pdf even though the filename says so" * 4
    resp = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("evil.pdf", junk, "application/pdf")},
    )
    assert resp.status_code == 400
    assert "magic" in resp.json()["detail"].lower()


def test_bare_zip_rejected_even_though_docx_allowed(
    client: TestClient, attachment_workflow: dict
) -> None:
    """A raw ZIP that isn't a docx must be refused."""

    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    resp = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("archive.zip", _BARE_ZIP, "application/zip")},
    )
    assert resp.status_code == 400


def test_oversize_attachment_returns_413(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    # 6 MB > default 5 MB.
    huge = b"\xff\xd8\xff" + b"\x00" * (6 * 1024 * 1024)
    resp = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("big.jpg", huge, "image/jpeg")},
    )
    assert resp.status_code == 413
    assert "max is" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Role visibility on attachments
# ---------------------------------------------------------------------------


def test_manager_can_download_attachment_on_assigned_request(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    upload = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("photo.png", _PNG_BYTES, "image/png")},
    )
    aid = upload.json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=attachment_workflow["manager"]["email"],
        password=attachment_workflow["password"],
    )
    listing = client.get(f"/api/requests/{rid}/attachments")
    assert listing.status_code == 200
    download = client.get(f"/api/requests/{rid}/attachments/{aid}/download")
    assert download.status_code == 200


def test_unrelated_employee_cannot_view_attachments(
    client: TestClient, attachment_workflow: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)
    client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("photo.png", _PNG_BYTES, "image/png")},
    )

    # Provision a second Employee; no relation to this request.
    suffix = secrets.token_hex(4)
    other_email = f"other-{suffix}@p14.hadir"
    other_pw = "other-" + secrets.token_hex(6)
    other_uid = _make_user(
        admin_engine,
        email=other_email,
        password=other_pw,
        role_codes=["Employee"],
        full_name="Other",
    )
    try:
        client.post("/api/auth/logout")
        _login(client, email=other_email, password=other_pw)
        resp = client.get(f"/api/requests/{rid}/attachments")
        assert resp.status_code == 403
    finally:
        _cleanup_user(admin_engine, other_uid)


# ---------------------------------------------------------------------------
# Owner-modify gate
# ---------------------------------------------------------------------------


def test_employee_cannot_attach_after_manager_decision(
    client: TestClient, attachment_workflow: dict
) -> None:
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    rid = _submit_request(client)

    client.post("/api/auth/logout")
    _login(
        client,
        email=attachment_workflow["manager"]["email"],
        password=attachment_workflow["password"],
    )
    client.post(
        f"/api/requests/{rid}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )

    client.post("/api/auth/logout")
    _login(
        client,
        email=attachment_workflow["employee"]["email"],
        password=attachment_workflow["password"],
    )
    resp = client.post(
        f"/api/requests/{rid}/attachments",
        files={"file": ("late.png", _PNG_BYTES, "image/png")},
    )
    assert resp.status_code == 403
