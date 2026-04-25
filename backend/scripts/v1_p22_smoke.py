"""End-to-end smoke for v1.0 P22 — dark mode + density persistence.

Exercises the round-trip the prompt asks for:

  1. Log in.
  2. PATCH /api/auth/preferred-theme → "dark".
  3. PATCH /api/auth/preferred-density → "compact".
  4. Log out, log back in.
  5. GET /api/auth/me — confirm both fields persisted.

Run inside the backend container; the TestClient dance keeps the
smoke independent of the host network.
"""

from __future__ import annotations

import secrets
import sys

from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select

from hadir.auth.passwords import hash_password
from hadir.db import (
    make_admin_engine,
    roles,
    user_roles,
    users,
)
from hadir.main import app


TENANT_ID = 1


def _make_admin(engine, email: str, password: str) -> int:
    pwh = hash_password(password)
    with engine.begin() as conn:
        uid = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name="P22 Smoke Admin",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        rid = int(
            conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == TENANT_ID, roles.c.code == "Admin"
                )
            ).scalar_one()
        )
        conn.execute(
            insert(user_roles).values(
                tenant_id=TENANT_ID, user_id=uid, role_id=rid
            )
        )
    return uid


def _cleanup(engine, uid: int) -> None:
    with engine.begin() as conn:
        conn.execute(
            delete(user_roles).where(
                user_roles.c.tenant_id == TENANT_ID,
                user_roles.c.user_id == uid,
            )
        )
        conn.execute(delete(users).where(users.c.id == uid))


def main() -> int:
    suffix = secrets.token_hex(3)
    email = f"p22-{suffix}@smoke.hadir"
    password = "p22-smoke-pw"
    engine = make_admin_engine()
    uid = _make_admin(engine, email, password)
    try:
        with TestClient(app) as client:
            r = client.post(
                "/api/auth/login", json={"email": email, "password": password}
            )
            if r.status_code != 200:
                print(f"FAIL: login {r.status_code} {r.text}", file=sys.stderr)
                return 2

            r = client.patch(
                "/api/auth/preferred-theme",
                json={"preferred_theme": "dark"},
            )
            if r.status_code != 200 or r.json()["preferred_theme"] != "dark":
                print(f"FAIL: theme set {r.status_code} {r.text}", file=sys.stderr)
                return 3

            r = client.patch(
                "/api/auth/preferred-density",
                json={"preferred_density": "compact"},
            )
            if (
                r.status_code != 200
                or r.json()["preferred_density"] != "compact"
            ):
                print(
                    f"FAIL: density set {r.status_code} {r.text}",
                    file=sys.stderr,
                )
                return 4

            client.post("/api/auth/logout")
            r = client.post(
                "/api/auth/login", json={"email": email, "password": password}
            )
            if r.status_code != 200:
                print(
                    f"FAIL: relogin {r.status_code} {r.text}",
                    file=sys.stderr,
                )
                return 5
            body = r.json()
            if (
                body.get("preferred_theme") != "dark"
                or body.get("preferred_density") != "compact"
            ):
                print(
                    "FAIL: preferences did not persist across relogin: "
                    f"theme={body.get('preferred_theme')} "
                    f"density={body.get('preferred_density')}",
                    file=sys.stderr,
                )
                return 6

            r = client.get("/api/auth/me")
            me = r.json()
            print(
                "OK preferences persisted across logout + login: "
                f"theme={me['preferred_theme']} density={me['preferred_density']}"
            )
            print("OK P22 smoke")
            return 0
    finally:
        _cleanup(engine, uid)


if __name__ == "__main__":
    raise SystemExit(main())
