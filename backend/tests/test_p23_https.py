"""P23 — HTTPS + reverse-proxy hardening.

Covers the four pieces of the prompt:

  * production startup refuses to boot with unsafe config
    (``ProductionConfigError``);
  * the HTTPS gate returns 421 on plain HTTP in production but
    leaves dev untouched;
  * ``X-Forwarded-Proto: https`` lets a TLS-fronted request through
    even though the inner hop is HTTP;
  * security headers (HSTS, X-Frame-Options, etc.) ship on every
    response when env != dev.

Each test builds its own ``FastAPI`` app via ``create_app()`` after
patching the env, so no test leaks a non-dev settings cache into
the wider suite.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hadir.config import Settings
from hadir.main import create_app
from hadir.security import (
    HttpsEnforceMiddleware,
    ProductionConfigError,
    SecurityHeadersMiddleware,
    check_production_config,
)


# Recipe: minimum env vars to make ``Settings()`` look like a
# valid production config. Tests mutate one field at a time to
# assert the corresponding failure.
_OK_PROD_ENV: dict[str, str] = {
    "HADIR_ENV": "production",
    "HADIR_SESSION_COOKIE_SECURE": "true",
    "HADIR_BEHIND_PROXY": "true",
    "HADIR_ALLOWED_ORIGINS": "https://hadir.example.com",
    "HADIR_OIDC_REDIRECT_BASE_URL": "https://hadir.example.com",
    "HADIR_SESSION_SECRET": "rotate-me-in-prod-please",
    "HADIR_FERNET_KEY": "rotate-me-in-prod-please-fernet",
    "HADIR_AUTH_FERNET_KEY": "rotate-me-in-prod-please-auth",
    "HADIR_REPORT_SIGNED_URL_SECRET": "rotate-me-in-prod-please-rep",
}


@pytest.fixture
def prod_env(monkeypatch):
    """Set the env vars that make ``Settings()`` look like a
    valid production configuration. The fixture itself yields a
    factory the test calls to override individual fields.
    """

    for k, v in _OK_PROD_ENV.items():
        monkeypatch.setenv(k, v)

    def _settings(**override: str) -> Settings:
        for k, v in override.items():
            monkeypatch.setenv(k, v)
        return Settings()

    return _settings


# --- production config gate -------------------------------------


def test_production_config_passes_when_everything_is_set(prod_env) -> None:
    check_production_config(prod_env())


def test_production_config_skips_when_env_is_dev(prod_env) -> None:
    # ``check_production_config`` is a no-op outside production —
    # otherwise dev would have to mirror prod env vars.
    check_production_config(prod_env(HADIR_ENV="dev"))


def test_production_config_requires_secure_cookie(prod_env) -> None:
    with pytest.raises(ProductionConfigError) as exc:
        check_production_config(prod_env(HADIR_SESSION_COOKIE_SECURE="false"))
    assert "session_cookie_secure" in str(exc.value).lower() or "cookie" in str(exc.value).lower()


def test_production_config_requires_behind_proxy(prod_env) -> None:
    with pytest.raises(ProductionConfigError) as exc:
        check_production_config(prod_env(HADIR_BEHIND_PROXY="false"))
    assert "behind_proxy" in str(exc.value).lower() or "x-forwarded-proto" in str(exc.value).lower()


def test_production_config_requires_allowed_origins(prod_env) -> None:
    with pytest.raises(ProductionConfigError) as exc:
        check_production_config(prod_env(HADIR_ALLOWED_ORIGINS=""))
    assert "allowed_origins" in str(exc.value).lower()


def test_production_config_rejects_http_oidc_base(prod_env) -> None:
    with pytest.raises(ProductionConfigError) as exc:
        check_production_config(
            prod_env(HADIR_OIDC_REDIRECT_BASE_URL="http://hadir.example.com")
        )
    assert "https" in str(exc.value).lower()


@pytest.mark.parametrize(
    "env_var",
    [
        "HADIR_SESSION_SECRET",
        "HADIR_FERNET_KEY",
        "HADIR_AUTH_FERNET_KEY",
        "HADIR_REPORT_SIGNED_URL_SECRET",
    ],
)
def test_production_config_rejects_placeholder_secrets(prod_env, env_var: str) -> None:
    placeholders = {
        "HADIR_SESSION_SECRET": "dev-session-secret-change-me",
        "HADIR_FERNET_KEY": "dev-fernet-key-change-me",
        "HADIR_AUTH_FERNET_KEY": "dev-auth-fernet-key-change-me",
        "HADIR_REPORT_SIGNED_URL_SECRET": "dev-report-signed-url-secret-change-me",
    }
    with pytest.raises(ProductionConfigError):
        check_production_config(prod_env(**{env_var: placeholders[env_var]}))


# --- HTTPS gate (middleware) ------------------------------------


def _https_gate_app() -> FastAPI:
    app = FastAPI()

    # Outermost is ProxyHeadersMiddleware so the gate sees the
    # client-supplied scheme. ``trusted_hosts="*"`` mirrors the
    # production default (forwarded headers come only from nginx
    # over the private docker network).
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    app.add_middleware(HttpsEnforceMiddleware)
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

    @app.get("/api/things")
    def things() -> dict[str, str]:
        return {"ok": "yes"}

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def test_https_gate_rejects_plain_http() -> None:
    client = TestClient(_https_gate_app())
    resp = client.get("/api/things")
    assert resp.status_code == 421
    assert "https" in resp.json()["detail"].lower()


def test_https_gate_accepts_x_forwarded_proto_https() -> None:
    client = TestClient(_https_gate_app())
    resp = client.get(
        "/api/things",
        headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": "10.0.0.1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": "yes"}


def test_https_gate_exempts_health_check() -> None:
    # Health probe must answer over plain HTTP — internal LBs
    # don't always speak TLS to a single backend.
    client = TestClient(_https_gate_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200


def test_https_gate_exempts_metrics_for_prometheus() -> None:
    """P28 regression: Prometheus scrapes ``/metrics`` over the
    private docker network in plain HTTP. The HTTPS gate must
    let it through, otherwise the dashboards go empty in
    production."""

    app = FastAPI()
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    app.add_middleware(HttpsEnforceMiddleware)
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

    @app.get("/metrics")
    def metrics() -> dict[str, str]:
        return {"hadir_test_metric": "1"}

    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert resp.json() == {"hadir_test_metric": "1"}


# --- security headers ------------------------------------------


def _security_headers_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware, hsts_max_age=600)

    @app.get("/api/things")
    def things() -> dict[str, str]:
        return {"ok": "yes"}

    return app


def test_security_headers_present_on_every_response() -> None:
    client = TestClient(_security_headers_app())
    resp = client.get("/api/things")
    assert resp.status_code == 200
    h = resp.headers
    assert "max-age=600" in h["strict-transport-security"]
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert "referrer-policy" in h
    assert "permissions-policy" in h


# --- end-to-end via create_app() --------------------------------


def test_create_app_in_production_mode_boots_only_when_safe(prod_env) -> None:
    """Smoke-test the full app factory under production env."""

    # Calls ``create_app()`` directly — no module reload, so the
    # module-level ``app = create_app()`` line never runs again
    # under production env. ``prod_env`` is the fixture that sets
    # the safe-config env vars via monkeypatch.
    prod_env()  # arm env vars
    app = create_app()
    assert isinstance(app, FastAPI)


def test_create_app_in_production_refuses_unsafe(prod_env) -> None:
    # Tear down the cookie-secure flag — the rest of the safe env
    # is in place. ``check_production_config`` should surface the
    # missing piece by raising.
    prod_env(HADIR_SESSION_COOKIE_SECURE="false")
    with pytest.raises(ProductionConfigError):
        create_app()
