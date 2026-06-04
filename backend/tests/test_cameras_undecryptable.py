"""Regression test: one undecryptable RTSP ciphertext must not 500 the
whole cameras list/create surface (cameras-500-on-bad-ciphertext).

Before the fix, ``_decrypt_and_parse_host`` let ``decrypt_url``'s
``RuntimeError`` (Fernet-key mismatch / corrupt token) propagate through
``list_cameras`` → HTTP 500, taking down ``GET/POST /api/cameras`` for
the entire tenant. The fix degrades a single bad row to a placeholder
host instead of failing the request.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import update

from maugood.cameras.repository import (
    _UNDECRYPTABLE_HOST,
    _decrypt_and_parse_host,
)
from maugood.db import cameras


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def test_decrypt_helper_returns_placeholder_not_raises() -> None:
    # Garbage ciphertext: must NOT raise; returns the placeholder host.
    assert _decrypt_and_parse_host("not-a-valid-fernet-token") == _UNDECRYPTABLE_HOST
    assert _decrypt_and_parse_host("") == _UNDECRYPTABLE_HOST


def test_list_survives_undecryptable_row(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    resp = client.post(
        "/api/cameras",
        json={
            "name": "BadCipher Cam",
            "location": "",
            "rtsp_url": "rtsp://u:p@10.0.0.9:554/s",
            "worker_enabled": False,
            "display_enabled": True,
        },
    )
    assert resp.status_code in (200, 201), resp.text
    cam_id = resp.json()["id"]

    try:
        # Corrupt the stored ciphertext directly (simulates a Fernet-key
        # mismatch / DB-restored-with-wrong-key row).
        with admin_engine.begin() as conn:
            conn.execute(
                update(cameras)
                .where(cameras.c.id == cam_id)
                .values(rtsp_url_encrypted="not-a-valid-fernet-token")
            )

        # The list endpoint must stay 200, returning the bad row with a
        # placeholder host rather than 500-ing the whole tenant.
        r = client.get("/api/cameras")
        assert r.status_code == 200, r.text
        rows = r.json()["items"]
        bad = next((c for c in rows if c["id"] == cam_id), None)
        assert bad is not None, "bad row missing from list"
        assert bad["rtsp_host"] == _UNDECRYPTABLE_HOST
        # And no plaintext credential leaked into the response.
        assert "u:p@" not in r.text
    finally:
        with admin_engine.begin() as conn:
            conn.execute(cameras.delete().where(cameras.c.id == cam_id))
