"""Pytest coverage for Entra ID OIDC (v1.0 P6).

Covers the two user-facing routes (``/login`` redirect + ``/callback``
exchange), the Admin config CRUD with discovery validation, and the
red-line refusals: no auto-provision, no secret in API responses, no
secret in audit rows.

We never hit Microsoft. The ``set_test_oidc_provider`` hook in
``hadir.auth.oidc`` lets us swap the discover / JWKS / token-exchange
calls for an in-process fake that mints ID tokens with a test RSA
keypair generated per test session.
"""

from __future__ import annotations

import base64
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import pytest
from authlib.jose import JsonWebKey, jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.engine import Engine

from hadir.auth.oidc import (
    STATE_COOKIE_NAME,
    _DiscoveryDoc,
    _sign_state,
    clear_caches,
    encrypt_secret,
    set_test_oidc_provider,
)
from hadir.db import audit_log, tenant_context, tenant_oidc_config


# ---------------------------------------------------------------------------
# Test RSA key + fake provider
# ---------------------------------------------------------------------------

# Generate a single key per test session — unmocking + remocking the
# OIDC provider between tests is fine because validation only depends
# on the public key surfaced via the JWKS stub.
_TEST_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_TEST_PRIVATE_PEM = _TEST_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode()
_TEST_PUBLIC_PEM = _TEST_KEY.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
)
_TEST_JWK = json.loads(JsonWebKey.import_key(_TEST_PUBLIC_PEM).as_json())
_TEST_JWK["kid"] = "test-key-1"
_TEST_JWK["use"] = "sig"
_TEST_JWK["alg"] = "RS256"


@dataclass(frozen=True, slots=True)
class FakeProvider:
    """Stub for ``hadir.auth.oidc._test_oidc_provider``."""

    issuer: str = "https://login.microsoftonline.com/test-entra/v2.0"
    authorization_endpoint: str = "https://example.test/authorize"
    token_endpoint: str = "https://example.test/token"
    jwks_uri: str = "https://example.test/jwks"
    next_token: dict | None = None

    def discover(self, _entra_tenant_id: str) -> _DiscoveryDoc:
        return _DiscoveryDoc(
            issuer=self.issuer,
            authorization_endpoint=self.authorization_endpoint,
            token_endpoint=self.token_endpoint,
            jwks_uri=self.jwks_uri,
            raw={},
        )

    def jwks(self, _jwks_uri: str) -> list[dict]:
        return [_TEST_JWK]

    def token_exchange(self, **_: Any) -> dict:
        # The /callback test sets ``next_token`` on the instance via
        # the helper below — this fallback isn't used directly.
        return self.next_token or {}


def _mint_id_token(
    *,
    issuer: str,
    audience: str,
    nonce: str,
    email: str,
    expires_in: int = 600,
) -> str:
    now = int(time.time())
    header = {"alg": "RS256", "kid": "test-key-1", "typ": "JWT"}
    payload = {
        "iss": issuer,
        "aud": audience,
        "sub": "test-sub-" + secrets.token_hex(4),
        "email": email,
        "nonce": nonce,
        "iat": now,
        "nbf": now,
        "exp": now + expires_in,
    }
    return jwt.encode(header, payload, _TEST_PRIVATE_PEM).decode()


@pytest.fixture(autouse=True)
def _reset_oidc_caches() -> Iterator[None]:
    clear_caches()
    yield
    clear_caches()
    set_test_oidc_provider(None)


@pytest.fixture(autouse=True)
def _reset_oidc_config_row(admin_engine: Engine) -> Iterator[None]:
    """Restore tenant_id=1's OIDC config to defaults around every test.

    Some tests in this file (config CRUD, dual-audit) leave the row in
    the configured-and-enabled state. Without resetting on BOTH sides
    of the yield, the order-sensitive ``test_status_off_when_no_config``
    flakes when an earlier test run dirtied the row.
    """

    def _reset() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenant_oidc_config)
                .where(tenant_oidc_config.c.tenant_id == 1)
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


@pytest.fixture
def fake_provider() -> Iterator[FakeProvider]:
    p = FakeProvider()
    set_test_oidc_provider(p)
    try:
        yield p
    finally:
        set_test_oidc_provider(None)


@pytest.fixture
def configured_oidc(admin_engine: Engine) -> Iterator[dict]:
    """Pre-load tenant_id=1 with valid OIDC config."""

    secret = "real-entra-secret-DO-NOT-LEAK"
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_oidc_config)
            .where(tenant_oidc_config.c.tenant_id == 1)
            .values(
                entra_tenant_id="test-entra",
                client_id="test-client-id",
                client_secret_encrypted=encrypt_secret(secret),
                enabled=True,
            )
        )
    try:
        yield {"client_id": "test-client-id", "client_secret": secret}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenant_oidc_config)
                .where(tenant_oidc_config.c.tenant_id == 1)
                .values(
                    entra_tenant_id="",
                    client_id="",
                    client_secret_encrypted=None,
                    enabled=False,
                )
            )


# ---------------------------------------------------------------------------
# /status (anonymous probe)
# ---------------------------------------------------------------------------


def test_status_off_when_no_config(client: TestClient) -> None:
    resp = client.get("/api/auth/oidc/status", params={"tenant": "main"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["has_config"] is False


def test_status_unknown_slug_returns_disabled(client: TestClient) -> None:
    resp = client.get("/api/auth/oidc/status", params={"tenant": "no-such-tenant"})
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False, "has_config": False}


def test_status_on_when_config_complete(
    client: TestClient, configured_oidc: dict
) -> None:
    resp = client.get("/api/auth/oidc/status", params={"tenant": "main"})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True


# ---------------------------------------------------------------------------
# /login redirect
# ---------------------------------------------------------------------------


def test_login_redirects_to_authorize_url(
    client: TestClient, fake_provider: FakeProvider, configured_oidc: dict
) -> None:
    resp = client.get(
        "/api/auth/oidc/login",
        params={"tenant": "main"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith(
        fake_provider.authorization_endpoint
    )

    # The state cookie should have been set on /api/auth/oidc path.
    state_cookie = client.cookies.get(STATE_COOKIE_NAME)
    assert state_cookie, "state cookie should be set"

    # Authorize URL carries the same state value as the cookie payload.
    qs = parse_qs(urlparse(resp.headers["location"]).query)
    body_b64 = state_cookie.split(".")[0]
    payload = json.loads(
        base64.urlsafe_b64decode(body_b64 + "=" * (-len(body_b64) % 4))
    )
    assert qs["state"][0] == payload["state"]
    assert qs["client_id"][0] == "test-client-id"
    assert qs["nonce"][0] == payload["nonce"]


def test_login_refuses_when_oidc_disabled(client: TestClient) -> None:
    resp = client.get(
        "/api/auth/oidc/login",
        params={"tenant": "main"},
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_login_404s_unknown_tenant(client: TestClient) -> None:
    resp = client.get(
        "/api/auth/oidc/login",
        params={"tenant": "no-such"},
        follow_redirects=False,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /callback happy + refusal paths
# ---------------------------------------------------------------------------


def _seed_state_cookie(client: TestClient, *, schema: str = "main") -> tuple[str, str]:
    """Plant a valid signed state cookie + return (state, nonce).

    The state cookie carries the **schema name** (server-set,
    server-read internal routing state) — distinct from the
    friendly slug callers use elsewhere.
    """

    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)
    payload = {
        "tenant_schema": schema,
        "tenant_id": 1,
        "state": state,
        "nonce": nonce,
        "ts": int(time.time()),
    }
    cookie = _sign_state(payload)
    client.cookies.set(STATE_COOKIE_NAME, cookie, path="/api/auth/oidc")
    return state, nonce


class _FakeProviderForCallback(FakeProvider):
    """Subclass that returns a pre-configured token + JWK on demand."""

    def __init__(self, id_token: str) -> None:  # type: ignore[no-untyped-def]
        super().__init__()
        object.__setattr__(self, "_id_token", id_token)

    def token_exchange(self, **_: Any) -> dict:
        return {"id_token": getattr(self, "_id_token"), "access_token": "redacted"}


def test_callback_happy_path_creates_session(
    client: TestClient,
    configured_oidc: dict,
    admin_user: dict,
) -> None:
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        issuer="https://login.microsoftonline.com/test-entra/v2.0",
        audience="test-client-id",
        nonce=nonce,
        email=admin_user["email"],
    )
    set_test_oidc_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/oidc/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"] == "/"
    assert client.cookies.get("hadir_session"), "session cookie should be set"
    assert client.cookies.get("hadir_tenant") == "main"

    # /api/auth/me must work with the new session cookie.
    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["email"].lower() == admin_user["email"].lower()


def test_callback_refuses_unknown_email_with_prescribed_message(
    client: TestClient,
    configured_oidc: dict,
    admin_engine: Engine,
) -> None:
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        issuer="https://login.microsoftonline.com/test-entra/v2.0",
        audience="test-client-id",
        nonce=nonce,
        email="not-in-hadir@whatever.example",
    )
    set_test_oidc_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/oidc/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 403
    assert "not registered in Hadir" in resp.json()["detail"]
    assert "Contact your administrator" in resp.json()["detail"]
    assert not client.cookies.get("hadir_session"), "must NOT set session"

    # Failure audit row written.
    with tenant_context("main"):
        with admin_engine.begin() as conn:
            from sqlalchemy import select  # noqa: PLC0415

            rows = conn.execute(
                select(audit_log.c.action, audit_log.c.after).where(
                    audit_log.c.action == "auth.oidc.login.failure",
                )
                .order_by(audit_log.c.id.desc())
                .limit(1)
            ).all()
    assert rows
    assert rows[0].after.get("reason") == "no_user_match"
    assert rows[0].after.get("email_attempted") == "not-in-hadir@whatever.example"


def test_callback_rejects_state_mismatch(
    client: TestClient, configured_oidc: dict, fake_provider: FakeProvider
) -> None:
    _seed_state_cookie(client)
    resp = client.get(
        "/api/auth/oidc/callback",
        params={"code": "code", "state": "tampered"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "oidc state mismatch"


def test_callback_rejects_missing_state_cookie(
    client: TestClient, fake_provider: FakeProvider
) -> None:
    resp = client.get(
        "/api/auth/oidc/callback",
        params={"code": "code", "state": "anything"},
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_callback_rejects_id_token_with_wrong_nonce(
    client: TestClient, configured_oidc: dict
) -> None:
    state, _real_nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        issuer="https://login.microsoftonline.com/test-entra/v2.0",
        audience="test-client-id",
        nonce="completely-different-nonce",
        email="any@hadir.test",
    )
    set_test_oidc_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/oidc/callback",
        params={"code": "code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Config CRUD (Admin)
# ---------------------------------------------------------------------------


def test_get_config_masks_secret(
    client: TestClient, admin_user: dict, configured_oidc: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    cfg = client.get("/api/auth/oidc/config")
    assert cfg.status_code == 200
    body = cfg.json()
    assert body["has_secret"] is True
    assert "client_secret" not in body
    assert "client_secret_encrypted" not in body


def test_put_config_validates_discovery(
    client: TestClient, admin_user: dict, fake_provider: FakeProvider
) -> None:
    """A PUT that flips ``enabled=True`` must ping discovery first."""

    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    # Fail-discovery scenario: replace the fake provider's discover with one that raises.
    class _Broken:
        def discover(self, _t: str):  # type: ignore[no-untyped-def]
            raise RuntimeError("fake discovery failure")

        def jwks(self, _u: str):  # type: ignore[no-untyped-def]
            return []

        def token_exchange(self, **_: Any):  # type: ignore[no-untyped-def]
            return {}

    set_test_oidc_provider(_Broken())
    bad = client.put(
        "/api/auth/oidc/config",
        json={
            "entra_tenant_id": "bad-tenant",
            "client_id": "x",
            "client_secret": "y",
            "enabled": True,
        },
    )
    assert bad.status_code == 400
    assert "discovery validation failed" in bad.json()["detail"]

    # Restore working provider — save now succeeds and persists.
    set_test_oidc_provider(fake_provider)
    ok = client.put(
        "/api/auth/oidc/config",
        json={
            "entra_tenant_id": "test-entra",
            "client_id": "test-client",
            "client_secret": "very-secret",
            "enabled": True,
        },
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["enabled"] is True
    assert body["entra_tenant_id"] == "test-entra"
    assert body["has_secret"] is True
    # Secret never echoed back.
    assert "client_secret" not in body


def test_audit_does_not_carry_plain_secret(
    client: TestClient, admin_user: dict, fake_provider: FakeProvider, admin_engine: Engine
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    payload = {
        "entra_tenant_id": "test-entra",
        "client_id": "test-client",
        "client_secret": "secret-must-not-appear-in-audit",
        "enabled": True,
    }
    ok = client.put("/api/auth/oidc/config", json=payload)
    assert ok.status_code == 200

    with admin_engine.begin() as conn:
        from sqlalchemy import select  # noqa: PLC0415

        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.before, audit_log.c.after).where(
                audit_log.c.action == "auth.oidc.config_updated",
                audit_log.c.actor_user_id == admin_user["id"],
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).all()
    assert rows
    blob = json.dumps([dict(rows[0]._mapping)], default=str)
    assert "secret-must-not-appear-in-audit" not in blob


def test_employee_role_cannot_read_config(
    client: TestClient, employee_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": employee_user["email"], "password": employee_user["password"]},
    )
    assert resp.status_code == 200
    cfg = client.get("/api/auth/oidc/config")
    assert cfg.status_code == 403
