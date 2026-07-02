"""Per-tenant Google Sign-In (OIDC) integration.

The Google sibling of ``maugood/auth/oidc.py`` (Entra). Same OIDC
dance — authorize redirect, code exchange, ID-token validation against
the provider's JWKS, email-match against existing tenant users — but
against Google's **fixed** discovery document rather than a per-tenant
Entra one. The crypto + session helpers (signed state cookie, Fernet
secret encryption, ID-token validation, tenant resolution) are imported
from ``oidc.py`` so there is exactly one audited implementation of each;
this module only adds the Google-specific config table, discovery URL,
network seam, cookie name, and the two extra Google claim checks.

Red lines (identical to the Entra flow, BRD FR-AUTH-006):

* **Never auto-provision users from claims.** A successful Google
  authentication that doesn't match an existing tenant ``users`` row
  by lower-cased email returns 403 with the prescribed message.
* **Never derive roles from Google claims.** Roles live in
  ``user_roles`` and are managed through Maugood's own surfaces.
* **Never log the client secret or the access/ID token.** Audit rows
  carry ``has_secret: bool`` + ``email_attempted`` only.

Two Google-specific guards on top of the shared flow:

* ``email_verified`` must be truthy — an unverified Google email is
  refused even if it happens to match a Maugood user.
* When ``allowed_domain`` is configured, the email's domain must match
  it (a Google Workspace hosted-domain restriction).

Endpoints under ``/api/auth/google`` mirror the Entra router:

* ``GET /status?tenant=<slug>`` — anonymous probe for the LoginPage.
* ``GET /login?tenant=<slug>`` — kicks off the authorize redirect.
* ``GET /callback`` — handles Google's redirect back.
* ``GET /config`` / ``PUT /config`` — Admin config CRUD.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Optional

import httpx
from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Request,
    Response,
)
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    _load_current_user_bundle,
    primary_role,
    require_role,
)
from maugood.auth.oidc import (
    _DiscoveryDoc,
    _resolve_tenant_by_slug,
    _sign_state,
    _verify_state,
    decrypt_secret,
    encrypt_secret,
    validate_id_token,
)
from maugood.auth.sessions import create_session
from maugood.auth.sso_error_page import sso_error_response
from maugood.config import get_settings
from maugood.db import (
    _TENANT_SCHEMA_RE,
    get_engine,
    tenant_context,
    tenant_google_oidc_config,
    users,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/google", tags=["google-oidc"])

# Distinct from the Entra state cookie so the two flows can never read
# each other's blob. Scoped to ``/api/auth/google`` on the response.
STATE_COOKIE_NAME = "maugood_google_state"

# Google's discovery document is global — one URL for every tenant.
_GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"


def _login_error_redirect(code: str) -> HTMLResponse:
    """Render the branded SSO error page for a failed callback.

    The callback is a top-level browser navigation, so raising an
    HTTPException would show raw JSON. Instead we return a self-contained
    styled page (see ``sso_error_page``) with a "Back to sign in" button
    and the friendly message for ``code``."""

    return sso_error_response(code, "google")


# ---------------------------------------------------------------------------
# Discovery + JWKS cache (fixed Google endpoint, its own cache)
# ---------------------------------------------------------------------------


_discovery_cache: Optional[tuple[float, _DiscoveryDoc]] = None
_jwks_cache: dict[str, tuple[float, list[dict]]] = {}
_cache_ttl_seconds = 5 * 60
_cache_lock = threading.Lock()

# Test-only injection point. When set, ``discover`` / ``jwks_for`` /
# ``exchange_code`` use this stub instead of the network. Production
# code never sets this. The stub exposes ``discover()``, ``jwks(uri)``
# and ``token_exchange(**)`` — same shape as the Entra test provider.
_test_google_provider: Optional[Any] = None


def set_test_google_provider(provider: Optional[Any]) -> None:
    """Test hook: install a stub with discover/jwks/token_exchange."""

    global _test_google_provider
    _test_google_provider = provider


def clear_caches() -> None:
    """Drop discovery + JWKS caches (test-only helper)."""

    global _discovery_cache
    with _cache_lock:
        _discovery_cache = None
        _jwks_cache.clear()


def _fetch_discovery() -> _DiscoveryDoc:
    global _discovery_cache
    now = time.time()
    with _cache_lock:
        if _discovery_cache is not None and now - _discovery_cache[0] < _cache_ttl_seconds:
            return _discovery_cache[1]
    with httpx.Client(timeout=8.0) as client:
        resp = client.get(_GOOGLE_DISCOVERY_URL)
    if resp.status_code != 200:
        raise RuntimeError(f"google discovery returned {resp.status_code}")
    doc = resp.json()
    parsed = _DiscoveryDoc(
        issuer=str(doc["issuer"]),
        authorization_endpoint=str(doc["authorization_endpoint"]),
        token_endpoint=str(doc["token_endpoint"]),
        jwks_uri=str(doc["jwks_uri"]),
        raw=dict(doc),
    )
    with _cache_lock:
        _discovery_cache = (now, parsed)
    return parsed


def _fetch_jwks(jwks_uri: str) -> list[dict]:
    now = time.time()
    with _cache_lock:
        cached = _jwks_cache.get(jwks_uri)
        if cached is not None and now - cached[0] < _cache_ttl_seconds:
            return cached[1]
    with httpx.Client(timeout=8.0) as client:
        resp = client.get(jwks_uri)
    if resp.status_code != 200:
        raise RuntimeError(f"jwks fetch returned {resp.status_code}")
    keys = list(resp.json().get("keys", []))
    with _cache_lock:
        _jwks_cache[jwks_uri] = (now, keys)
    return keys


def discover() -> _DiscoveryDoc:
    if _test_google_provider is not None:
        return _test_google_provider.discover()
    return _fetch_discovery()


def jwks_for(jwks_uri: str) -> list[dict]:
    if _test_google_provider is not None:
        return _test_google_provider.jwks(jwks_uri)
    return _fetch_jwks(jwks_uri)


def exchange_code(
    *,
    token_endpoint: str,
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
) -> dict[str, Any]:
    if _test_google_provider is not None:
        return _test_google_provider.token_exchange(
            token_endpoint=token_endpoint,
            code=code,
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
        )
    with httpx.Client(timeout=8.0) as client:
        resp = client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        # Surface only the OAuth ``error`` code — safe + diagnostic.
        # Never log the body/error_description (can echo the client_id).
        oauth_error = ""
        try:
            oauth_error = str(resp.json().get("error", ""))
        except Exception:  # noqa: BLE001
            pass
        logger.warning(
            "google token exchange failed: status=%s error=%s",
            resp.status_code,
            oauth_error or "unknown",
        )
        raise RuntimeError(
            f"token endpoint returned {resp.status_code}"
            + (f" ({oauth_error})" if oauth_error else "")
        )
    return resp.json()


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GoogleConfigRow:
    tenant_id: int
    client_id: str
    has_secret: bool
    allowed_domain: str
    enabled: bool
    redirect_uri: str
    updated_at: datetime


_CFG_COLS = (
    tenant_google_oidc_config.c.tenant_id,
    tenant_google_oidc_config.c.client_id,
    tenant_google_oidc_config.c.client_secret_encrypted,
    tenant_google_oidc_config.c.allowed_domain,
    tenant_google_oidc_config.c.enabled,
    tenant_google_oidc_config.c.redirect_uri,
    tenant_google_oidc_config.c.updated_at,
)


def get_config(conn: Connection, *, tenant_id: int) -> GoogleConfigRow:
    row = conn.execute(
        select(*_CFG_COLS).where(tenant_google_oidc_config.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        # Lazy-create an empty disabled row — mirrors the Entra + branding
        # pattern so the API surface always has something to return.
        conn.execute(insert(tenant_google_oidc_config).values(tenant_id=tenant_id))
        row = conn.execute(
            select(*_CFG_COLS).where(
                tenant_google_oidc_config.c.tenant_id == tenant_id
            )
        ).first()
    assert row is not None
    return GoogleConfigRow(
        tenant_id=int(row.tenant_id),
        client_id=str(row.client_id or ""),
        has_secret=bool(row.client_secret_encrypted),
        allowed_domain=str(row.allowed_domain or ""),
        enabled=bool(row.enabled),
        redirect_uri=str(row.redirect_uri or ""),
        updated_at=row.updated_at,
    )


def _load_secret(conn: Connection, *, tenant_id: int) -> Optional[str]:
    enc = conn.execute(
        select(tenant_google_oidc_config.c.client_secret_encrypted).where(
            tenant_google_oidc_config.c.tenant_id == tenant_id
        )
    ).scalar_one_or_none()
    if not enc:
        return None
    return decrypt_secret(enc)


_CALLBACK_PATH = "/api/auth/google/callback"


def _default_redirect_uri() -> str:
    base = get_settings().oidc_redirect_base_url.rstrip("/")
    return f"{base}{_CALLBACK_PATH}"


def _effective_redirect_uri(cfg: GoogleConfigRow) -> str:
    """The override if the Admin set one, else the env-computed default."""

    return cfg.redirect_uri or _default_redirect_uri()


def _validate_redirect_uri(value: str) -> str:
    """Validate an operator-supplied redirect URI override (empty = default)."""

    from urllib.parse import urlparse  # noqa: PLC0415

    v = value.strip()
    if not v:
        return ""
    parsed = urlparse(v)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(
            status_code=400,
            detail="redirect_uri must be an absolute http(s) URL",
        )
    if not parsed.path.endswith(_CALLBACK_PATH):
        raise HTTPException(
            status_code=400,
            detail=f"redirect_uri must end with {_CALLBACK_PATH}",
        )
    return v


# ---------------------------------------------------------------------------
# Status probe (anonymous)
# ---------------------------------------------------------------------------


class StatusResponse(BaseModel):
    enabled: bool
    has_config: bool


@router.get("/status")
def status_probe(tenant: str) -> StatusResponse:
    """Anonymous: does this tenant have Google sign-in enabled?"""

    resolved = _resolve_tenant_by_slug(tenant)
    if resolved is None:
        return StatusResponse(enabled=False, has_config=False)
    tenant_id, schema = resolved
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            cfg = get_config(conn, tenant_id=tenant_id)
    return StatusResponse(
        enabled=cfg.enabled and cfg.has_secret and bool(cfg.client_id),
        has_config=cfg.has_secret and bool(cfg.client_id),
    )


# ---------------------------------------------------------------------------
# /login — kick off the authorize redirect
# ---------------------------------------------------------------------------


@router.get("/login")
def google_login(tenant: str, request: Request) -> Response:
    """Start the Google OIDC flow for ``tenant`` (the friendly slug)."""

    settings = get_settings()
    resolved = _resolve_tenant_by_slug(tenant)
    if resolved is None:
        raise HTTPException(status_code=404, detail="tenant not found")
    tenant_id, schema = resolved

    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            cfg = get_config(conn, tenant_id=tenant_id)
    if not cfg.enabled:
        raise HTTPException(status_code=400, detail="google sign-in disabled for tenant")
    if not cfg.client_id or not cfg.has_secret:
        raise HTTPException(status_code=400, detail="google sign-in config incomplete")

    try:
        doc = discover()
    except Exception as exc:  # noqa: BLE001
        logger.warning("google discovery failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="google discovery failed")

    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    payload = {
        "tenant_schema": schema,
        "tenant_id": tenant_id,
        "state": state,
        "nonce": nonce,
        "ts": int(time.time()),
    }
    cookie = _sign_state(payload)
    redirect_uri = _effective_redirect_uri(cfg)

    auth_url = (
        f"{doc.authorization_endpoint}"
        f"?client_id={cfg.client_id}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri}"
        f"&scope=openid+email+profile"
        f"&state={state}"
        f"&nonce={nonce}"
    )
    # When a hosted domain is configured, hint it to Google so the
    # account picker pre-filters to that Workspace. The callback still
    # enforces it server-side — this is UX, not the security boundary.
    if cfg.allowed_domain:
        auth_url += f"&hd={cfg.allowed_domain}"

    response = RedirectResponse(url=auth_url, status_code=302)
    response.set_cookie(
        key=STATE_COOKIE_NAME,
        value=cookie,
        max_age=settings.oidc_state_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/api/auth/google",
    )
    return response


# ---------------------------------------------------------------------------
# /callback — handle the redirect from Google
# ---------------------------------------------------------------------------


def _audit_failure(
    *,
    tenant_id: Optional[int],
    schema: Optional[str],
    reason: str,
    email_attempted: Optional[str] = None,
    ip: Optional[str] = None,
) -> None:
    if tenant_id is None or schema is None:
        return
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=tenant_id,
                action="auth.google.login.failure",
                entity_type="google_oidc",
                entity_id=None,
                after={
                    "reason": reason,
                    "email_attempted": email_attempted,
                    "ip": ip,
                },
            )


@router.get("/callback")
def google_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
    maugood_google_state: Optional[str] = Cookie(default=None, alias=STATE_COOKIE_NAME),
) -> Response:
    """Google redirects back here after the user signs in."""

    settings = get_settings()
    ip = request.client.host if request.client else "unknown"

    # 1. Validate the signed state cookie + match the ``state`` param.
    if maugood_google_state is None:
        return _login_error_redirect("session_expired")
    state_payload = _verify_state(maugood_google_state)
    if state_payload is None:
        return _login_error_redirect("session_expired")

    schema = str(state_payload.get("tenant_schema") or "")
    tenant_id = state_payload.get("tenant_id")
    if not isinstance(tenant_id, int) or not _TENANT_SCHEMA_RE.match(schema):
        return _login_error_redirect("session_expired")

    if error:
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason=f"google_error:{error}",
            ip=ip,
        )
        return _login_error_redirect("provider_error")
    if not code or not state:
        return _login_error_redirect("session_expired")
    if state != state_payload.get("state"):
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="state_mismatch", ip=ip
        )
        return _login_error_redirect("session_expired")

    # 2. Load the tenant's Google config + secret.
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            cfg = get_config(conn, tenant_id=tenant_id)
            client_secret = _load_secret(conn, tenant_id=tenant_id)
    if not cfg.enabled or not cfg.client_id or not client_secret:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="config_disabled", ip=ip
        )
        return _login_error_redirect("not_configured")

    # 3. Discovery + token exchange.
    try:
        doc = discover()
        token = exchange_code(
            token_endpoint=doc.token_endpoint,
            code=code,
            client_id=cfg.client_id,
            client_secret=client_secret,
            redirect_uri=_effective_redirect_uri(cfg),
        )
    except Exception as exc:  # noqa: BLE001
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason=f"token_exchange_failed:{type(exc).__name__}",
            ip=ip,
        )
        return _login_error_redirect("verify_failed")

    id_token = token.get("id_token")
    if not id_token:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="no_id_token", ip=ip
        )
        return _login_error_redirect("verify_failed")

    # 4. Validate the ID token (signature + iss/aud/nonce + exp/nbf).
    try:
        keys = jwks_for(doc.jwks_uri)
        claims = validate_id_token(
            id_token=id_token,
            issuer=doc.issuer,
            audience=cfg.client_id,
            nonce=str(state_payload.get("nonce") or ""),
            jwks_keys=keys,
        )
    except Exception as exc:  # noqa: BLE001
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason=f"id_token_invalid:{type(exc).__name__}",
            ip=ip,
        )
        return _login_error_redirect("verify_failed")

    # 5. Google-specific claim checks: email present + verified, and
    #    (optionally) the configured hosted domain.
    email = str(claims.get("email") or "").strip().lower()
    if not email:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="no_email_claim", ip=ip
        )
        return _login_error_redirect("verify_failed")

    if not _claim_is_true(claims.get("email_verified")):
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason="email_not_verified",
            email_attempted=email,
            ip=ip,
        )
        return _login_error_redirect("email_not_verified")

    if cfg.allowed_domain:
        want = cfg.allowed_domain.strip().lower()
        email_domain = email.rsplit("@", 1)[-1]
        hd_claim = str(claims.get("hd") or "").strip().lower()
        if email_domain != want and hd_claim != want:
            _audit_failure(
                tenant_id=tenant_id,
                schema=schema,
                reason="domain_not_allowed",
                email_attempted=email,
                ip=ip,
            )
            return _login_error_redirect("domain_not_allowed")

    # 6. Email match — no auto-provision (the red line).
    with tenant_context(schema):
        with engine.begin() as conn:
            user_row = conn.execute(
                select(
                    users.c.id,
                    users.c.tenant_id,
                    users.c.email,
                    users.c.full_name,
                    users.c.is_active,
                ).where(
                    users.c.tenant_id == tenant_id,
                    users.c.email == email,
                )
            ).first()
    if user_row is None or not user_row.is_active:
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason="no_user_match",
            email_attempted=email,
            ip=ip,
        )
        return _login_error_redirect("not_registered")

    # 7. Create a Maugood session — identical shape to local + Entra login.
    with tenant_context(schema):
        with engine.begin() as conn:
            initial_bundle = _load_current_user_bundle(
                conn, user_id=int(user_row.id), tenant_id=tenant_id
            )
            initial_active = primary_role(
                initial_bundle.roles if initial_bundle is not None else ()
            )
            session = create_session(
                conn,
                tenant_id=tenant_id,
                user_id=int(user_row.id),
                idle_minutes=settings.session_idle_minutes,
                tenant_schema=schema,
                active_role=initial_active,
            )
            write_audit(
                conn,
                tenant_id=tenant_id,
                actor_user_id=int(user_row.id),
                action="auth.google.login.success",
                entity_type="user",
                entity_id=str(user_row.id),
                after={
                    "ip": ip,
                    "session_id": session.id,
                    "tenant_schema": schema,
                    "email": email,
                },
            )

    response = RedirectResponse(url="/", status_code=302)
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    response.set_cookie(
        key="maugood_tenant",
        value=schema,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    response.delete_cookie(key=STATE_COOKIE_NAME, path="/api/auth/google")
    return response


def _claim_is_true(value: Any) -> bool:
    """Google encodes ``email_verified`` as a JSON bool or a string."""

    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


# ---------------------------------------------------------------------------
# Config CRUD (Admin)
# ---------------------------------------------------------------------------


class ConfigResponse(BaseModel):
    tenant_id: int
    client_id: str
    has_secret: bool
    allowed_domain: str
    enabled: bool
    updated_at: str
    # Effective redirect URI (override if set, else env-computed default).
    redirect_uri: str
    # The env-computed default, so the UI can offer "reset to default".
    redirect_uri_default: str


class ConfigPatchRequest(BaseModel):
    client_id: Optional[str] = Field(default=None, max_length=200)
    # ``client_secret`` is write-only. Empty / None means "leave the
    # stored secret untouched"; a string replaces it.
    client_secret: Optional[str] = Field(default=None, max_length=2048)
    allowed_domain: Optional[str] = Field(default=None, max_length=253)
    enabled: Optional[bool] = None
    # Optional redirect-URI override. Empty string resets to the default.
    redirect_uri: Optional[str] = Field(default=None, max_length=500)


def _to_response(cfg: GoogleConfigRow) -> ConfigResponse:
    return ConfigResponse(
        tenant_id=cfg.tenant_id,
        client_id=cfg.client_id,
        has_secret=cfg.has_secret,
        allowed_domain=cfg.allowed_domain,
        enabled=cfg.enabled,
        updated_at=cfg.updated_at.isoformat(),
        redirect_uri=_effective_redirect_uri(cfg),
        redirect_uri_default=_default_redirect_uri(),
    )


@router.get("/config")
def get_my_config(
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
) -> ConfigResponse:
    engine = get_engine()
    with engine.begin() as conn:
        cfg = get_config(conn, tenant_id=user.tenant_id)
    return _to_response(cfg)


@router.put("/config")
def put_my_config(
    payload: ConfigPatchRequest,
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
) -> ConfigResponse:
    engine = get_engine()
    with engine.begin() as conn:
        before = get_config(conn, tenant_id=user.tenant_id)

    new_enabled = payload.enabled if payload.enabled is not None else before.enabled

    # Validate Google reachability before flipping ``enabled`` on. The
    # discovery URL is fixed, so this just confirms Google is reachable
    # and the config is otherwise complete — parity with the Entra
    # "validate before persist" rule. Idempotent re-saves don't re-ping.
    will_validate = new_enabled and not before.enabled
    if will_validate:
        new_client = (
            payload.client_id if payload.client_id is not None else before.client_id
        )
        new_has_secret = (
            bool(payload.client_secret) or before.has_secret
        )
        if not new_client or not new_has_secret:
            raise HTTPException(
                status_code=400,
                detail="client_id and client_secret are required to enable google sign-in",
            )
        try:
            discover()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"google discovery validation failed: {type(exc).__name__}",
            )

    values: dict[str, Any] = {"updated_at": datetime.now(tz=timezone.utc)}
    if payload.client_id is not None:
        values["client_id"] = payload.client_id
    if payload.client_secret is not None and payload.client_secret != "":
        values["client_secret_encrypted"] = encrypt_secret(payload.client_secret)
    if payload.allowed_domain is not None:
        values["allowed_domain"] = payload.allowed_domain.strip()
    if payload.enabled is not None:
        values["enabled"] = payload.enabled
    if payload.redirect_uri is not None:
        validated = _validate_redirect_uri(payload.redirect_uri)
        values["redirect_uri"] = (
            "" if validated == _default_redirect_uri() else validated
        )

    with engine.begin() as conn:
        conn.execute(
            update(tenant_google_oidc_config)
            .where(tenant_google_oidc_config.c.tenant_id == user.tenant_id)
            .values(**values)
        )
        after = get_config(conn, tenant_id=user.tenant_id)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.google.config_updated",
            entity_type="google_oidc",
            entity_id=str(user.tenant_id),
            before={
                "client_id": before.client_id,
                "has_secret": before.has_secret,
                "allowed_domain": before.allowed_domain,
                "enabled": before.enabled,
            },
            after={
                "client_id": after.client_id,
                "has_secret": after.has_secret,
                "allowed_domain": after.allowed_domain,
                "enabled": after.enabled,
                # Booleans only — the secret never appears in the audit row.
                "secret_rotated": payload.client_secret is not None
                and payload.client_secret != "",
            },
        )
    return _to_response(after)


@router.delete("/config")
def delete_my_config(
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
) -> ConfigResponse:
    """Clear the tenant's Google config — client id/secret wiped, disabled."""

    engine = get_engine()
    with engine.begin() as conn:
        before = get_config(conn, tenant_id=user.tenant_id)
        conn.execute(
            update(tenant_google_oidc_config)
            .where(tenant_google_oidc_config.c.tenant_id == user.tenant_id)
            .values(
                client_id="",
                client_secret_encrypted=None,
                allowed_domain="",
                enabled=False,
                redirect_uri="",
                updated_at=datetime.now(tz=timezone.utc),
            )
        )
        after = get_config(conn, tenant_id=user.tenant_id)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.google.config_deleted",
            entity_type="google_oidc",
            entity_id=str(user.tenant_id),
            before={
                "client_id": before.client_id,
                "has_secret": before.has_secret,
                "allowed_domain": before.allowed_domain,
                "enabled": before.enabled,
            },
            after={"cleared": True},
        )
    return _to_response(after)
