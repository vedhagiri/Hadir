"""Phase C — clip encoding config endpoints.

Covers:

* GET returns defaults for a fresh tenant.
* PUT validates bounds + field names (400 with named field on bad
  input).
* PUT round-trips: valid update reflects in the next GET.
* Audit row records before/after on every change.
* Endpoint is Admin-only — Employee gets 403.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.engine import Engine

from maugood.db import audit_log


_DEFAULTS = {
    # Migration 0056 — faster defaults: veryfast preset, CRF 26,
    # downscale to 720p. ~6-10× faster encoding for typical 1440p
    # surveillance sources.
    "chunk_duration_sec": 180,
    "video_crf": 26,
    "video_preset": "veryfast",
    "resolution_max_height": 720,
    "keep_chunks_after_merge": False,
}


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def test_get_clip_encoding_config_returns_defaults(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/system/clip-encoding-config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Migration server_default seeds these values on the tenant_settings
    # row at provision time. Fresh tenants get the same defaults via
    # the in-router fallback.
    assert body == _DEFAULTS


@pytest.mark.parametrize(
    "field,bad_value",
    [
        # chunk_duration_sec: 60 ≤ x ≤ 600
        ("chunk_duration_sec", 59),
        ("chunk_duration_sec", 601),
        ("chunk_duration_sec", -1),
        # video_crf: 18 ≤ x ≤ 30
        ("video_crf", 17),
        ("video_crf", 31),
        # video_preset: one of the x264 preset list
        ("video_preset", "nonsense"),
        ("video_preset", "ULTRAFAST"),  # case sensitive
        # resolution_max_height: null or one of the curated set
        ("resolution_max_height", 360),
        ("resolution_max_height", 4320),
        ("resolution_max_height", 0),
    ],
)
def test_put_clip_encoding_config_rejects_out_of_range(
    client: TestClient,
    admin_user: dict,
    field: str,
    bad_value: object,
) -> None:
    _login(client, admin_user)
    payload = dict(_DEFAULTS)
    payload[field] = bad_value
    resp = client.put("/api/system/clip-encoding-config", json=payload)
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    # The Pydantic validation surfaces the offending field on the
    # detail object via the shared _validation_to_400 helper.
    assert detail["field"] == field, detail


def test_put_clip_encoding_config_rejects_unknown_key(
    client: TestClient, admin_user: dict
) -> None:
    """``extra='forbid'`` on the Pydantic model means an unknown key
    is a 400 — operators can't smuggle in fields the worker doesn't
    know how to interpret."""
    _login(client, admin_user)
    payload = dict(_DEFAULTS)
    payload["mystery_key"] = "value"
    resp = client.put("/api/system/clip-encoding-config", json=payload)
    assert resp.status_code == 400, resp.text


def test_put_clip_encoding_config_round_trips_and_audits(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)

    new_config = {
        "chunk_duration_sec": 60,
        "video_crf": 28,
        "video_preset": "veryfast",
        "resolution_max_height": 720,
        "keep_chunks_after_merge": True,
    }
    resp = client.put("/api/system/clip-encoding-config", json=new_config)
    assert resp.status_code == 200, resp.text
    assert resp.json() == new_config

    # Round-trip via GET.
    resp2 = client.get("/api/system/clip-encoding-config")
    assert resp2.status_code == 200
    assert resp2.json() == new_config

    # Audit row carries before + after JSONB.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(audit_log.c.action == "system.clip_encoding_config.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before is not None
    assert row.after == new_config

    # Reset to defaults so subsequent tests see a clean slate.
    client.put("/api/system/clip-encoding-config", json=_DEFAULTS)


def test_put_clip_encoding_config_accepts_null_resolution(
    client: TestClient, admin_user: dict
) -> None:
    """``null`` is the keep-native sentinel; the validator must
    accept it alongside the integer enum."""
    _login(client, admin_user)
    payload = dict(_DEFAULTS)
    payload["resolution_max_height"] = None
    resp = client.put("/api/system/clip-encoding-config", json=payload)
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolution_max_height"] is None


def test_clip_encoding_endpoints_admin_only(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.get("/api/system/clip-encoding-config")
    assert resp.status_code == 403
    resp = client.put("/api/system/clip-encoding-config", json=_DEFAULTS)
    assert resp.status_code == 403
