"""P29 #3 — division → department → section hierarchy.

Tests the scope-helper expansion + the new division/section CRUD +
manager-assignment endpoints.

The scope-helper is the load-bearing change: every visibility-aware
surface (attendance, calendar, approvals, reports) reads through
``get_manager_visible_employee_ids``, so a regression here would
silently widen or narrow what a manager sees across the whole app.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.auth.passwords import hash_password
from maugood.db import (
    audit_log,
    departments,
    divisions,
    employees,
    roles,
    sections,
    user_departments,
    user_divisions,
    user_roles,
    user_sections,
    users,
)
from maugood.manager_assignments.repository import (
    get_manager_visible_employee_ids,
)
from maugood.tenants.scope import TenantScope
from tests.conftest import TENANT_ID, department_id_by_code


# ---------------------------------------------------------------------------
# Fixture: a Manager user owned by the test (cleaned up in finally)
# ---------------------------------------------------------------------------


@pytest.fixture
def manager_user(admin_engine: Engine) -> Iterator[dict]:
    email = f"mgr-org-{secrets.token_hex(4)}@test.maugood"
    pwh = hash_password("test-mgr-pw-" + secrets.token_hex(6))
    with admin_engine.begin() as conn:
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name="Org Manager",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )
    try:
        yield {"id": user_id, "email": email}
    finally:
        with admin_engine.begin() as conn:
            for tbl in (user_sections, user_divisions, user_departments):
                conn.execute(delete(tbl).where(tbl.c.user_id == user_id))
            conn.execute(
                delete(audit_log).where(audit_log.c.actor_user_id == user_id)
            )
            conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
            conn.execute(delete(users).where(users.c.id == user_id))


@pytest.fixture
def hierarchy(admin_engine: Engine) -> Iterator[dict]:
    """Set up a complete division → department → section tree.

    Layout:
      DIV-A
        ├─ DEP-X (existing ENG dept, repointed)
        │   ├─ SEC-X1
        │   └─ SEC-X2
        └─ DEP-Y (existing OPS dept, repointed)
              └─ (no sections)
      DIV-B
        └─ (no departments)

    Plus four employees:
      e_x1 — DEP-X, SEC-X1
      e_x2 — DEP-X, SEC-X2
      e_y  — DEP-Y, no section
      e_orphan — DEP-X (still under DIV-A) but no section
    """

    suffix = secrets.token_hex(2).upper()
    eng_id = department_id_by_code(admin_engine, "ENG")
    ops_id = department_id_by_code(admin_engine, "OPS")
    with admin_engine.begin() as conn:
        # Divisions
        div_a = int(
            conn.execute(
                insert(divisions)
                .values(tenant_id=TENANT_ID, code=f"DIVA{suffix}", name="Division A")
                .returning(divisions.c.id)
            ).scalar_one()
        )
        div_b = int(
            conn.execute(
                insert(divisions)
                .values(tenant_id=TENANT_ID, code=f"DIVB{suffix}", name="Division B")
                .returning(divisions.c.id)
            ).scalar_one()
        )

        # Repoint existing ENG + OPS departments under DIV_A.
        conn.execute(
            departments.update()
            .where(departments.c.id.in_([eng_id, ops_id]))
            .values(division_id=div_a)
        )

        # Sections under ENG.
        sec_x1 = int(
            conn.execute(
                insert(sections)
                .values(
                    tenant_id=TENANT_ID,
                    department_id=eng_id,
                    code=f"X1{suffix}",
                    name="Section X1",
                )
                .returning(sections.c.id)
            ).scalar_one()
        )
        sec_x2 = int(
            conn.execute(
                insert(sections)
                .values(
                    tenant_id=TENANT_ID,
                    department_id=eng_id,
                    code=f"X2{suffix}",
                    name="Section X2",
                )
                .returning(sections.c.id)
            ).scalar_one()
        )

        # Employees.
        def _ins_emp(code: str, dept_id: int, sec_id: int | None) -> int:
            return int(
                conn.execute(
                    insert(employees)
                    .values(
                        tenant_id=TENANT_ID,
                        employee_code=code,
                        full_name=code,
                        email=f"{code.lower()}@test.maugood",
                        department_id=dept_id,
                        section_id=sec_id,
                        status="active",
                    )
                    .returning(employees.c.id)
                ).scalar_one()
            )

        e_x1 = _ins_emp(f"EX1{suffix}", eng_id, sec_x1)
        e_x2 = _ins_emp(f"EX2{suffix}", eng_id, sec_x2)
        e_y = _ins_emp(f"EY{suffix}", ops_id, None)
        e_orphan = _ins_emp(f"EORF{suffix}", eng_id, None)
    try:
        yield {
            "div_a": div_a,
            "div_b": div_b,
            "dep_x": eng_id,
            "dep_y": ops_id,
            "sec_x1": sec_x1,
            "sec_x2": sec_x2,
            "e_x1": e_x1,
            "e_x2": e_x2,
            "e_y": e_y,
            "e_orphan": e_orphan,
        }
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(employees).where(
                    employees.c.id.in_([e_x1, e_x2, e_y, e_orphan])
                )
            )
            conn.execute(
                delete(sections).where(sections.c.id.in_([sec_x1, sec_x2]))
            )
            conn.execute(
                departments.update()
                .where(departments.c.id.in_([eng_id, ops_id]))
                .values(division_id=None)
            )
            conn.execute(
                delete(divisions).where(divisions.c.id.in_([div_a, div_b]))
            )


# ---------------------------------------------------------------------------
# Scope helper — division tier
# ---------------------------------------------------------------------------


def test_division_manager_sees_every_employee_under_the_division(
    admin_engine: Engine, manager_user: dict, hierarchy: dict
) -> None:
    """A user assigned via ``user_divisions`` sees every employee
    whose department.division_id matches — across all departments
    under that division."""

    with admin_engine.begin() as conn:
        conn.execute(
            insert(user_divisions).values(
                tenant_id=TENANT_ID,
                user_id=manager_user["id"],
                division_id=hierarchy["div_a"],
            )
        )
        scope = TenantScope(tenant_id=TENANT_ID)
        visible = get_manager_visible_employee_ids(
            conn, scope, manager_user_id=manager_user["id"]
        )

    # Every employee in DIV_A's two departments must be visible.
    assert hierarchy["e_x1"] in visible
    assert hierarchy["e_x2"] in visible
    assert hierarchy["e_y"] in visible
    assert hierarchy["e_orphan"] in visible


def test_section_manager_sees_only_their_section(
    admin_engine: Engine, manager_user: dict, hierarchy: dict
) -> None:
    """``user_sections`` narrows visibility to the assigned section
    only — not the whole department, and not other sections under
    the same department."""

    with admin_engine.begin() as conn:
        conn.execute(
            insert(user_sections).values(
                tenant_id=TENANT_ID,
                user_id=manager_user["id"],
                section_id=hierarchy["sec_x1"],
            )
        )
        scope = TenantScope(tenant_id=TENANT_ID)
        visible = get_manager_visible_employee_ids(
            conn, scope, manager_user_id=manager_user["id"]
        )

    assert visible == {hierarchy["e_x1"]}


def test_dept_division_section_visibility_unions(
    admin_engine: Engine, manager_user: dict, hierarchy: dict
) -> None:
    """A manager assigned at multiple tiers sees the UNION, not the
    intersection. dept-tier + section-tier in different parts of the
    tree → both appear in ``visible``."""

    with admin_engine.begin() as conn:
        # Department-tier on DEP_Y (covers e_y).
        conn.execute(
            insert(user_departments).values(
                tenant_id=TENANT_ID,
                user_id=manager_user["id"],
                department_id=hierarchy["dep_y"],
            )
        )
        # Section-tier on SEC_X2 (covers e_x2 only — not the rest of DEP_X).
        conn.execute(
            insert(user_sections).values(
                tenant_id=TENANT_ID,
                user_id=manager_user["id"],
                section_id=hierarchy["sec_x2"],
            )
        )
        scope = TenantScope(tenant_id=TENANT_ID)
        visible = get_manager_visible_employee_ids(
            conn, scope, manager_user_id=manager_user["id"]
        )

    assert hierarchy["e_y"] in visible  # via dept-tier
    assert hierarchy["e_x2"] in visible  # via section-tier
    assert hierarchy["e_x1"] not in visible  # neither tier
    assert hierarchy["e_orphan"] not in visible  # neither tier


# ---------------------------------------------------------------------------
# CRUD endpoints — happy path smoke (full coverage on dept tier already)
# ---------------------------------------------------------------------------


def _login(client: TestClient, user: dict) -> None:
    r = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert r.status_code == 200, r.text


def test_division_crud_round_trip(client: TestClient, admin_user: dict) -> None:
    _login(client, admin_user)

    code = f"DCRUD{secrets.token_hex(2).upper()}"
    r = client.post("/api/divisions", json={"code": code, "name": "CRUD Div"})
    assert r.status_code == 201, r.text
    div_id = r.json()["id"]

    r = client.get("/api/divisions")
    assert r.status_code == 200
    assert any(d["id"] == div_id for d in r.json()["items"])

    r = client.patch(f"/api/divisions/{div_id}", json={"name": "Renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"

    r = client.delete(f"/api/divisions/{div_id}")
    assert r.status_code == 204


def test_section_crud_requires_existing_department(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    eng_id = department_id_by_code(admin_engine, "ENG")

    code = f"SCRUD{secrets.token_hex(2).upper()}"
    r = client.post(
        "/api/sections",
        json={"code": code, "name": "CRUD Section", "department_id": eng_id},
    )
    assert r.status_code == 201, r.text
    sec_id = r.json()["id"]

    # Listing scoped to a department only returns its sections.
    r = client.get(f"/api/sections?department_id={eng_id}")
    assert r.status_code == 200
    assert any(s["id"] == sec_id for s in r.json()["items"])

    r = client.delete(f"/api/sections/{sec_id}")
    assert r.status_code == 204


def test_section_create_rejects_unknown_department(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    # Code must pass the regex BEFORE the dept-not-found branch fires.
    r = client.post(
        "/api/sections",
        json={"code": "VALID", "name": "Bogus", "department_id": 9999999},
    )
    assert r.status_code == 404


def test_division_manager_assignment_round_trip(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    manager_user: dict,
) -> None:
    _login(client, admin_user)

    code = f"DMA{secrets.token_hex(2).upper()}"
    r = client.post("/api/divisions", json={"code": code, "name": "DMA Div"})
    assert r.status_code == 201, r.text
    div_id = r.json()["id"]

    try:
        r = client.post(
            f"/api/divisions/{div_id}/managers",
            json={"user_id": manager_user["id"]},
        )
        assert r.status_code == 201, r.text

        r = client.get(f"/api/divisions/{div_id}/managers")
        assert r.status_code == 200
        items = r.json()["items"]
        assert any(m["user_id"] == manager_user["id"] for m in items)

        # Idempotent — POST a second time returns 201 (existing or fresh)
        # without a 409.
        r = client.post(
            f"/api/divisions/{div_id}/managers",
            json={"user_id": manager_user["id"]},
        )
        assert r.status_code == 201

        r = client.delete(
            f"/api/divisions/{div_id}/managers/{manager_user['id']}"
        )
        assert r.status_code == 204
    finally:
        client.delete(f"/api/divisions/{div_id}")


def test_division_manager_rejects_non_manager_user(
    client: TestClient, admin_user: dict
) -> None:
    """A user who doesn't hold the Manager role can't be assigned —
    server-side guard, defence in depth on top of the UI's filtered
    dropdown."""

    _login(client, admin_user)

    code = f"NMG{secrets.token_hex(2).upper()}"
    r = client.post("/api/divisions", json={"code": code, "name": "Test"})
    assert r.status_code == 201
    div_id = r.json()["id"]
    try:
        # Admin user (no Manager role) can't be assigned.
        r = client.post(
            f"/api/divisions/{div_id}/managers",
            json={"user_id": admin_user["id"]},
        )
        assert r.status_code == 422
        body = r.json()
        assert "Manager role" in body["detail"]["message"]
    finally:
        client.delete(f"/api/divisions/{div_id}")
