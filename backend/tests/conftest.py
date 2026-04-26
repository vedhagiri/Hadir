"""Shared pytest fixtures for the Hadir backend.

Tests assume the compose Postgres is running and at head revision. The
test user lifecycle is done through the admin engine (``hadir_admin``) so
we can clean up ``audit_log`` rows we produced — the app role cannot.
"""

from __future__ import annotations

import os as _os
import secrets
from typing import Iterator

# P25: keep the file-rotating log handlers off in pytest — the
# rotation thread would otherwise outlive a test and the temp
# log dir vanishes from under it. ``configure_logging``
# respects this env var.
_os.environ.setdefault("HADIR_LOG_DISABLE_FILES", "1")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.attendance import attendance_scheduler as _attendance_scheduler
from hadir.auth.passwords import hash_password
from hadir.auth.ratelimit import reset_rate_limiter
from hadir.capture import capture_manager as _capture_manager
from hadir.capture.analyzer import (
    clear_analyzer_factory as _clear_analyzer_factory,
    set_analyzer_factory as _set_analyzer_factory,
)
from hadir.db import (
    audit_log,
    cameras,
    departments,
    employee_photos,
    employees,
    make_admin_engine,
    roles,
    user_roles,
    user_sessions,
    users,
)
from hadir.main import app

TENANT_ID = 1


@pytest.fixture(scope="session")
def admin_engine() -> Engine:
    """Engine running as ``hadir_admin`` — used for test fixtures only."""

    return make_admin_engine()


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> Iterator[None]:
    """Each test starts with a clean rate-limit counter."""

    reset_rate_limiter()
    yield
    reset_rate_limiter()


class _NoopAnalyzer:
    """Session-wide stub so tests never load InsightFace.

    ``detect`` returns no faces and ``embed_crop`` returns None. The
    P6 photo upload path and the P9 lifespan backfill both call
    ``get_analyzer()`` — this keeps the suite under a few seconds
    instead of pulling a 250 MB model and running recognition on
    every test photo.
    """

    def detect(self, _frame) -> list:  # type: ignore[no-untyped-def]
        return []

    def embed_crop(self, _crop):  # type: ignore[no-untyped-def]
        return None


@pytest.fixture(autouse=True, scope="session")
def _neutralise_analyzer() -> Iterator[None]:
    """Replace the production analyzer factory with a no-op for the session."""

    _set_analyzer_factory(lambda: _NoopAnalyzer())
    try:
        yield
    finally:
        _clear_analyzer_factory()


@pytest.fixture(autouse=True, scope="session")
def _neutralise_attendance_scheduler() -> Iterator[None]:
    """TestClient(app) enters lifespan per test, which would otherwise
    start the 15-minute recompute job. Stub start/stop so the session's
    many lifespan entries don't spawn real APScheduler threads."""

    original_start = _attendance_scheduler.start
    original_stop = _attendance_scheduler.stop
    _attendance_scheduler.start = lambda: None  # type: ignore[assignment]
    _attendance_scheduler.stop = lambda: None  # type: ignore[assignment]
    try:
        yield
    finally:
        _attendance_scheduler.start = original_start  # type: ignore[assignment]
        _attendance_scheduler.stop = original_stop  # type: ignore[assignment]


@pytest.fixture(autouse=True, scope="session")
def _neutralise_report_runner() -> Iterator[None]:
    """Same idea as the attendance neutraliser — keep TestClient(app)
    lifespan entries from spawning the 60-second report runner job.
    The dedicated P18 tests call ``run_schedule_now`` directly, so
    they don't depend on the background loop."""

    from hadir.scheduled_reports import report_runner as _runner  # noqa: PLC0415

    original_start = _runner.start
    original_stop = _runner.stop
    _runner.start = lambda: None  # type: ignore[assignment]
    _runner.stop = lambda: None  # type: ignore[assignment]
    try:
        yield
    finally:
        _runner.start = original_start  # type: ignore[assignment]
        _runner.stop = original_stop  # type: ignore[assignment]


@pytest.fixture(autouse=True, scope="session")
def _neutralise_notification_worker() -> Iterator[None]:
    """Block the 30-second email-drain APScheduler job from spinning
    up during pytest's many TestClient lifespan entries. The P20
    tests call ``drain_one_tenant`` directly when they need to
    exercise the worker."""

    from hadir.notifications import notification_worker as _worker  # noqa: PLC0415

    original_start = _worker.start
    original_stop = _worker.stop
    _worker.start = lambda: None  # type: ignore[assignment]
    _worker.stop = lambda: None  # type: ignore[assignment]
    try:
        yield
    finally:
        _worker.start = original_start  # type: ignore[assignment]
        _worker.stop = original_stop  # type: ignore[assignment]


@pytest.fixture(autouse=True, scope="session")
def _neutralise_retention_scheduler() -> Iterator[None]:
    """Block the daily 03:00 retention sweep from spinning up
    during TestClient lifespan entries. The dedicated P25 tests
    call ``run_retention_sweep`` directly so they don't depend
    on the cron schedule."""

    from hadir.retention import retention_scheduler as _ret  # noqa: PLC0415

    original_start = _ret.start
    original_stop = _ret.stop
    _ret.start = lambda: None  # type: ignore[assignment]
    _ret.stop = lambda: None  # type: ignore[assignment]
    try:
        yield
    finally:
        _ret.start = original_start  # type: ignore[assignment]
        _ret.stop = original_stop  # type: ignore[assignment]


@pytest.fixture(autouse=True, scope="session")
def _neutralise_capture_manager() -> Iterator[None]:
    """Prevent the singleton capture manager from spawning real workers.

    TestClient(app) enters the FastAPI lifespan for every test, which
    would otherwise call ``capture_manager.start()`` — that iterates the
    cameras table and spins up OpenCV VideoCapture threads. We don't
    want test runs touching real RTSP endpoints or the InsightFace
    model, so we stub both start and stop while the session is active.
    The dedicated tests in test_capture.py instantiate their own
    ``CaptureManager`` objects and are unaffected.
    """

    original_start = _capture_manager.start
    original_stop = _capture_manager.stop
    _capture_manager.start = lambda **_kw: None  # type: ignore[assignment]
    _capture_manager.stop = lambda: None  # type: ignore[assignment]
    try:
        yield
    finally:
        _capture_manager.start = original_start  # type: ignore[assignment]
        _capture_manager.stop = original_stop  # type: ignore[assignment]


def _create_user(
    engine: Engine, *, email: str, password: str, role_code: str, full_name: str
) -> int:
    """Insert a user and attach the given role. Returns the user id."""

    password_hash = hash_password(password)
    with engine.begin() as conn:
        user_id = conn.execute(
            insert(users)
            .values(
                tenant_id=TENANT_ID,
                email=email,
                password_hash=password_hash,
                full_name=full_name,
                is_active=True,
            )
            .returning(users.c.id)
        ).scalar_one()
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == role_code
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )
    return int(user_id)


def _cleanup_user(engine: Engine, user_id: int) -> None:
    """Drop a test user's sessions, audit rows, role links, and the row."""

    with engine.begin() as conn:
        conn.execute(delete(user_sessions).where(user_sessions.c.user_id == user_id))
        # Audit rows referencing this user (actor_user_id is SET NULL on
        # user delete, but we prefer to remove the rows we created rather
        # than leave orphans in the log during tests).
        conn.execute(delete(audit_log).where(audit_log.c.actor_user_id == user_id))
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        conn.execute(delete(users).where(users.c.id == user_id))


@pytest.fixture
def admin_user(admin_engine: Engine) -> Iterator[dict]:
    """Create an Admin user, yield its credentials, then clean up."""

    email = f"admin-{secrets.token_hex(4)}@test.hadir"
    password = "test-admin-pw-" + secrets.token_hex(6)
    user_id = _create_user(
        admin_engine,
        email=email,
        password=password,
        role_code="Admin",
        full_name="Test Admin",
    )
    try:
        yield {"id": user_id, "email": email, "password": password}
    finally:
        _cleanup_user(admin_engine, user_id)


@pytest.fixture
def employee_user(admin_engine: Engine) -> Iterator[dict]:
    """Create an Employee user, yield its credentials, then clean up."""

    email = f"emp-{secrets.token_hex(4)}@test.hadir"
    password = "test-emp-pw-" + secrets.token_hex(6)
    user_id = _create_user(
        admin_engine,
        email=email,
        password=password,
        role_code="Employee",
        full_name="Test Employee",
    )
    try:
        yield {"id": user_id, "email": email, "password": password}
    finally:
        _cleanup_user(admin_engine, user_id)


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Fresh TestClient per test. Preserves cookies across requests."""

    with TestClient(app) as tc:
        yield tc


@pytest.fixture
def clean_cameras(admin_engine: Engine) -> Iterator[None]:
    """Wipe the cameras table before and after each test."""

    with admin_engine.begin() as conn:
        conn.execute(delete(cameras))
    yield
    with admin_engine.begin() as conn:
        conn.execute(delete(cameras))


@pytest.fixture
def clean_employees(admin_engine: Engine) -> Iterator[None]:
    """Wipe the employees + photos tables before and after each test.

    Employees tests manipulate these tables directly or through the API,
    and we don't want one test's leftover rows colouring another's
    search / count assertions.
    """

    with admin_engine.begin() as conn:
        conn.execute(delete(employee_photos))
        conn.execute(delete(employees))
    yield
    with admin_engine.begin() as conn:
        conn.execute(delete(employee_photos))
        conn.execute(delete(employees))


def department_id_by_code(engine: Engine, code: str) -> int:
    """Helper for tests: resolve a seeded department id by its code."""

    with engine.begin() as conn:
        row = conn.execute(
            select(departments.c.id).where(
                departments.c.tenant_id == TENANT_ID, departments.c.code == code
            )
        ).first()
    assert row is not None, f"seed department {code!r} missing"
    return int(row[0])


def audit_rows_for_user(engine: Engine, user_id: int) -> list[dict]:
    """Return audit rows where this user was the actor, newest first."""

    with engine.begin() as conn:
        rows = conn.execute(
            select(
                audit_log.c.action,
                audit_log.c.entity_type,
                audit_log.c.entity_id,
                audit_log.c.after,
            )
            .where(audit_log.c.actor_user_id == user_id)
            .order_by(audit_log.c.id.desc())
        ).all()
    return [dict(r._mapping) for r in rows]


def audit_rows_for_email(engine: Engine, email: str) -> list[dict]:
    """Return login-failure rows that recorded the attempted email."""

    # JSONB `@>` containment — case-insensitive would need extra work; we
    # normalise to lower at the router so an exact match is safe.
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                audit_log.c.action,
                audit_log.c.entity_type,
                audit_log.c.entity_id,
                audit_log.c.after,
            )
            .where(audit_log.c.after.op("@>")({"email_attempted": email}))
            .order_by(audit_log.c.id.desc())
        ).all()
    return [dict(r._mapping) for r in rows]
