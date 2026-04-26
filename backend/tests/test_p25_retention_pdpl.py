"""P25 — log rotation + retention cleanup + PDPL delete.

Three groups of tests:

  1. ``GzipRotatingFileHandler`` rotates + gzips correctly.
  2. ``run_retention_sweep`` deletes the four target tables
     under their respective cutoffs and **never** touches the
     protected tables (audit_log, attendance_records,
     detection_events, employees, requests).
  3. The PDPL delete endpoint redacts PII, drops photos +
     custom_field_values, refuses without the confirmation
     phrase, and writes a ``pdpl_delete`` audit row.
"""

from __future__ import annotations

import gzip
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import delete, insert, select

from hadir.db import (
    audit_log,
    camera_health_snapshots,
    cameras,
    custom_field_values,
    custom_fields,
    departments,
    employee_photos,
    employees,
    notifications,
    report_runs,
    user_sessions,
)
from hadir.employees import pdpl as pdpl_module
from hadir.logging_config import (
    GzipRotatingFileHandler,
    audit_logger,
    configure_logging,
)
from hadir.retention.sweep import run_retention_sweep
from hadir.tenants.scope import TenantScope


TENANT_ID = 1


# ---- 1. log rotation -------------------------------------------------


def test_gzip_rotating_handler_compresses_on_rollover(tmp_path: Path) -> None:
    log_file = tmp_path / "app.log"
    handler = GzipRotatingFileHandler(
        str(log_file),
        when="S",  # the smallest interval the stdlib understands
        interval=1,
        backup_count=3,
    )
    logger = logging.getLogger(f"p25.rotation.{secrets.token_hex(3)}")
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False

    logger.info("first line — pre-rotation")
    # Force the rollover by hand. The TimedRotatingFileHandler
    # only rotates when ``record.created >= rolloverAt``; rather
    # than wait for the wall clock, we trigger the rollover
    # directly which exercises the same code path.
    handler.doRollover()
    logger.info("second line — post-rotation")
    handler.close()

    # The rotated file must be ``.gz``; the plain rotated copy
    # must be gone; the active log gets the post-rotation line.
    rotated = sorted(p for p in tmp_path.iterdir() if p.suffix == ".gz")
    assert rotated, f"no gz file produced: {list(tmp_path.iterdir())}"
    plain_rotated = [
        p
        for p in tmp_path.iterdir()
        if p.name.startswith("app.log.") and p.suffix != ".gz"
    ]
    assert not plain_rotated, f"plain rotated copy survived: {plain_rotated}"

    # The gz roundtrips.
    contents = gzip.decompress(rotated[0].read_bytes()).decode("utf-8")
    assert "first line" in contents
    assert log_file.exists()
    assert "second line" in log_file.read_text()


def test_configure_logging_creates_audit_logger(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HADIR_LOG_DISABLE_FILES", "0")
    monkeypatch.setenv("HADIR_LOG_DIR", str(tmp_path))
    configure_logging(log_dir=tmp_path, enable_files=True, backup_count=3)
    try:
        audit_logger().info("hello from p25 audit")
        # Force flush by closing handlers.
        for h in list(audit_logger().handlers):
            h.flush()
        audit_path = tmp_path / "audit.log"
        assert audit_path.exists()
        assert "hello from p25 audit" in audit_path.read_text()
        assert "hello from p25 audit" not in (tmp_path / "app.log").read_text()
    finally:
        # Restore stdout-only logging for the rest of the suite.
        configure_logging(enable_files=False)


# ---- 2. retention sweep ---------------------------------------------


def test_retention_sweep_deletes_old_camera_health(admin_engine):
    """Insert old + recent ``camera_health_snapshots`` rows;
    confirm the old row is gone, the recent one stays."""

    now = datetime.now(timezone.utc)
    old = now - timedelta(days=45)
    recent = now - timedelta(days=5)

    with admin_engine.begin() as conn:
        # Need a camera row for the FK target.
        cam_id = int(
            conn.execute(
                insert(cameras)
                .values(
                    tenant_id=TENANT_ID,
                    name=f"p25-cam-{secrets.token_hex(3)}",
                    location="rehearsal",
                    rtsp_url_encrypted="cipher",
                    worker_enabled=False,
                )
                .returning(cameras.c.id)
            ).scalar_one()
        )
        old_id = int(
            conn.execute(
                insert(camera_health_snapshots)
                .values(
                    tenant_id=TENANT_ID,
                    camera_id=cam_id,
                    captured_at=old,
                    frames_last_minute=0,
                    reachable=False,
                )
                .returning(camera_health_snapshots.c.id)
            ).scalar_one()
        )
        recent_id = int(
            conn.execute(
                insert(camera_health_snapshots)
                .values(
                    tenant_id=TENANT_ID,
                    camera_id=cam_id,
                    captured_at=recent,
                    frames_last_minute=42,
                    reachable=True,
                )
                .returning(camera_health_snapshots.c.id)
            ).scalar_one()
        )

    try:
        result = run_retention_sweep(admin_engine, now=now)
        per = next(r for r in result.per_tenant if r.tenant_id == TENANT_ID)
        assert per.camera_health_deleted >= 1, per
    finally:
        with admin_engine.begin() as conn:
            ids = conn.execute(
                select(camera_health_snapshots.c.id).where(
                    camera_health_snapshots.c.id.in_([old_id, recent_id])
                )
            ).all()
            surviving_ids = {int(r.id) for r in ids}
            # Cleanup what's left + the camera row.
            conn.execute(
                delete(camera_health_snapshots).where(
                    camera_health_snapshots.c.camera_id == cam_id
                )
            )
            conn.execute(delete(cameras).where(cameras.c.id == cam_id))

    assert old_id not in surviving_ids, "old snapshot should have been deleted"
    assert recent_id in surviving_ids, "recent snapshot must NOT be deleted"


def test_retention_sweep_deletes_expired_user_sessions(admin_engine):
    now = datetime.now(timezone.utc)
    expired_long = now - timedelta(days=30)
    expired_recent = now - timedelta(days=2)

    sid_long = f"p25-{secrets.token_hex(8)}"
    sid_recent = f"p25-{secrets.token_hex(8)}"

    # Need a real user_id for the FK. Resolve from
    # ``main.users`` — robust to a wiped DB where the
    # historic id=1 admin has been replaced by a freshly-
    # seeded one (P28-followup: pre_omran_reset_seed.py
    # invalidates the previous fixture assumption).
    from hadir.db import users as users_t  # noqa: PLC0415

    with admin_engine.begin() as conn:
        any_user = conn.execute(
            select(users_t.c.id).where(users_t.c.tenant_id == TENANT_ID)
            .order_by(users_t.c.id).limit(1)
        ).scalar_one_or_none()
        if any_user is None:
            pytest.skip(
                "no user in main schema — seed an admin before running this test"
            )
        user_id = int(any_user)
        conn.execute(
            insert(user_sessions).values(
                id=sid_long,
                tenant_id=TENANT_ID,
                user_id=user_id,
                created_at=expired_long - timedelta(hours=1),
                expires_at=expired_long,
                data={},
            )
        )
        conn.execute(
            insert(user_sessions).values(
                id=sid_recent,
                tenant_id=TENANT_ID,
                user_id=user_id,
                created_at=expired_recent - timedelta(hours=1),
                expires_at=expired_recent,
                data={},
            )
        )

    try:
        result = run_retention_sweep(admin_engine, now=now)
        per = next(r for r in result.per_tenant if r.tenant_id == TENANT_ID)
        assert per.user_sessions_deleted >= 1, per
        with admin_engine.begin() as conn:
            present = {
                str(r.id)
                for r in conn.execute(
                    select(user_sessions.c.id).where(
                        user_sessions.c.id.in_([sid_long, sid_recent])
                    )
                ).all()
            }
        assert sid_long not in present
        assert sid_recent in present
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(user_sessions).where(
                    user_sessions.c.id.in_([sid_long, sid_recent])
                )
            )


def test_retention_sweep_never_touches_protected_tables(admin_engine):
    """Snapshot row counts on the protected tables before/after
    the sweep; counts must not decrease.

    Audit log is allowed to *grow* (the sweep itself writes a
    ``retention.swept`` row when anything was deleted).
    """

    from hadir.db import (  # noqa: PLC0415
        attendance_records,
        approved_leaves,
        detection_events,
        employees as employees_t,
        employee_photos as photos_t,
        requests as requests_t,
    )

    with admin_engine.begin() as conn:
        before = {
            "audit_log": int(
                conn.execute(select(audit_log.c.id).order_by(audit_log.c.id)).rowcount or 0
            ),
            "attendance_records": int(
                conn.execute(
                    select(attendance_records.c.id)
                ).rowcount or 0
            ),
            "detection_events": int(
                conn.execute(
                    select(detection_events.c.id)
                ).rowcount or 0
            ),
            "employees": int(
                conn.execute(select(employees_t.c.id)).rowcount or 0
            ),
            "employee_photos": int(
                conn.execute(select(photos_t.c.id)).rowcount or 0
            ),
            "requests": int(
                conn.execute(select(requests_t.c.id)).rowcount or 0
            ),
            "approved_leaves": int(
                conn.execute(
                    select(approved_leaves.c.id)
                ).rowcount or 0
            ),
        }

    run_retention_sweep(admin_engine)

    with admin_engine.begin() as conn:
        after = {
            "audit_log": int(
                conn.execute(select(audit_log.c.id)).rowcount or 0
            ),
            "attendance_records": int(
                conn.execute(
                    select(attendance_records.c.id)
                ).rowcount or 0
            ),
            "detection_events": int(
                conn.execute(
                    select(detection_events.c.id)
                ).rowcount or 0
            ),
            "employees": int(
                conn.execute(select(employees_t.c.id)).rowcount or 0
            ),
            "employee_photos": int(
                conn.execute(select(photos_t.c.id)).rowcount or 0
            ),
            "requests": int(
                conn.execute(select(requests_t.c.id)).rowcount or 0
            ),
            "approved_leaves": int(
                conn.execute(
                    select(approved_leaves.c.id)
                ).rowcount or 0
            ),
        }

    # Audit log can grow (the sweep writes retention.swept),
    # the rest must be at least equal.
    assert after["audit_log"] >= before["audit_log"]
    for k in (
        "attendance_records",
        "detection_events",
        "employees",
        "employee_photos",
        "requests",
        "approved_leaves",
    ):
        assert after[k] >= before[k], f"{k} shrunk: {before[k]} -> {after[k]}"


# ---- 3. PDPL delete -------------------------------------------------


@pytest.fixture
def created_employee(admin_engine):
    """Insert a fresh employee + a couple of related rows that
    PDPL should sweep up. Yields the employee_id; cleans up
    leftover rows on teardown."""

    with admin_engine.begin() as conn:
        dept_id = int(
            conn.execute(
                select(departments.c.id)
                .where(departments.c.tenant_id == TENANT_ID)
                .order_by(departments.c.id)
                .limit(1)
            ).scalar_one()
        )
        suffix = secrets.token_hex(3)
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P25EMP{suffix}",
                    full_name="Original Person",
                    email=f"original-{suffix}@hadir.local",
                    department_id=dept_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        # An "encrypted" photo file we'll delete.
        from tempfile import NamedTemporaryFile  # noqa: PLC0415

        photo_path = Path(
            "/tmp"
            f"/p25-photo-{suffix}-{secrets.token_hex(3)}.bin"
        )
        photo_path.write_bytes(b"ciphertext-not-real")
        photo_id = int(
            conn.execute(
                insert(employee_photos)
                .values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    angle="front",
                    file_path=str(photo_path),
                )
                .returning(employee_photos.c.id)
            ).scalar_one()
        )
        # A custom field + a value row.
        field_id = int(
            conn.execute(
                insert(custom_fields)
                .values(
                    tenant_id=TENANT_ID,
                    name="P25 Test",
                    code=f"p25_{suffix}",
                    type="text",
                    options=None,
                    required=False,
                    display_order=999,
                )
                .returning(custom_fields.c.id)
            ).scalar_one()
        )
        cfv_id = int(
            conn.execute(
                insert(custom_field_values)
                .values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    field_id=field_id,
                    value="some-pii-value",
                )
                .returning(custom_field_values.c.id)
            ).scalar_one()
        )

    yield {
        "employee_id": emp_id,
        "photo_id": photo_id,
        "photo_path": photo_path,
        "field_id": field_id,
        "cfv_id": cfv_id,
        "suffix": suffix,
    }

    # Teardown — best-effort; PDPL delete may have already
    # cleaned most of this up.
    try:
        photo_path.unlink()
    except OSError:
        pass
    with admin_engine.begin() as conn:
        conn.execute(
            delete(custom_field_values).where(
                custom_field_values.c.field_id == field_id
            )
        )
        conn.execute(
            delete(custom_fields).where(custom_fields.c.id == field_id)
        )
        conn.execute(
            delete(employee_photos).where(employee_photos.c.employee_id == emp_id)
        )
        conn.execute(delete(employees).where(employees.c.id == emp_id))


def test_pdpl_delete_endpoint_redacts_and_drops(
    admin_engine, admin_user, client, created_employee
):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200, resp.text

    emp_id = created_employee["employee_id"]
    photo_path: Path = created_employee["photo_path"]
    assert photo_path.exists(), "fixture should have created the photo file"

    resp = client.post(
        f"/api/employees/{emp_id}/gdpr-delete",
        json={"confirmation": pdpl_module.PDPL_CONFIRMATION_PHRASE},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "deleted"
    assert body["photo_rows_deleted"] == 1
    assert body["photo_files_deleted"] == 1
    assert body["custom_field_values_deleted"] == 1

    # File on disk gone.
    assert not photo_path.exists()

    with admin_engine.begin() as conn:
        emp_row = conn.execute(
            select(
                employees.c.full_name,
                employees.c.email,
                employees.c.status,
            ).where(employees.c.id == emp_id)
        ).first()
        assert emp_row is not None
        assert emp_row.full_name == pdpl_module.REDACTED_NAME
        assert emp_row.email == f"deleted-{emp_id}@hadir.local"
        assert emp_row.status == "deleted"

        # Photos + cfv rows gone.
        photos_remaining = int(
            conn.execute(
                select(employee_photos.c.id).where(
                    employee_photos.c.employee_id == emp_id
                )
            ).rowcount or 0
        )
        cfv_remaining = int(
            conn.execute(
                select(custom_field_values.c.id).where(
                    custom_field_values.c.employee_id == emp_id
                )
            ).rowcount or 0
        )

    assert photos_remaining == 0
    assert cfv_remaining == 0

    # Audit row written.
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.entity_id).where(
                audit_log.c.action == "pdpl_delete",
                audit_log.c.entity_id == str(emp_id),
            )
        ).all()
    assert rows, "pdpl_delete audit row missing"


def test_pdpl_delete_endpoint_rejects_wrong_confirmation(
    admin_user, client, created_employee
):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200

    emp_id = created_employee["employee_id"]
    resp = client.post(
        f"/api/employees/{emp_id}/gdpr-delete",
        json={"confirmation": "i confirm pdpl deletion"},  # wrong case
    )
    assert resp.status_code == 400, resp.text
    assert "confirmation" in resp.json()["detail"].lower()


def test_pdpl_delete_endpoint_404_on_missing(admin_user, client):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200
    resp = client.post(
        "/api/employees/9999999/gdpr-delete",
        json={"confirmation": pdpl_module.PDPL_CONFIRMATION_PHRASE},
    )
    assert resp.status_code == 404


def test_pdpl_delete_endpoint_409_when_already_deleted(
    admin_engine, admin_user, client, created_employee
):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    client.post("/api/auth/login", json=creds)

    emp_id = created_employee["employee_id"]
    # First call succeeds; second 409s.
    r = client.post(
        f"/api/employees/{emp_id}/gdpr-delete",
        json={"confirmation": pdpl_module.PDPL_CONFIRMATION_PHRASE},
    )
    assert r.status_code == 200
    r = client.post(
        f"/api/employees/{emp_id}/gdpr-delete",
        json={"confirmation": pdpl_module.PDPL_CONFIRMATION_PHRASE},
    )
    assert r.status_code == 409


def test_pdpl_delete_employee_role_403(employee_user, client, created_employee):
    creds = {"email": employee_user["email"], "password": employee_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200
    resp = client.post(
        f"/api/employees/{created_employee['employee_id']}/gdpr-delete",
        json={"confirmation": pdpl_module.PDPL_CONFIRMATION_PHRASE},
    )
    assert resp.status_code == 403
