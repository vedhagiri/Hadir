"""P22 — preferred_theme + preferred_density endpoints.

Mirrors the P21 ``preferred_language`` test shape: round-trip set,
clear via null, reject invalid values, audit row written, and a
defensive DB-level CHECK that rejects bogus values regardless of
the API path. Synthetic Super-Admin returns the current state
without touching the DB.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from maugood.db import audit_log, get_engine, users


def _login(client, admin_user) -> None:
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200, resp.text


# --- theme ------------------------------------------------------------


@pytest.mark.parametrize("theme", ["system", "light", "dark"])
def test_patch_preferred_theme_sets_value(admin_user, client, theme):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-theme", json={"preferred_theme": theme}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_theme"] == theme

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(users.c.preferred_theme).where(users.c.id == admin_user["id"])
        ).first()
    assert row is not None and row[0] == theme


def test_patch_preferred_theme_clears_with_null(admin_user, client):
    _login(client, admin_user)
    client.patch("/api/auth/preferred-theme", json={"preferred_theme": "dark"})
    resp = client.patch(
        "/api/auth/preferred-theme", json={"preferred_theme": None}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_theme"] is None

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(users.c.preferred_theme).where(users.c.id == admin_user["id"])
        ).first()
    assert row is not None and row[0] is None


def test_patch_preferred_theme_rejects_invalid(admin_user, client):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-theme", json={"preferred_theme": "neon"}
    )
    assert resp.status_code == 400, resp.text


def test_patch_preferred_theme_writes_audit_row(admin_user, client):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-theme", json={"preferred_theme": "dark"}
    )
    assert resp.status_code == 200
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.actor_user_id == admin_user["id"],
                audit_log.c.action == "auth.preferred_theme.updated",
            )
        ).all()
    assert rows, "audit row missing"
    assert any(r.after.get("preferred_theme") == "dark" for r in rows)


# --- density ------------------------------------------------------------


@pytest.mark.parametrize("density", ["compact", "comfortable"])
def test_patch_preferred_density_sets_value(admin_user, client, density):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-density", json={"preferred_density": density}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_density"] == density


def test_patch_preferred_density_clears_with_null(admin_user, client):
    _login(client, admin_user)
    client.patch(
        "/api/auth/preferred-density", json={"preferred_density": "compact"}
    )
    resp = client.patch(
        "/api/auth/preferred-density", json={"preferred_density": None}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_density"] is None


def test_patch_preferred_density_rejects_invalid(admin_user, client):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-density", json={"preferred_density": "tiny"}
    )
    assert resp.status_code == 400, resp.text


def test_patch_preferred_density_writes_audit_row(admin_user, client):
    _login(client, admin_user)
    resp = client.patch(
        "/api/auth/preferred-density", json={"preferred_density": "compact"}
    )
    assert resp.status_code == 200
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.actor_user_id == admin_user["id"],
                audit_log.c.action == "auth.preferred_density.updated",
            )
        ).all()
    assert rows, "audit row missing"
    assert any(r.after.get("preferred_density") == "compact" for r in rows)


# --- DB-level CHECK constraint backstop ---------------------------------


def test_db_rejects_invalid_theme_directly(admin_user):
    """The DB CHECK constraint must reject values the API would
    have caught — defence in depth against future code paths that
    skip the validator."""

    engine = get_engine()
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                users.update()
                .where(users.c.id == admin_user["id"])
                .values(preferred_theme="neon")
            )


def test_db_rejects_invalid_density_directly(admin_user):
    engine = get_engine()
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                users.update()
                .where(users.c.id == admin_user["id"])
                .values(preferred_density="micro")
            )


# --- /me round-trip ----------------------------------------------------


def test_me_returns_theme_and_density(admin_user, client):
    _login(client, admin_user)
    client.patch("/api/auth/preferred-theme", json={"preferred_theme": "dark"})
    client.patch(
        "/api/auth/preferred-density", json={"preferred_density": "compact"}
    )
    resp = client.get("/api/auth/me")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["preferred_theme"] == "dark"
    assert body["preferred_density"] == "compact"
