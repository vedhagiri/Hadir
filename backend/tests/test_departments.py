"""Departments CRUD tests.

The Add Employee drawer's department picker pulls from the live
list, so the GET endpoint has to be accessible to every role. Mutation
is gated to Admin/HR with audit. Hard-delete refuses when employees
still reference the row.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine

from maugood.db import audit_log, departments, employees


@pytest.fixture
def clean_test_departments(admin_engine: Engine):
    """Drop any leftover dept-test rows.

    Wipes employees referencing test departments first to avoid FK
    violations (the API's DELETE /api/employees is a soft-delete that
    leaves the row in place with status='inactive').
    """

    def _wipe() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(employees).where(
                    employees.c.employee_code.like("DEPT_TEST_%")
                )
            )
            conn.execute(
                delete(departments).where(
                    departments.c.code.like("DEPT_TEST_%")
                )
            )

    _wipe()
    yield
    _wipe()


def _login_admin(client: TestClient, admin_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _login_employee(client: TestClient, employee_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={
            "email": employee_user["email"],
            "password": employee_user["password"],
        },
    )
    assert resp.status_code == 200, resp.text


def test_list_departments_open_to_employee_role(
    client: TestClient, employee_user: dict
) -> None:
    _login_employee(client, employee_user)
    resp = client.get("/api/departments")
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    codes = {d["code"] for d in items}
    # Pilot seeds these three; the test tenant gets them on migration.
    assert {"ENG", "OPS", "ADM"} <= codes
    # Each row carries an integer employee_count.
    for d in items:
        assert isinstance(d["employee_count"], int)


def test_create_department_round_trips_and_audits(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_departments: None,
) -> None:
    _login_admin(client, admin_user)
    resp = client.post(
        "/api/departments",
        json={"code": "DEPT_TEST_NEW", "name": "Brand New Department"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["code"] == "DEPT_TEST_NEW"
    assert body["name"] == "Brand New Department"
    assert body["employee_count"] == 0
    new_id = int(body["id"])

    # Lookup confirms the row landed.
    resp2 = client.get("/api/departments")
    codes = {d["code"] for d in resp2.json()["items"]}
    assert "DEPT_TEST_NEW" in codes

    # Audit row.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.action, audit_log.c.after)
            .where(
                audit_log.c.action == "department.created",
                audit_log.c.entity_id == str(new_id),
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.after["code"] == "DEPT_TEST_NEW"


def test_create_department_lowercases_uppercases_code(
    client: TestClient, admin_user: dict, clean_test_departments: None
) -> None:
    """Codes are normalised to uppercase regardless of operator input."""

    _login_admin(client, admin_user)
    resp = client.post(
        "/api/departments",
        json={"code": "dept_test_lc", "name": "Lowercase Input"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["code"] == "DEPT_TEST_LC"


def test_create_department_409_on_duplicate_code(
    client: TestClient, admin_user: dict, clean_test_departments: None
) -> None:
    _login_admin(client, admin_user)
    body = {"code": "DEPT_TEST_DUP", "name": "First"}
    r1 = client.post("/api/departments", json=body)
    assert r1.status_code == 201
    r2 = client.post("/api/departments", json=body)
    assert r2.status_code == 409, r2.text
    assert r2.json()["detail"]["field"] == "code"


def test_create_department_rejects_bad_code(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    # Lowercase letters allowed (auto-uppercased), but special chars
    # like spaces / dashes are not.
    resp = client.post(
        "/api/departments",
        json={"code": "BAD CODE", "name": "Spaced"},
    )
    assert resp.status_code == 422


def test_patch_department_renames_and_audits(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_departments: None,
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/departments",
        json={"code": "DEPT_TEST_RENAME", "name": "Old Name"},
    )
    new_id = r1.json()["id"]
    r2 = client.patch(
        f"/api/departments/{new_id}", json={"name": "New Name"}
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["name"] == "New Name"

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(
                audit_log.c.action == "department.updated",
                audit_log.c.entity_id == str(new_id),
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before["name"] == "Old Name"
    assert row.after["name"] == "New Name"


def test_delete_department_204_when_empty(
    client: TestClient, admin_user: dict, clean_test_departments: None
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/departments",
        json={"code": "DEPT_TEST_DEL", "name": "To Delete"},
    )
    new_id = r1.json()["id"]
    r2 = client.delete(f"/api/departments/{new_id}")
    assert r2.status_code == 204, r2.text


def test_delete_department_409_when_in_use(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_departments: None,
) -> None:
    """Hard-delete refuses when at least one employee row references
    the department (still active or inactive — only ``deleted`` rows
    don't count). Operator must move those employees first."""

    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/departments",
        json={"code": "DEPT_TEST_INUSE", "name": "Has Employees"},
    )
    dept_id = r1.json()["id"]

    # Seed an employee that references the new department.
    r2 = client.post(
        "/api/employees",
        json={
            "employee_code": "DEPT_TEST_EMP",
            "full_name": "Test Employee",
            "department_id": dept_id,
        },
    )
    assert r2.status_code == 201, r2.text

    r3 = client.delete(f"/api/departments/{dept_id}")
    assert r3.status_code == 409, r3.text
    assert r3.json()["detail"]["field"] == "department_id"

    # Cleanup: remove the test employee so the fixture's wipe can
    # also drop the department row.
    emp_id = r2.json()["id"]
    client.delete(f"/api/employees/{emp_id}")


def test_create_department_403_for_employee(
    client: TestClient, employee_user: dict
) -> None:
    _login_employee(client, employee_user)
    resp = client.post(
        "/api/departments",
        json={"code": "DEPT_TEST_403", "name": "Forbidden"},
    )
    assert resp.status_code == 403


def test_import_departments_csv_upserts_rows(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_departments: None,
) -> None:
    """CSV with header ``code,name`` upserts by code. New codes ⇒
    created; existing codes ⇒ updated when name differs. Per-row
    failures (bad code shape) are reported in the response without
    rolling back the rest. Audits a single ``department.imported``
    row summarising the totals."""

    _login_admin(client, admin_user)
    csv_body = (
        "code,name\n"
        "DEPT_TEST_NEW1,New One\n"
        "DEPT_TEST_NEW2,New Two\n"
        "BAD CODE,Bad Shape\n"
    )
    resp = client.post(
        "/api/departments/import",
        files={"file": ("depts.csv", csv_body.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] == 2
    assert body["updated"] == 0
    assert body["errors"] == 1
    statuses = {r["status"] for r in body["rows"]}
    assert statuses == {"created", "error"}

    # Re-import the SAME file with one row's name changed → 1 update,
    # 1 unchanged-still-counted-as-updated, 1 error (the bad row).
    csv_body2 = (
        "code,name\n"
        "DEPT_TEST_NEW1,New One Renamed\n"
        "DEPT_TEST_NEW2,New Two\n"
    )
    resp2 = client.post(
        "/api/departments/import",
        files={"file": ("depts.csv", csv_body2.encode("utf-8"), "text/csv")},
    )
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["updated"] == 2  # both treated as upsert hits
    assert resp2.json()["created"] == 0


def test_import_departments_rejects_bad_csv(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    # No header row.
    resp = client.post(
        "/api/departments/import",
        files={"file": ("bad.csv", b"foo,bar\nrow1,row2\n", "text/csv")},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["field"] == "file"
