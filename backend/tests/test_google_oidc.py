"""Pytest coverage for Google Sign-In OIDC.

Parallels ``test_oidc.py`` (Entra). Covers the ``/login`` redirect,
the ``/callback`` exchange, the Google-specific claim checks
(``email_verified`` + hosted-domain restriction), the Admin config
CRUD, and the red-line refusals: no auto-provision, no secret in API
responses, no secret in audit rows.

We never hit Google. ``set_test_google_provider`` swaps the discover /
JWKS / token-exchange calls for an in-process fake that mints ID tokens
with a test RSA keypair.
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

from maugood.auth.google_oidc import (
    STATE_COOKIE_NAME,
    clear_caches,
    set_test_google_provider,
)
from maugood.auth.oidc import _DiscoveryDoc, _sign_state, encrypt_secret
from maugood.db import audit_log, tenant_context, tenant_google_oidc_config

_GOOGLE_ISSUER = "https://accounts.google.com"


# ---------------------------------------------------------------------------
# Test RSA key + fake provider
# ---------------------------------------------------------------------------

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
_TEST_JWK["kid"] = "test-key-g"
_TEST_JWK["use"] = "sig"
_TEST_JWK["alg"] = "RS256"


@dataclass(frozen=True, slots=True)
class FakeProvider:
    """Stub for ``maugood.auth.google_oidc._test_google_provider``."""

    authorization_endpoint: str = "https://accounts.google.com/o/oauth2/v2/auth"
    token_endpoint: str = "https://oauth2.googleapis.test/token"
    jwks_uri: str = "https://www.googleapis.test/oauth2/v3/certs"
    next_token: dict | None = None

    def discover(self) -> _DiscoveryDoc:
        return _DiscoveryDoc(
            issuer=_GOOGLE_ISSUER,
            authorization_endpoint=self.authorization_endpoint,
            token_endpoint=self.token_endpoint,
            jwks_uri=self.jwks_uri,
            raw={},
        )

    def jwks(self, _jwks_uri: str) -> list[dict]:
        return [_TEST_JWK]

    def token_exchange(self, **_: Any) -> dict:
        return self.next_token or {}


def _mint_id_token(
    *,
    audience: str,
    nonce: str,
    email: str,
    email_verified: Any = True,
    hd: str | None = None,
    expires_in: int = 600,
) -> str:
    now = int(time.time())
    header = {"alg": "RS256", "kid": "test-key-g", "typ": "JWT"}
    payload: dict[str, Any] = {
        "iss": _GOOGLE_ISSUER,
        "aud": audience,
        "sub": "test-sub-" + secrets.token_hex(4),
        "email": email,
        "email_verified": email_verified,
        "nonce": nonce,
        "iat": now,
        "nbf": now,
        "exp": now + expires_in,
    }
    if hd is not None:
        payload["hd"] = hd
    return jwt.encode(header, payload, _TEST_PRIVATE_PEM).decode()


@pytest.fixture(autouse=True)
def _reset_google_caches() -> Iterator[None]:
    clear_caches()
    yield
    clear_caches()
    set_test_google_provider(None)


@pytest.fixture(autouse=True)
def _reset_google_config_row(admin_engine: Engine) -> Iterator[None]:
    """Restore tenant_id=1's Google config to defaults around every test."""

    def _reset() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenant_google_oidc_config)
                .where(tenant_google_oidc_config.c.tenant_id == 1)
                .values(
                    client_id="",
                    client_secret_encrypted=None,
                    allowed_domain="",
                    enabled=False,
                )
            )

    _reset()
    yield
    _reset()


@pytest.fixture
def fake_provider() -> Iterator[FakeProvider]:
    p = FakeProvider()
    set_test_google_provider(p)
    try:
        yield p
    finally:
        set_test_google_provider(None)


@pytest.fixture
def configured_google(admin_engine: Engine) -> Iterator[dict]:
    """Pre-load tenant_id=1 with valid Google config (no domain lock)."""

    secret = "real-google-secret-DO-NOT-LEAK"
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_google_oidc_config)
            .where(tenant_google_oidc_config.c.tenant_id == 1)
            .values(
                client_id="test-google-client-id",
                client_secret_encrypted=encrypt_secret(secret),
                allowed_domain="",
                enabled=True,
            )
        )
    yield {"client_id": "test-google-client-id", "client_secret": secret}


def _seed_state_cookie(client: TestClient, *, schema: str = "main") -> tuple[str, str]:
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
    client.cookies.set(STATE_COOKIE_NAME, cookie, path="/api/auth/google")
    return state, nonce


class _FakeProviderForCallback(FakeProvider):
    def __init__(self, id_token: str) -> None:  # type: ignore[no-untyped-def]
        super().__init__()
        object.__setattr__(self, "_id_token", id_token)

    def token_exchange(self, **_: Any) -> dict:
        return {"id_token": getattr(self, "_id_token"), "access_token": "redacted"}


# ---------------------------------------------------------------------------
# /status (anonymous probe)
# ---------------------------------------------------------------------------


def test_status_off_when_no_config(client: TestClient) -> None:
    resp = client.get("/api/auth/google/status", params={"tenant": "main"})
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False, "has_config": False}


def test_status_unknown_slug_returns_disabled(client: TestClient) -> None:
    resp = client.get("/api/auth/google/status", params={"tenant": "no-such-tenant"})
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False, "has_config": False}


def test_status_on_when_config_complete(
    client: TestClient, configured_google: dict
) -> None:
    resp = client.get("/api/auth/google/status", params={"tenant": "main"})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True


# ---------------------------------------------------------------------------
# /login redirect
# ---------------------------------------------------------------------------


def test_login_redirects_to_google(
    client: TestClient, fake_provider: FakeProvider, configured_google: dict
) -> None:
    resp = client.get(
        "/api/auth/google/login",
        params={"tenant": "main"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith(fake_provider.authorization_endpoint)

    state_cookie = client.cookies.get(STATE_COOKIE_NAME)
    assert state_cookie, "state cookie should be set"

    qs = parse_qs(urlparse(resp.headers["location"]).query)
    body_b64 = state_cookie.split(".")[0]
    payload = json.loads(base64.urlsafe_b64decode(body_b64 + "=" * (-len(body_b64) % 4)))
    assert qs["state"][0] == payload["state"]
    assert qs["client_id"][0] == "test-google-client-id"
    assert qs["nonce"][0] == payload["nonce"]
    assert "hd" not in qs  # no domain restriction configured


def test_login_includes_hd_when_domain_configured(
    client: TestClient,
    fake_provider: FakeProvider,
    admin_engine: Engine,
    configured_google: dict,
) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_google_oidc_config)
            .where(tenant_google_oidc_config.c.tenant_id == 1)
            .values(allowed_domain="example.com")
        )
    resp = client.get(
        "/api/auth/google/login",
        params={"tenant": "main"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    qs = parse_qs(urlparse(resp.headers["location"]).query)
    assert qs["hd"][0] == "example.com"


def test_login_refuses_when_disabled(client: TestClient) -> None:
    resp = client.get(
        "/api/auth/google/login",
        params={"tenant": "main"},
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_login_404s_unknown_tenant(client: TestClient) -> None:
    resp = client.get(
        "/api/auth/google/login",
        params={"tenant": "no-such"},
        follow_redirects=False,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /callback happy + refusal paths
# ---------------------------------------------------------------------------


def test_callback_happy_path_creates_session(
    client: TestClient, configured_google: dict, admin_user: dict
) -> None:
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        audience="test-google-client-id",
        nonce=nonce,
        email=admin_user["email"],
    )
    set_test_google_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"] == "/"
    assert client.cookies.get("maugood_session"), "session cookie should be set"
    assert client.cookies.get("maugood_tenant") == "main"

    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["email"].lower() == admin_user["email"].lower()


def test_callback_refuses_unknown_email(
    client: TestClient, configured_google: dict, admin_engine: Engine
) -> None:
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        audience="test-google-client-id",
        nonce=nonce,
        email="not-in-maugood@whatever.example",
    )
    set_test_google_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    # Failure renders the branded HTML error page (not raw JSON) with
    # the message and a stable data hook.
    assert resp.status_code == 403
    assert 'data-sso-error="not_registered"' in resp.text
    assert "not registered in Maugood" in resp.text
    assert not client.cookies.get("maugood_session")

    with tenant_context("main"):
        with admin_engine.begin() as conn:
            from sqlalchemy import select  # noqa: PLC0415

            rows = conn.execute(
                select(audit_log.c.action, audit_log.c.after)
                .where(audit_log.c.action == "auth.google.login.failure")
                .order_by(audit_log.c.id.desc())
                .limit(1)
            ).all()
    assert rows
    assert rows[0].after.get("reason") == "no_user_match"


def test_callback_refuses_unverified_email(
    client: TestClient, configured_google: dict, admin_user: dict, admin_engine: Engine
) -> None:
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        audience="test-google-client-id",
        nonce=nonce,
        email=admin_user["email"],
        email_verified=False,
    )
    set_test_google_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 403
    assert 'data-sso-error="email_not_verified"' in resp.text
    assert not client.cookies.get("maugood_session")

    with tenant_context("main"):
        with admin_engine.begin() as conn:
            from sqlalchemy import select  # noqa: PLC0415

            rows = conn.execute(
                select(audit_log.c.after)
                .where(audit_log.c.action == "auth.google.login.failure")
                .order_by(audit_log.c.id.desc())
                .limit(1)
            ).all()
    assert rows and rows[0].after.get("reason") == "email_not_verified"


def test_callback_enforces_allowed_domain(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    # Configure a domain lock that the admin's email does NOT satisfy.
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_google_oidc_config)
            .where(tenant_google_oidc_config.c.tenant_id == 1)
            .values(
                client_id="test-google-client-id",
                client_secret_encrypted=encrypt_secret("s"),
                allowed_domain="locked-domain.example",
                enabled=True,
            )
        )
    state, nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        audience="test-google-client-id",
        nonce=nonce,
        email=admin_user["email"],  # not @locked-domain.example
    )
    set_test_google_provider(_FakeProviderForCallback(id_token=id_token))

    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 403
    assert 'data-sso-error="domain_not_allowed"' in resp.text
    assert not client.cookies.get("maugood_session")


def test_callback_rejects_state_mismatch(
    client: TestClient, configured_google: dict, fake_provider: FakeProvider
) -> None:
    _seed_state_cookie(client)
    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "code", "state": "tampered"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert 'data-sso-error="session_expired"' in resp.text


def test_callback_rejects_missing_state_cookie(
    client: TestClient, fake_provider: FakeProvider
) -> None:
    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "code", "state": "anything"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert 'data-sso-error="session_expired"' in resp.text


def test_callback_rejects_wrong_nonce(
    client: TestClient, configured_google: dict
) -> None:
    state, _real_nonce = _seed_state_cookie(client)
    id_token = _mint_id_token(
        audience="test-google-client-id",
        nonce="completely-different-nonce",
        email="any@maugood.test",
    )
    set_test_google_provider(_FakeProviderForCallback(id_token=id_token))
    resp = client.get(
        "/api/auth/google/callback",
        params={"code": "code", "state": state},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert 'data-sso-error="verify_failed"' in resp.text


# ---------------------------------------------------------------------------
# Config CRUD (Admin)
# ---------------------------------------------------------------------------


def test_get_config_masks_secret(
    client: TestClient, admin_user: dict, configured_google: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    cfg = client.get("/api/auth/google/config")
    assert cfg.status_code == 200
    body = cfg.json()
    assert body["has_secret"] is True
    assert "client_secret" not in body
    assert "client_secret_encrypted" not in body


def test_put_config_enable_requires_client_and_secret(
    client: TestClient, admin_user: dict, fake_provider: FakeProvider
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    bad = client.put(
        "/api/auth/google/config",
        json={"enabled": True},
    )
    assert bad.status_code == 400
    assert "required" in bad.json()["detail"]


def test_put_config_round_trip(
    client: TestClient, admin_user: dict, fake_provider: FakeProvider
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    ok = client.put(
        "/api/auth/google/config",
        json={
            "client_id": "goog-client",
            "client_secret": "very-secret",
            "allowed_domain": "example.com",
            "enabled": True,
        },
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["enabled"] is True
    assert body["client_id"] == "goog-client"
    assert body["allowed_domain"] == "example.com"
    assert body["has_secret"] is True
    assert "client_secret" not in body


def test_put_config_discovery_failure_blocks_enable(
    client: TestClient, admin_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    class _Broken:
        def discover(self):  # type: ignore[no-untyped-def]
            raise RuntimeError("fake discovery failure")

        def jwks(self, _u: str):  # type: ignore[no-untyped-def]
            return []

        def token_exchange(self, **_: Any):  # type: ignore[no-untyped-def]
            return {}

    set_test_google_provider(_Broken())
    bad = client.put(
        "/api/auth/google/config",
        json={"client_id": "x", "client_secret": "y", "enabled": True},
    )
    assert bad.status_code == 400
    assert "discovery validation failed" in bad.json()["detail"]


def test_audit_does_not_carry_plain_secret(
    client: TestClient,
    admin_user: dict,
    fake_provider: FakeProvider,
    admin_engine: Engine,
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    ok = client.put(
        "/api/auth/google/config",
        json={
            "client_id": "goog-client",
            "client_secret": "secret-must-not-appear-in-audit",
            "enabled": True,
        },
    )
    assert ok.status_code == 200

    with admin_engine.begin() as conn:
        from sqlalchemy import select  # noqa: PLC0415

        rows = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(
                audit_log.c.action == "auth.google.config_updated",
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
    cfg = client.get("/api/auth/google/config")
    assert cfg.status_code == 403


def test_delete_config_clears_and_disables(
    client: TestClient, admin_user: dict, configured_google: dict, admin_engine: Engine
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    out = client.delete("/api/auth/google/config")
    assert out.status_code == 200, out.text
    body = out.json()
    assert body["enabled"] is False
    assert body["client_id"] == ""
    assert body["has_secret"] is False
    assert body["allowed_domain"] == ""

    # Anonymous status now reports disabled.
    assert client.get("/api/auth/google/status", params={"tenant": "main"}).json() == {
        "enabled": False,
        "has_config": False,
    }

    with admin_engine.begin() as conn:
        from sqlalchemy import select  # noqa: PLC0415

        rows = conn.execute(
            select(audit_log.c.action)
            .where(audit_log.c.action == "auth.google.config_deleted")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).all()
    assert rows


def test_employee_role_cannot_delete_config(
    client: TestClient, employee_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": employee_user["email"], "password": employee_user["password"]},
    )
    assert resp.status_code == 200
    assert client.delete("/api/auth/google/config").status_code == 403


def test_redirect_uri_override_used_in_login(
    client: TestClient, admin_user: dict, fake_provider: FakeProvider
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200

    custom = "https://sso.acme.test/api/auth/google/callback"
    out = client.put(
        "/api/auth/google/config",
        json={
            "client_id": "goog",
            "client_secret": "s",
            "redirect_uri": custom,
            "enabled": True,
        },
    )
    assert out.status_code == 200, out.text
    assert out.json()["redirect_uri"] == custom

    login = client.get(
        "/api/auth/google/login", params={"tenant": "main"}, follow_redirects=False
    )
    assert login.status_code == 302
    qs = parse_qs(urlparse(login.headers["location"]).query)
    assert qs["redirect_uri"][0] == custom


def test_redirect_uri_invalid_rejected(
    client: TestClient, admin_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200
    bad = client.put(
        "/api/auth/google/config",
        json={"redirect_uri": "https://evil.example/steal"},
    )
    assert bad.status_code == 400
    assert "redirect_uri" in bad.json()["detail"]
