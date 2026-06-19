"""RTSP reconnect config endpoints (migration 0085).

Covers:

* GET returns defaults (enabled / 30 s) for a fresh tenant.
* PUT round-trips an enabled change (value in seconds) — reflected in
  the next GET, with an audit row carrying before/after JSONB.
* PUT round-trips a disabled config (enabled=false).
* PUT validates interval bounds with **400** (below 5 s, above 24 h)
  and rejects a missing field.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.engine import Engine

from maugood.db import audit_log


_DEFAULTS = {"enabled": True, "interval_seconds": 30}


def _login(client: TestClient, user: dict) -> None:
    client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )


def _reset(client: TestClient) -> None:
    client.put("/api/system/reconnect-config", json=_DEFAULTS)


def test_get_reconnect_config_returns_defaults(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _reset(client)
    resp = client.get("/api/system/reconnect-config")
    assert resp.status_code == 200, resp.text
    assert resp.json() == _DEFAULTS


def test_put_reconnect_config_round_trips(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    new_config = {"enabled": True, "interval_seconds": 300}  # 5 min
    resp = client.put("/api/system/reconnect-config", json=new_config)
    assert resp.status_code == 200, resp.text
    assert resp.json() == new_config

    resp2 = client.get("/api/system/reconnect-config")
    assert resp2.status_code == 200
    assert resp2.json() == new_config

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.action, audit_log.c.before, audit_log.c.after)
            .where(audit_log.c.action == "system.reconnect_config.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before is not None
    assert row.after == new_config
    _reset(client)


def test_put_reconnect_config_disabled_round_trips(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    cfg = {"enabled": False, "interval_seconds": 30}
    resp = client.put("/api/system/reconnect-config", json=cfg)
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is False
    assert client.get("/api/system/reconnect-config").json()["enabled"] is False
    _reset(client)


def test_put_reconnect_config_rejects_below_min(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/system/reconnect-config",
        json={"enabled": True, "interval_seconds": 1},  # < 5 s floor
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == "interval_seconds"


def test_put_reconnect_config_rejects_above_max(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/system/reconnect-config",
        json={"enabled": True, "interval_seconds": 999_999},  # > 24 h
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == "interval_seconds"


def test_put_reconnect_config_rejects_missing_field(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/system/reconnect-config", json={"enabled": True}
    )
    assert resp.status_code == 400, resp.text
