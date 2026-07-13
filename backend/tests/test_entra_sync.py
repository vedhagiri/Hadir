"""Entra AD user sync — service + endpoints.

Uses a stub directory client (``set_test_directory_client``) so no
Microsoft Graph call is made. Covers: provisioning new users with
access OFF + role from the group map, not clobbering a manually-set
role on re-sync, the group→role mapping CRUD, the AD user list/detail
+ login-activity shape, and the Admin-only gates.
"""

from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Engine

from maugood.auth.oidc import encrypt_secret
from maugood.db import (
    departments,
    employees,
    entra_group_role_map,
    roles,
    tenant_context,
    tenant_oidc_config,
    user_roles,
    users,
)
from maugood.entra_sync.graph import GraphGroup, GraphUser, set_test_directory_client
from maugood.entra_sync.service import roles_for_groups, sync_users

TENANT_ID = 1


class FakeDir:
    """Stub Graph directory client."""

    def __init__(self, user_list, groups_by_user=None, group_list=None):
        self._users = user_list
        self._gbu = groups_by_user or {}
        self._groups = group_list or []

    def list_users(self):
        return list(self._users)

    def list_user_group_ids(self, object_id):
        return tuple(self._gbu.get(object_id, ()))

    def list_groups(self):
        return list(self._groups)


def _gu(oid, name, email, groups=()):
    return GraphUser(
        object_id=oid,
        display_name=name,
        email=email,
        upn=email,
        job_title="Engineer",
        department="ENG",
        account_enabled=True,
        group_ids=tuple(groups),
    )


@pytest.fixture(autouse=True)
def _clean(admin_engine: Engine) -> Iterator[None]:
    def _reset() -> None:
        with admin_engine.begin() as conn:
            # Employees the sync may have created (linked by @ad.test
            # email) + the AD_SYNC fallback department. Employees first
            # (FK RESTRICT on department_id).
            conn.execute(
                delete(employees).where(
                    employees.c.tenant_id == TENANT_ID,
                    func.lower(employees.c.email).like("%@ad.test"),
                )
            )
            conn.execute(
                delete(departments).where(
                    departments.c.tenant_id == TENANT_ID,
                    departments.c.code == "AD_SYNC",
                )
            )
            conn.execute(
                delete(users).where(
                    users.c.tenant_id == TENANT_ID, users.c.source == "entra"
                )
            )
            conn.execute(
                delete(entra_group_role_map).where(
                    entra_group_role_map.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                update(tenant_oidc_config)
                .where(tenant_oidc_config.c.tenant_id == TENANT_ID)
                .values(
                    entra_tenant_id="",
                    client_id="",
                    client_secret_encrypted=None,
                    enabled=False,
                )
            )

    _reset()
    yield
    _reset()
    set_test_directory_client(None)


def _configure_entra(admin_engine: Engine) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_oidc_config)
            .where(tenant_oidc_config.c.tenant_id == TENANT_ID)
            .values(
                entra_tenant_id="test-entra",
                client_id="test-client",
                client_secret_encrypted=encrypt_secret("s"),
                enabled=True,
            )
        )


def _login_admin(client: TestClient, admin_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# service.sync_users (unit)
# ---------------------------------------------------------------------------


def test_roles_for_groups_maps_and_dedupes() -> None:
    mapping = {"g1": "Admin", "g2": "HR", "g3": "Admin"}
    assert roles_for_groups(("g1", "g3"), mapping) == ["Admin"]
    assert roles_for_groups(("g1", "g2"), mapping) == ["Admin", "HR"]
    assert roles_for_groups(("gX",), mapping) == []


def test_sync_creates_users_access_off_and_role_from_group(
    admin_engine: Engine,
) -> None:
    # Map group g-admin -> Admin.
    with admin_engine.begin() as conn:
        conn.execute(
            entra_group_role_map.insert().values(
                tenant_id=TENANT_ID,
                group_id="g-admin",
                group_name="Admins",
                role_code="Admin",
            )
        )
    graph_users = [
        _gu("obj-1", "Alice AD", "alice@ad.test", groups=("g-admin",)),
        _gu("obj-2", "Bob AD", "bob@ad.test", groups=()),
    ]
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(conn, tenant_id=TENANT_ID, graph_users=graph_users)
    assert result.added == 2
    assert result.updated == 0
    assert result.failed == 0

    with admin_engine.begin() as conn:
        alice = conn.execute(
            select(users.c.id, users.c.is_active, users.c.source, users.c.ms_object_id)
            .where(users.c.tenant_id == TENANT_ID, users.c.email == "alice@ad.test")
        ).first()
        assert alice is not None
        assert alice.is_active is False  # access OFF for new synced users
        assert alice.source == "entra"
        assert alice.ms_object_id == "obj-1"
        role_rows = conn.execute(
            select(user_roles.c.role_id).where(
                user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == alice.id
            )
        ).all()
        assert len(role_rows) == 1  # Admin from the group map


def test_resync_does_not_clobber_manual_role(admin_engine: Engine) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            entra_group_role_map.insert().values(
                tenant_id=TENANT_ID,
                group_id="g-emp",
                group_name="Employees",
                role_code="Employee",
            )
        )
    # First sync: user gets Employee from the group.
    users_in = [_gu("obj-9", "Carol AD", "carol@ad.test", groups=("g-emp",))]
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            sync_users(conn, tenant_id=TENANT_ID, graph_users=users_in)

    # Admin manually promotes to Admin.
    with admin_engine.begin() as conn:
        uid = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == TENANT_ID, users.c.email == "carol@ad.test"
            )
        ).scalar_one()
        admin_role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Admin"
            )
        ).scalar_one()
        conn.execute(
            delete(user_roles).where(
                user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == uid
            )
        )
        conn.execute(
            user_roles.insert().values(
                tenant_id=TENANT_ID, user_id=uid, role_id=admin_role_id
            )
        )

    # Re-sync: the manual Admin role must survive.
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(conn, tenant_id=TENANT_ID, graph_users=users_in)
    assert result.updated == 1
    with admin_engine.begin() as conn:
        codes = conn.execute(
            select(roles.c.code)
            .select_from(user_roles.join(roles, roles.c.id == user_roles.c.role_id))
            .where(user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == uid)
        ).all()
    assert [str(c.code) for c in codes] == ["Admin"]


def test_sync_default_role_for_unmapped_users(admin_engine: Engine) -> None:
    """A group mapping wins; the default fills in for everyone else."""

    with admin_engine.begin() as conn:
        conn.execute(
            entra_group_role_map.insert().values(
                tenant_id=TENANT_ID,
                group_id="g-hr",
                group_name="HR",
                role_code="HR",
            )
        )
    graph_users = [
        _gu("obj-h", "Hoda AD", "hoda@ad.test", groups=("g-hr",)),
        _gu("obj-n", "Nils AD", "nils@ad.test", groups=()),
    ]
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(
                conn,
                tenant_id=TENANT_ID,
                graph_users=graph_users,
                default_role="Employee",
            )
    assert result.added == 2
    # Only the unmapped user was given the default.
    assert result.default_role_assigned == 1

    def _codes(email: str) -> list[str]:
        with admin_engine.begin() as conn:
            uid = conn.execute(
                select(users.c.id).where(
                    users.c.tenant_id == TENANT_ID, users.c.email == email
                )
            ).scalar_one()
            rows = conn.execute(
                select(roles.c.code)
                .select_from(
                    user_roles.join(roles, roles.c.id == user_roles.c.role_id)
                )
                .where(
                    user_roles.c.tenant_id == TENANT_ID,
                    user_roles.c.user_id == uid,
                )
            ).all()
        return sorted(str(r.code) for r in rows)

    assert _codes("hoda@ad.test") == ["HR"]  # group mapping wins
    assert _codes("nils@ad.test") == ["Employee"]  # default fallback


def test_default_role_does_not_clobber_manual_role(admin_engine: Engine) -> None:
    """An admin-set role survives a re-sync even with a default in play."""

    users_in = [_gu("obj-m", "Maya AD", "maya@ad.test", groups=())]
    # First sync with a default assigns Employee.
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            sync_users(
                conn,
                tenant_id=TENANT_ID,
                graph_users=users_in,
                default_role="Employee",
            )
    with admin_engine.begin() as conn:
        uid = conn.execute(
            select(users.c.id).where(
                users.c.tenant_id == TENANT_ID, users.c.email == "maya@ad.test"
            )
        ).scalar_one()
        manager_role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            delete(user_roles).where(
                user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == uid
            )
        )
        conn.execute(
            user_roles.insert().values(
                tenant_id=TENANT_ID, user_id=uid, role_id=manager_role_id
            )
        )

    # Re-sync with the default again — must not override the manual role.
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(
                conn,
                tenant_id=TENANT_ID,
                graph_users=users_in,
                default_role="Employee",
            )
    assert result.default_role_assigned == 0
    with admin_engine.begin() as conn:
        codes = conn.execute(
            select(roles.c.code)
            .select_from(user_roles.join(roles, roles.c.id == user_roles.c.role_id))
            .where(user_roles.c.tenant_id == TENANT_ID, user_roles.c.user_id == uid)
        ).all()
    assert [str(c.code) for c in codes] == ["Manager"]


def test_sync_creates_linked_employees(admin_engine: Engine) -> None:
    graph_users = [
        _gu("obj-e1", "Ella AD", "ella@ad.test", groups=()),
        _gu("obj-e2", "Finn AD", "finn@ad.test", groups=()),
    ]
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(
                conn,
                tenant_id=TENANT_ID,
                graph_users=graph_users,
                default_role="Employee",
                create_employees=True,
            )
    assert result.added == 2
    assert result.employees_created == 2

    with admin_engine.begin() as conn:
        emp = conn.execute(
            select(
                employees.c.employee_code,
                employees.c.status,
                employees.c.full_name,
            ).where(
                employees.c.tenant_id == TENANT_ID,
                func.lower(employees.c.email) == "ella@ad.test",
            )
        ).first()
    assert emp is not None
    assert emp.status == "active"
    assert emp.full_name == "Ella AD"
    assert emp.employee_code.startswith("AD")

    # Re-sync must not duplicate the employee rows.
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            again = sync_users(
                conn,
                tenant_id=TENANT_ID,
                graph_users=graph_users,
                create_employees=True,
            )
    assert again.employees_created == 0
    with admin_engine.begin() as conn:
        count = conn.execute(
            select(func.count())
            .select_from(employees)
            .where(
                employees.c.tenant_id == TENANT_ID,
                func.lower(employees.c.email).like("%@ad.test"),
            )
        ).scalar_one()
    assert count == 2


def test_sync_without_create_employees_makes_none(admin_engine: Engine) -> None:
    graph_users = [_gu("obj-x", "Gwen AD", "gwen@ad.test", groups=())]
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            result = sync_users(
                conn, tenant_id=TENANT_ID, graph_users=graph_users
            )
    assert result.employees_created == 0
    with admin_engine.begin() as conn:
        emp = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == TENANT_ID,
                func.lower(employees.c.email) == "gwen@ad.test",
            )
        ).first()
    assert emp is None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def test_run_sync_endpoint(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _configure_entra(admin_engine)
    _login_admin(client, admin_user)

    # Map a group to HR.
    put = client.put(
        "/api/entra-sync/group-roles",
        json={
            "entries": [
                {"group_id": "g-hr", "group_name": "HR Team", "role_code": "HR"}
            ]
        },
    )
    assert put.status_code == 200, put.text

    set_test_directory_client(
        FakeDir(
            [
                _gu("o1", "Dana AD", "dana@ad.test", groups=("g-hr",)),
                _gu("o2", "Erin AD", "erin@ad.test", groups=()),
            ],
            groups_by_user={"o1": ("g-hr",), "o2": ()},
        )
    )
    run = client.post("/api/entra-sync/run")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["added"] == 2
    assert body["failed"] == 0

    lst = client.get("/api/entra-sync/users")
    assert lst.status_code == 200
    data = lst.json()
    assert data["total"] == 2
    assert data["enabled"] == 0  # both access OFF
    assert data["disabled"] == 2
    dana = next(u for u in data["items"] if u["email"] == "dana@ad.test")
    assert dana["role_codes"] == ["HR"]
    assert dana["source"] == "entra"
    assert dana["ad_status"] == "active"


def test_run_sync_endpoint_default_role(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _configure_entra(admin_engine)
    _login_admin(client, admin_user)
    set_test_directory_client(
        FakeDir(
            [_gu("od1", "Omar AD", "omar@ad.test", groups=())],
            groups_by_user={"od1": ()},
        )
    )
    run = client.post("/api/entra-sync/run", json={"default_role": "Employee"})
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["added"] == 1
    assert body["default_role_assigned"] == 1

    got = client.get("/api/entra-sync/users").json()
    omar = next(u for u in got["items"] if u["email"] == "omar@ad.test")
    assert omar["role_codes"] == ["Employee"]


def test_run_sync_endpoint_creates_employees_and_links(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _configure_entra(admin_engine)
    _login_admin(client, admin_user)
    set_test_directory_client(
        FakeDir(
            [_gu("oe9", "Gus AD", "gus@ad.test", groups=())],
            groups_by_user={"oe9": ()},
        )
    )
    run = client.post(
        "/api/entra-sync/run",
        json={"default_role": "Employee", "create_employees": True},
    )
    assert run.status_code == 200, run.text
    assert run.json()["employees_created"] == 1

    got = client.get("/api/entra-sync/users").json()
    gus = next(u for u in got["items"] if u["email"] == "gus@ad.test")
    # The AD user row now carries the linked employee id for the drawer.
    assert gus["employee_id"] is not None


def test_run_sync_endpoint_rejects_bad_default_role(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _configure_entra(admin_engine)
    _login_admin(client, admin_user)
    set_test_directory_client(FakeDir([], groups_by_user={}))
    resp = client.post("/api/entra-sync/run", json={"default_role": "Wizard"})
    assert resp.status_code == 422


def test_run_sync_requires_entra_config(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    # No config set → 400.
    resp = client.post("/api/entra-sync/run")
    assert resp.status_code == 400
    assert "not fully configured" in resp.json()["detail"]


def test_login_activity_shape(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _configure_entra(admin_engine)
    _login_admin(client, admin_user)
    set_test_directory_client(
        FakeDir([_gu("o5", "Fay AD", "fay@ad.test")], groups_by_user={"o5": ()})
    )
    assert client.post("/api/entra-sync/run").status_code == 200

    lst = client.get("/api/entra-sync/users").json()
    uid = lst["items"][0]["id"]
    act = client.get(f"/api/entra-sync/users/{uid}/login-activity")
    assert act.status_code == 200
    body = act.json()
    assert body["user_id"] == uid
    assert body["created_by"] == "AD Sync"
    assert body["login_count"] == 0
    assert body["is_active"] is False


def test_group_roles_crud_and_audit(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login_admin(client, admin_user)
    put = client.put(
        "/api/entra-sync/group-roles",
        json={
            "entries": [
                {"group_id": "g1", "group_name": "One", "role_code": "Manager"},
                {"group_id": "g2", "group_name": "Two", "role_code": "Employee"},
            ]
        },
    )
    assert put.status_code == 200
    got = client.get("/api/entra-sync/group-roles").json()
    assert {e["group_id"] for e in got["entries"]} == {"g1", "g2"}

    # Invalid role rejected.
    bad = client.put(
        "/api/entra-sync/group-roles",
        json={"entries": [{"group_id": "g9", "role_code": "Wizard"}]},
    )
    assert bad.status_code == 422


def test_employee_cannot_use_ad_endpoints(
    client: TestClient, employee_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": employee_user["email"], "password": employee_user["password"]},
    )
    assert resp.status_code == 200
    assert client.get("/api/entra-sync/users").status_code == 403
    assert client.post("/api/entra-sync/run").status_code == 403
    assert client.get("/api/entra-sync/group-roles").status_code == 403
