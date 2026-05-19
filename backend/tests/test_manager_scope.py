"""Regression tests for Manager team-scoped access.

Covers two endpoints widened to Manager in the May 2026 fix:

* ``GET /api/employees/{id}/team-members`` — switched from the
  legacy P8 ``get_manager_visible_employee_ids`` visibility set
  to the team-rule resolver ``manager_team_employee_ids`` so a
  Manager whose visible-set was empty (no
  ``manager_assignments`` row and no ``user_departments`` row)
  can still see team-mates resolved by the email-to-employee
  bridge.
* ``GET /api/person-clips`` + ``/{id}/face-crops`` (list + image)
  + ``/{id}/thumbnail`` + ``/{id}/stream`` +
  ``/{id}/processing-results`` — gates broadened from
  ``Admin|HR`` to ``Admin|HR|Manager``. Manager calls go
  through ``_assert_clip_visible_to_manager`` which requires
  at least one matched employee on the clip (via
  ``person_clips.employee_id`` or ``face_crops.employee_id``)
  to be in the Manager's team. Out-of-team → 404 (never 403,
  never leaks existence).

The tests also verify that Admin / HR / Employee role gates are
**unchanged** by the widening.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, insert, select
from sqlalchemy.engine import Engine

from maugood.db import (
    cameras,
    employees,
    face_crops,
    manager_assignments,
    person_clips,
    roles,
    user_departments,
    user_roles,
    users,
)


TENANT_ID = 1


# ---------------------------------------------------------------------------
# Helpers — mirror the patterns in tests/test_attendance_calendar.py
# ---------------------------------------------------------------------------


def _set_user_to_manager(
    admin_engine: Engine, *, user_id: int, department_id: int
) -> None:
    """Replace user's roles with [Manager], assign to department, and
    seed an ``employees`` row matched by email — so the team-rule
    resolver can find them via the email bridge."""

    with admin_engine.begin() as conn:
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        manager_role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id,
                role_id=manager_role_id,
                tenant_id=TENANT_ID,
            )
        )
        conn.execute(
            delete(user_departments).where(user_departments.c.user_id == user_id)
        )
        conn.execute(
            insert(user_departments).values(
                user_id=user_id, department_id=department_id, tenant_id=TENANT_ID
            )
        )

        user_row = conn.execute(
            select(users.c.email).where(users.c.id == user_id)
        ).first()
        if user_row is None or not user_row.email:
            return
        # Drop any prior fixture row for this email, then seed a fresh
        # manager employee row that the team-rule resolver will pick
        # up via lower-cased email.
        conn.execute(
            delete(employees).where(
                employees.c.tenant_id == TENANT_ID,
                func.lower(employees.c.email) == user_row.email.lower(),
            )
        )
        conn.execute(
            insert(employees).values(
                tenant_id=TENANT_ID,
                employee_code=f"MGR-{user_id}",
                full_name="Manager Test",
                email=user_row.email,
                department_id=department_id,
                status="active",
            )
        )


def _restore_admin(admin_engine: Engine, *, user_id: int) -> None:
    with admin_engine.begin() as conn:
        user_row = conn.execute(
            select(users.c.email).where(users.c.id == user_id)
        ).first()
        if user_row is not None and user_row.email:
            conn.execute(
                delete(employees).where(
                    employees.c.tenant_id == TENANT_ID,
                    func.lower(employees.c.email) == user_row.email.lower(),
                )
            )
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        conn.execute(
            delete(user_departments).where(user_departments.c.user_id == user_id)
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == user_id
            )
        )


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture
def seeded(admin_engine: Engine) -> Iterator[dict]:
    """Seed three employees + a camera + two person_clips for the
    Matched Clips tests:

    * ``eng1`` in dept 1 — in the Manager's team.
    * ``eng2`` in dept 1 — in the Manager's team.
    * ``ops1`` in dept 2 — out of the Manager's team.
    * ``clip_in_team`` — clip with ``employee_id = eng1`` and a
      ``face_crops`` row pointing at eng2. Manager sees this.
    * ``clip_out_of_team`` — clip with ``employee_id = ops1``.
      Manager 404s on this.
    """

    with admin_engine.begin() as conn:
        # Clean slate for the bits this test touches.
        conn.execute(delete(face_crops).where(face_crops.c.tenant_id == TENANT_ID))
        conn.execute(delete(person_clips).where(person_clips.c.tenant_id == TENANT_ID))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == TENANT_ID))
        conn.execute(delete(employees).where(employees.c.tenant_id == TENANT_ID))

        eng1 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="MGR-SCOPE-ENG-1",
                full_name="Eng One",
                email="eng-one@mgr-scope.test",
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        eng2 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="MGR-SCOPE-ENG-2",
                full_name="Eng Two",
                email="eng-two@mgr-scope.test",
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        ops1 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="MGR-SCOPE-OPS-1",
                full_name="Ops One",
                email="ops-one@mgr-scope.test",
                department_id=2,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()

        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=TENANT_ID,
                name="MgrScope-Cam",
                location="Lobby",
                rtsp_url_encrypted="not-a-real-cipher",
                worker_enabled=False,
                display_enabled=False,
            )
            .returning(cameras.c.id)
        ).scalar_one()

        now = datetime.now(timezone.utc)
        clip_in_team = conn.execute(
            insert(person_clips)
            .values(
                tenant_id=TENANT_ID,
                camera_id=cam_id,
                employee_id=eng1,
                clip_start=now,
                clip_end=now + timedelta(seconds=10),
                duration_seconds=10.0,
                recording_status="completed",
                detection_source="face",
                face_crops_status="processed",
            )
            .returning(person_clips.c.id)
        ).scalar_one()
        clip_out_of_team = conn.execute(
            insert(person_clips)
            .values(
                tenant_id=TENANT_ID,
                camera_id=cam_id,
                employee_id=ops1,
                clip_start=now,
                clip_end=now + timedelta(seconds=10),
                duration_seconds=10.0,
                recording_status="completed",
                detection_source="face",
                face_crops_status="processed",
            )
            .returning(person_clips.c.id)
        ).scalar_one()
        clip_orphan = conn.execute(
            # No employee_id, no face_crops → not visible to any Manager.
            insert(person_clips)
            .values(
                tenant_id=TENANT_ID,
                camera_id=cam_id,
                employee_id=None,
                clip_start=now,
                clip_end=now + timedelta(seconds=10),
                duration_seconds=10.0,
                recording_status="completed",
                detection_source="face",
                face_crops_status="processed",
            )
            .returning(person_clips.c.id)
        ).scalar_one()

        # face_crops on the in-team clip — one row pointing at eng2 so
        # the matched-employees set on the clip is {eng1, eng2}.
        crop_id = conn.execute(
            insert(face_crops)
            .values(
                tenant_id=TENANT_ID,
                camera_id=cam_id,
                person_clip_id=clip_in_team,
                event_timestamp="2026-05-01T00:00:00Z",
                face_index=1,
                use_case="uc1",
                employee_id=eng2,
                quality_score=0.9,
                sharpness=0.5,
                detection_score=0.95,
                width=100,
                height=100,
                match_confidence=0.85,
            )
            .returning(face_crops.c.id)
        ).scalar_one()

    info = {
        "eng1": int(eng1),
        "eng2": int(eng2),
        "ops1": int(ops1),
        "cam_id": int(cam_id),
        "clip_in_team": int(clip_in_team),
        "clip_out_of_team": int(clip_out_of_team),
        "clip_orphan": int(clip_orphan),
        "crop_id": int(crop_id),
    }
    try:
        yield info
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(face_crops).where(face_crops.c.tenant_id == TENANT_ID))
            conn.execute(delete(person_clips).where(person_clips.c.tenant_id == TENANT_ID))
            conn.execute(delete(cameras).where(cameras.c.tenant_id == TENANT_ID))
            conn.execute(delete(employees).where(employees.c.tenant_id == TENANT_ID))


# ---------------------------------------------------------------------------
# Team-members endpoint
# ---------------------------------------------------------------------------


def test_team_members_manager_in_team_returns_200(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager assigned to dept 1 + seeded employees row → can fetch
    the team-members list for eng1 (a same-dept employee). Before the
    fix this returned 404 when the Manager had no
    ``manager_assignments`` row + no ``user_departments`` row pre-
    seeded (the legacy visible-set was empty)."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get(f"/api/employees/{seeded['eng1']}/team-members")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "scope_name" in body
        assert "items" in body
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_team_members_manager_out_of_team_returns_404(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager → 404 on ops1 (a dept-2 employee). Always 404, never
    403 (403 would leak existence)."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get(f"/api/employees/{seeded['ops1']}/team-members")
        assert resp.status_code == 404, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_team_members_admin_unchanged_sees_every_employee(
    client: TestClient, admin_user: dict, seeded: dict
) -> None:
    """Admin role keeps tenant-wide visibility on team-members
    (no scoping). Both eng1 and ops1 must return 200."""

    _login(client, admin_user)
    for emp_id in (seeded["eng1"], seeded["ops1"]):
        resp = client.get(f"/api/employees/{emp_id}/team-members")
        assert resp.status_code == 200, (emp_id, resp.text)


def test_team_members_hr_unchanged_sees_every_employee(
    client: TestClient, hr_user: dict, seeded: dict
) -> None:
    """HR role keeps tenant-wide visibility on team-members."""

    _login(client, hr_user)
    for emp_id in (seeded["eng1"], seeded["ops1"]):
        resp = client.get(f"/api/employees/{emp_id}/team-members")
        assert resp.status_code == 200, (emp_id, resp.text)


def test_team_members_employee_role_still_blocked(
    client: TestClient, employee_user: dict, seeded: dict
) -> None:
    """Employee role hits the 403 from ``require_any_role`` before
    any scope check runs. The widening must not have opened the
    endpoint to Employee."""

    _login(client, employee_user)
    resp = client.get(f"/api/employees/{seeded['eng1']}/team-members")
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Person-clips list endpoint
# ---------------------------------------------------------------------------


def test_person_clips_list_manager_in_team_returns_200(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager + ``matched_employee_id`` in team → 200 + non-empty
    list. Before the fix the Manager hit 403."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get(
            f"/api/person-clips?matched_employee_id={seeded['eng1']}"
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The in-team clip references eng1 directly; total must be ≥1.
        assert body.get("total", 0) >= 1, body
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_list_manager_out_of_team_returns_404(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager + ``matched_employee_id`` NOT in team → 404.
    Never 403 (would leak existence)."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get(
            f"/api/person-clips?matched_employee_id={seeded['ops1']}"
        )
        assert resp.status_code == 404, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_list_manager_no_matched_employee_id_returns_404(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager must always pin to an employee — naked tenant-wide
    list is forbidden. 404 (not 403) to avoid leaking that other
    employees' clips exist."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get("/api/person-clips")
        assert resp.status_code == 404, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_list_admin_unchanged_no_filter_required(
    client: TestClient, admin_user: dict, seeded: dict
) -> None:
    """Admin role retains the existing behaviour — naked list call
    (no ``matched_employee_id``) succeeds and returns every clip in
    the tenant. The Manager check must not interfere."""

    _login(client, admin_user)
    resp = client.get("/api/person-clips")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # All three seeded clips are visible to Admin.
    assert body.get("total", 0) >= 3, body


def test_person_clips_list_employee_role_still_blocked(
    client: TestClient, employee_user: dict, seeded: dict
) -> None:
    """Employee role is still rejected at the role gate (403).
    The Manager widening did not open this endpoint to Employee."""

    _login(client, employee_user)
    resp = client.get(f"/api/person-clips?matched_employee_id={seeded['eng1']}")
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Per-clip read endpoints
# ---------------------------------------------------------------------------


def test_person_clips_per_clip_manager_team_mate_matched(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager → 200 on every per-clip read endpoint for the in-team
    clip. The clip's matched_employees set is {eng1, eng2} which
    intersects the Manager's team {eng1, eng2}, so all reads pass.
    Stream/thumbnail/face-crop-image return 410 ``file missing`` when
    the on-disk file isn't there — that's still a successful
    permission check (we want anything OTHER than 403 / 404)."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        clip_id = seeded["clip_in_team"]

        # processing-results: simple JSON, no file I/O.
        resp = client.get(f"/api/person-clips/{clip_id}/processing-results")
        assert resp.status_code == 200, resp.text

        # face-crops list: simple JSON.
        resp = client.get(f"/api/person-clips/{clip_id}/face-crops")
        assert resp.status_code == 200, resp.text

        # Per-image, thumbnail, stream — the file on disk doesn't
        # exist in the test fixture (file_path is NULL), so these
        # return 410 "file missing". 410 is a successful authz pass.
        crop_id = seeded["crop_id"]
        for path in (
            f"/api/person-clips/{clip_id}/face-crops/{crop_id}/image",
            f"/api/person-clips/{clip_id}/thumbnail",
            f"/api/person-clips/{clip_id}/stream",
        ):
            resp = client.get(path)
            assert resp.status_code in (200, 410), (path, resp.status_code, resp.text)
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_per_clip_manager_no_team_mate(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager → 404 on every per-clip read endpoint for the
    out-of-team clip (employee_id = ops1, no face_crops). The team
    intersection is empty → 404."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        clip_id = seeded["clip_out_of_team"]

        for path in (
            f"/api/person-clips/{clip_id}/processing-results",
            f"/api/person-clips/{clip_id}/face-crops",
            f"/api/person-clips/{clip_id}/thumbnail",
            f"/api/person-clips/{clip_id}/stream",
        ):
            resp = client.get(path)
            assert resp.status_code == 404, (path, resp.status_code, resp.text)
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_per_clip_manager_orphan_clip(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Manager → 404 on an orphan clip (employee_id NULL + no
    face_crops). No matched employees → no intersection → 404."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        clip_id = seeded["clip_orphan"]
        resp = client.get(f"/api/person-clips/{clip_id}/processing-results")
        assert resp.status_code == 404, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_per_clip_admin_unchanged_can_view_any(
    client: TestClient, admin_user: dict, seeded: dict
) -> None:
    """Admin keeps tenant-wide visibility on per-clip reads. Both
    the in-team and out-of-team clips return 200 (or 410 for the
    file-missing fixture paths)."""

    _login(client, admin_user)
    for clip_id in (seeded["clip_in_team"], seeded["clip_out_of_team"]):
        resp = client.get(f"/api/person-clips/{clip_id}/processing-results")
        assert resp.status_code == 200, (clip_id, resp.text)


def test_person_clips_per_clip_hr_unchanged_can_view_any(
    client: TestClient, hr_user: dict, seeded: dict
) -> None:
    """HR keeps tenant-wide visibility on per-clip reads."""

    _login(client, hr_user)
    for clip_id in (seeded["clip_in_team"], seeded["clip_out_of_team"]):
        resp = client.get(f"/api/person-clips/{clip_id}/processing-results")
        assert resp.status_code == 200, (clip_id, resp.text)


def test_person_clips_per_clip_employee_role_still_blocked(
    client: TestClient, employee_user: dict, seeded: dict
) -> None:
    """Employee role hits the 403 role gate before any scope check.
    The Manager widening must not have opened the endpoint to
    Employee."""

    _login(client, employee_user)
    resp = client.get(
        f"/api/person-clips/{seeded['clip_in_team']}/processing-results"
    )
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Admin-only mutation endpoints — Manager must still be blocked
# ---------------------------------------------------------------------------


def test_person_clips_manager_cannot_reprocess(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Reprocess remains Admin-only. Manager + reprocess → 403."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.post(
            f"/api/person-clips/{seeded['clip_in_team']}/reprocess",
            json={"use_cases": ["uc1"]},
        )
        assert resp.status_code == 403, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_manager_cannot_delete(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """DELETE remains Admin-only. Manager + DELETE → 403."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.delete(f"/api/person-clips/{seeded['clip_in_team']}")
        assert resp.status_code == 403, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_manager_cannot_bulk_delete(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded: dict,
) -> None:
    """Bulk-delete remains Admin-only. Manager → 403."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.post(
            "/api/person-clips/bulk-delete",
            json={"clip_ids": [seeded["clip_in_team"]]},
        )
        assert resp.status_code == 403, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_clips_manager_cannot_view_system_stats(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
) -> None:
    """Operator dashboards stay HR/Admin-only. Manager → 403."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        resp = client.get("/api/person-clips/system-stats")
        assert resp.status_code == 403, resp.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])
