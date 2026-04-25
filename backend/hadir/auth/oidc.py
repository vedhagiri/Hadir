"""Per-tenant Entra ID OIDC integration (v1.0 P6).

The whole flow lives in this one module so the surface is easy to
audit. Microsoft-specific only in the discovery URL template — the
rest is plain OIDC code that would work against any compliant IdP.

Red lines (BRD FR-AUTH-006 + the prompt's own list):

* **Never auto-provision users from claims.** A successful Entra
  authentication that doesn't match an existing tenant ``users``
  row by lower-cased email returns 403 with the prescribed message.
* **Never derive roles from Entra groups.** Roles live in
  ``user_roles`` and are managed through Hadir's own surfaces.
* **Never log the client secret or the access token.** Audit rows
  carry ``has_secret: bool`` and ``email_attempted`` only.

Two endpoints make up the user-facing flow:

* ``GET /api/auth/oidc/login`` — kicks off the authorize redirect.
  Generates state + nonce, signs them into a short-lived cookie,
  and 302s to Entra.
* ``GET /api/auth/oidc/callback`` — handles Entra's redirect back.
  Verifies the signed state cookie, exchanges the code for a token,
  validates the ID token's signature against the tenant's JWKS
  (cached), reads the ``email`` (or ``preferred_username``) claim,
  and either creates a Hadir session or refuses.

Three configuration endpoints (Admin only) under the same router:

* ``GET /api/auth/oidc/config`` — current config; secret masked.
* ``PUT /api/auth/oidc/config`` — partial update; pings Entra's
  discovery endpoint before persisting and refuses if it fails.
* ``GET /api/auth/oidc/status?tenant=<slug>`` — anonymous probe
  the LoginPage uses to decide whether to render "Sign in with
  Microsoft" as the primary CTA.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Optional

import httpx
from authlib.jose import JsonWebKey, jwt
from authlib.jose.errors import JoseError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import (
    CurrentUser,
    _load_current_user_bundle,
    primary_role,
    require_role,
)
from hadir.auth.sessions import create_session
from hadir.config import get_settings
from hadir.db import (
    _TENANT_SCHEMA_RE,
    get_engine,
    tenant_context,
    tenant_oidc_config,
    tenants,
    users,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/oidc", tags=["oidc"])

# Cookie name for the signed state+nonce blob between /login and
# /callback. Distinct from session cookies so it's obviously
# transient — cleared the moment the callback succeeds or fails.
STATE_COOKIE_NAME = "hadir_oidc_state"

# How Microsoft's discovery URL is templated. The Entra tenant id can
# be a GUID or a verified domain; we accept either.
_ENTRA_DISCOVERY_URL = (
    "https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration"
)


# ---------------------------------------------------------------------------
# Settings + Fernet helpers
# ---------------------------------------------------------------------------


def _auth_fernet() -> Fernet:
    settings = get_settings()
    key = settings.auth_fernet_key.encode()
    return Fernet(key)


def encrypt_secret(plain: str) -> str:
    """Fernet-encrypt the OIDC client secret for storage at rest."""

    return _auth_fernet().encrypt(plain.encode()).decode()


def decrypt_secret(encrypted: str) -> str:
    try:
        return _auth_fernet().decrypt(encrypted.encode()).decode()
    except InvalidToken as exc:  # noqa: BLE001
        raise RuntimeError("client_secret decrypt failed (key rotated?)") from exc


# ---------------------------------------------------------------------------
# Discovery + JWKS cache
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _DiscoveryDoc:
    """Subset of the OIDC discovery document we actually need."""

    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    raw: dict[str, Any]


# In-process cache. Per (entra_tenant_id) — the discovery doc is global
# to a Microsoft tenant, not to a Hadir tenant, so several Hadir tenants
# pointing at the same Entra tenant share one cache entry.
_discovery_cache: dict[str, tuple[float, _DiscoveryDoc]] = {}
_jwks_cache: dict[str, tuple[float, list[dict]]] = {}
_cache_ttl_seconds = 5 * 60
_cache_lock = threading.Lock()


def _fetch_discovery(entra_tenant_id: str) -> _DiscoveryDoc:
    """Fetch + cache the discovery doc for an Entra tenant."""

    now = time.time()
    with _cache_lock:
        cached = _discovery_cache.get(entra_tenant_id)
        if cached is not None and now - cached[0] < _cache_ttl_seconds:
            return cached[1]
    url = _ENTRA_DISCOVERY_URL.format(tenant_id=entra_tenant_id)
    with httpx.Client(timeout=8.0) as client:
        resp = client.get(url)
    if resp.status_code != 200:
        raise RuntimeError(
            f"discovery returned {resp.status_code} for entra_tenant_id "
            f"{entra_tenant_id!r}"
        )
    doc = resp.json()
    parsed = _DiscoveryDoc(
        issuer=str(doc["issuer"]),
        authorization_endpoint=str(doc["authorization_endpoint"]),
        token_endpoint=str(doc["token_endpoint"]),
        jwks_uri=str(doc["jwks_uri"]),
        raw=dict(doc),
    )
    with _cache_lock:
        _discovery_cache[entra_tenant_id] = (now, parsed)
    return parsed


def _fetch_jwks(jwks_uri: str) -> list[dict]:
    """Fetch + cache the JWKS keys for a given URI."""

    now = time.time()
    with _cache_lock:
        cached = _jwks_cache.get(jwks_uri)
        if cached is not None and now - cached[0] < _cache_ttl_seconds:
            return cached[1]
    with httpx.Client(timeout=8.0) as client:
        resp = client.get(jwks_uri)
    if resp.status_code != 200:
        raise RuntimeError(f"jwks fetch returned {resp.status_code}")
    body = resp.json()
    keys = list(body.get("keys", []))
    with _cache_lock:
        _jwks_cache[jwks_uri] = (now, keys)
    return keys


def clear_caches() -> None:
    """Drop discovery + JWKS caches (test-only helper)."""

    with _cache_lock:
        _discovery_cache.clear()
        _jwks_cache.clear()


# Test-only injection point. When set, ``_fetch_discovery`` and
# ``_fetch_jwks`` use this stub instead of going to the network.
# Production code never sets this.
_test_oidc_provider: Optional[Any] = None


def set_test_oidc_provider(provider: Optional[Any]) -> None:
    """Test hook: install a stub with ``discover()`` + ``jwks()`` + ``token_exchange()`` methods."""

    global _test_oidc_provider
    _test_oidc_provider = provider


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OidcConfigRow:
    tenant_id: int
    entra_tenant_id: str
    client_id: str
    has_secret: bool
    enabled: bool
    updated_at: datetime


def get_config(conn: Connection, *, tenant_id: int) -> OidcConfigRow:
    row = conn.execute(
        select(
            tenant_oidc_config.c.tenant_id,
            tenant_oidc_config.c.entra_tenant_id,
            tenant_oidc_config.c.client_id,
            tenant_oidc_config.c.client_secret_encrypted,
            tenant_oidc_config.c.enabled,
            tenant_oidc_config.c.updated_at,
        ).where(tenant_oidc_config.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        # Lazy-create an empty disabled row so the API surface always
        # has something to return. Mirrors the branding pattern.
        conn.execute(insert(tenant_oidc_config).values(tenant_id=tenant_id))
        row = conn.execute(
            select(
                tenant_oidc_config.c.tenant_id,
                tenant_oidc_config.c.entra_tenant_id,
                tenant_oidc_config.c.client_id,
                tenant_oidc_config.c.client_secret_encrypted,
                tenant_oidc_config.c.enabled,
                tenant_oidc_config.c.updated_at,
            ).where(tenant_oidc_config.c.tenant_id == tenant_id)
        ).first()
    assert row is not None
    return OidcConfigRow(
        tenant_id=int(row.tenant_id),
        entra_tenant_id=str(row.entra_tenant_id or ""),
        client_id=str(row.client_id or ""),
        has_secret=bool(row.client_secret_encrypted),
        enabled=bool(row.enabled),
        updated_at=row.updated_at,
    )


def _load_secret(conn: Connection, *, tenant_id: int) -> Optional[str]:
    enc = conn.execute(
        select(tenant_oidc_config.c.client_secret_encrypted).where(
            tenant_oidc_config.c.tenant_id == tenant_id
        )
    ).scalar_one_or_none()
    if not enc:
        return None
    return decrypt_secret(enc)


# ---------------------------------------------------------------------------
# Signed state cookie (HMAC, no library)
# ---------------------------------------------------------------------------


def _state_signing_key() -> bytes:
    """Derive the HMAC key from the auth Fernet key.

    Reusing the Fernet key as an HMAC seed is fine because we only
    care about authenticity here, not reversibility. ``sha256`` of the
    raw Fernet key gives us a stable 32-byte HMAC key.
    """

    raw = get_settings().auth_fernet_key.encode()
    return hashlib.sha256(raw).digest()


def _sign_state(payload: dict[str, Any]) -> str:
    """Return ``base64(json).base64(hmac)`` — short and URL-safe."""

    body = json.dumps(payload, separators=(",", ":")).encode()
    body_b64 = base64.urlsafe_b64encode(body).rstrip(b"=")
    sig = hmac.new(_state_signing_key(), body_b64, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=")
    return (body_b64 + b"." + sig_b64).decode()


def _verify_state(token: str) -> Optional[dict[str, Any]]:
    """Return the decoded payload or None on signature/expiry failure."""

    try:
        body_b64, sig_b64 = token.encode().split(b".", 1)
    except ValueError:
        return None
    expected = hmac.new(_state_signing_key(), body_b64, hashlib.sha256).digest()
    actual_sig = base64.urlsafe_b64decode(sig_b64 + b"=" * (-len(sig_b64) % 4))
    if not hmac.compare_digest(expected, actual_sig):
        return None
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(body_b64 + b"=" * (-len(body_b64) % 4))
        )
    except (ValueError, json.JSONDecodeError):
        return None
    ts = payload.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    if time.time() - float(ts) > get_settings().oidc_state_ttl_seconds:
        return None
    return payload


# ---------------------------------------------------------------------------
# Discovery + token exchange (testable seam)
# ---------------------------------------------------------------------------


def discover(entra_tenant_id: str) -> _DiscoveryDoc:
    """Fetch the discovery doc, with a test-injection seam."""

    if _test_oidc_provider is not None:
        return _test_oidc_provider.discover(entra_tenant_id)
    return _fetch_discovery(entra_tenant_id)


def jwks_for(jwks_uri: str) -> list[dict]:
    if _test_oidc_provider is not None:
        return _test_oidc_provider.jwks(jwks_uri)
    return _fetch_jwks(jwks_uri)


def exchange_code(
    *,
    token_endpoint: str,
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
) -> dict[str, Any]:
    if _test_oidc_provider is not None:
        return _test_oidc_provider.token_exchange(
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
        # Don't include the response body in the exception message —
        # Microsoft's error blobs sometimes echo the client_id which
        # we don't want in logs even though it's not technically
        # sensitive.
        raise RuntimeError(f"token endpoint returned {resp.status_code}")
    return resp.json()


def validate_id_token(
    *,
    id_token: str,
    issuer: str,
    audience: str,
    nonce: str,
    jwks_keys: list[dict],
) -> dict[str, Any]:
    """Verify signature + standard claims, return the claim dict."""

    settings = get_settings()
    skew = settings.oidc_clock_skew_seconds
    keys = JsonWebKey.import_key_set({"keys": jwks_keys})
    try:
        claims = jwt.decode(
            id_token,
            keys,
            claims_options={
                "iss": {"essential": True, "value": issuer},
                "aud": {"essential": True, "value": audience},
                "nonce": {"essential": True, "value": nonce},
            },
        )
        # Validate exp/nbf with a small skew tolerance.
        claims.validate(leeway=skew)
    except JoseError as exc:
        raise RuntimeError(f"id_token validation failed: {type(exc).__name__}") from exc
    return dict(claims)


# ---------------------------------------------------------------------------
# Helpers — tenant resolution + redirect URI
# ---------------------------------------------------------------------------


def _resolve_tenant_by_slug(slug: str) -> Optional[tuple[int, str]]:
    if not _TENANT_SCHEMA_RE.match(slug):
        return None
    engine = get_engine()
    with tenant_context("public"):
        with engine.begin() as conn:
            row = conn.execute(
                select(
                    tenants.c.id,
                    tenants.c.schema_name,
                    tenants.c.status,
                ).where(tenants.c.schema_name == slug)
            ).first()
    if row is None or str(row.status) == "suspended":
        return None
    return int(row.id), str(row.schema_name)


def _redirect_uri() -> str:
    base = get_settings().oidc_redirect_base_url.rstrip("/")
    return f"{base}/api/auth/oidc/callback"


# ---------------------------------------------------------------------------
# Status probe (anonymous)
# ---------------------------------------------------------------------------


class StatusResponse(BaseModel):
    enabled: bool
    has_config: bool


@router.get("/status")
def status_probe(tenant: str) -> StatusResponse:
    """Anonymous: does this tenant have OIDC enabled? Used by LoginPage."""

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
def oidc_login(tenant: str, request: Request) -> Response:
    """Start the OIDC flow for ``tenant`` (the schema slug)."""

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
        raise HTTPException(status_code=400, detail="oidc disabled for tenant")
    if not cfg.client_id or not cfg.entra_tenant_id or not cfg.has_secret:
        raise HTTPException(
            status_code=400, detail="oidc config incomplete"
        )

    try:
        doc = discover(cfg.entra_tenant_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("oidc discovery failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="entra discovery failed")

    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    payload = {
        "tenant_slug": schema,
        "tenant_id": tenant_id,
        "state": state,
        "nonce": nonce,
        "ts": int(time.time()),
    }
    cookie = _sign_state(payload)
    redirect_uri = _redirect_uri()

    auth_url = (
        f"{doc.authorization_endpoint}"
        f"?client_id={cfg.client_id}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri}"
        f"&response_mode=query"
        f"&scope=openid+email+profile"
        f"&state={state}"
        f"&nonce={nonce}"
    )

    response = RedirectResponse(url=auth_url, status_code=302)
    response.set_cookie(
        key=STATE_COOKIE_NAME,
        value=cookie,
        max_age=settings.oidc_state_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/api/auth/oidc",
    )
    return response


# ---------------------------------------------------------------------------
# /callback — handle the redirect from Entra
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
        # Without a known tenant there's no audit_log to write to.
        # The router-level logger.warning above is the only record.
        return
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=tenant_id,
                action="auth.oidc.login.failure",
                entity_type="oidc",
                entity_id=None,
                after={
                    "reason": reason,
                    "email_attempted": email_attempted,
                    "ip": ip,
                },
            )


@router.get("/callback")
def oidc_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
    hadir_oidc_state: Optional[str] = Cookie(default=None, alias=STATE_COOKIE_NAME),
) -> Response:
    """Entra redirects back here after the user signs in."""

    settings = get_settings()
    ip = request.client.host if request.client else "unknown"

    # 1. Validate the signed state cookie + match the ``state`` param.
    if hadir_oidc_state is None:
        raise HTTPException(status_code=400, detail="missing oidc state cookie")
    state_payload = _verify_state(hadir_oidc_state)
    if state_payload is None:
        raise HTTPException(status_code=400, detail="invalid or expired oidc state")

    schema = str(state_payload.get("tenant_slug") or "")
    tenant_id = state_payload.get("tenant_id")
    if not isinstance(tenant_id, int) or not _TENANT_SCHEMA_RE.match(schema):
        raise HTTPException(status_code=400, detail="malformed oidc state")

    if error:
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason=f"entra_error:{error}",
            ip=ip,
        )
        raise HTTPException(
            status_code=400,
            detail=f"entra returned error: {error}",
        )
    if not code or not state:
        raise HTTPException(status_code=400, detail="missing oidc code/state")
    if state != state_payload.get("state"):
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="state_mismatch", ip=ip
        )
        raise HTTPException(status_code=400, detail="oidc state mismatch")

    # 2. Load the tenant's OIDC config + secret.
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            cfg = get_config(conn, tenant_id=tenant_id)
            client_secret = _load_secret(conn, tenant_id=tenant_id)
    if not cfg.enabled or not cfg.client_id or not client_secret:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="config_disabled", ip=ip
        )
        raise HTTPException(status_code=400, detail="oidc disabled or misconfigured")

    # 3. Discovery + token exchange.
    try:
        doc = discover(cfg.entra_tenant_id)
        token = exchange_code(
            token_endpoint=doc.token_endpoint,
            code=code,
            client_id=cfg.client_id,
            client_secret=client_secret,
            redirect_uri=_redirect_uri(),
        )
    except Exception as exc:  # noqa: BLE001
        _audit_failure(
            tenant_id=tenant_id,
            schema=schema,
            reason=f"token_exchange_failed:{type(exc).__name__}",
            ip=ip,
        )
        raise HTTPException(status_code=502, detail="oidc token exchange failed")

    id_token = token.get("id_token")
    if not id_token:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="no_id_token", ip=ip
        )
        raise HTTPException(status_code=502, detail="entra returned no id_token")

    # 4. Validate the ID token.
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
        raise HTTPException(status_code=400, detail="invalid id_token")

    # 5. Email match. We accept ``email`` first, then fall back to
    #    ``preferred_username`` (Entra populates that with the user's
    #    UPN when ``email`` isn't in the token — common for orgs that
    #    haven't enabled the optional ``email`` claim).
    email = (
        claims.get("email")
        or claims.get("preferred_username")
        or ""
    )
    email = str(email).strip().lower()
    if not email:
        _audit_failure(
            tenant_id=tenant_id, schema=schema, reason="no_email_claim", ip=ip
        )
        raise HTTPException(status_code=403, detail="entra response missing email")

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
        # The exact prescribed message — operator-actionable.
        raise HTTPException(
            status_code=403,
            detail=(
                "Your Microsoft account is not registered in Hadir. "
                "Contact your administrator."
            ),
        )

    # 6. Create a Hadir session — identical shape to local login.
    with tenant_context(schema):
        with engine.begin() as conn:
            # P7: seed ``active_role`` with the user's highest role,
            # same default as the local-login path.
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
                action="auth.oidc.login.success",
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
        key="hadir_tenant",
        value=schema,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    # State cookie has served its purpose.
    response.delete_cookie(key=STATE_COOKIE_NAME, path="/api/auth/oidc")
    return response


# ---------------------------------------------------------------------------
# Config CRUD (Admin)
# ---------------------------------------------------------------------------


class ConfigResponse(BaseModel):
    tenant_id: int
    entra_tenant_id: str
    client_id: str
    has_secret: bool
    enabled: bool
    updated_at: str


class ConfigPatchRequest(BaseModel):
    entra_tenant_id: Optional[str] = Field(default=None, max_length=200)
    client_id: Optional[str] = Field(default=None, max_length=200)
    # ``client_secret`` is write-only. Empty / None means "leave the
    # stored secret untouched"; a string replaces it. Same convention
    # as the RTSP URL flow from pilot P7.
    client_secret: Optional[str] = Field(default=None, max_length=2048)
    enabled: Optional[bool] = None


def _to_response(cfg: OidcConfigRow) -> ConfigResponse:
    return ConfigResponse(
        tenant_id=cfg.tenant_id,
        entra_tenant_id=cfg.entra_tenant_id,
        client_id=cfg.client_id,
        has_secret=cfg.has_secret,
        enabled=cfg.enabled,
        updated_at=cfg.updated_at.isoformat(),
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

    # Compute the would-be effective config after this PATCH so we can
    # validate the discovery URL before committing. This mirrors the
    # branding flow's "validate before persist" rule.
    new_entra = (
        payload.entra_tenant_id
        if payload.entra_tenant_id is not None
        else before.entra_tenant_id
    )
    new_client = (
        payload.client_id if payload.client_id is not None else before.client_id
    )
    new_enabled = (
        payload.enabled if payload.enabled is not None else before.enabled
    )

    # Discovery validation — only run when ``enabled`` is being turned
    # on or the entra tenant id changed. Idempotent re-saves of an
    # already-valid config don't re-ping Microsoft.
    will_validate = (
        new_enabled
        and new_entra
        and (new_entra != before.entra_tenant_id or (new_enabled and not before.enabled))
    )
    if will_validate:
        try:
            discover(new_entra)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"entra discovery validation failed: {type(exc).__name__}",
            )

    values: dict[str, Any] = {"updated_at": datetime.now(tz=timezone.utc)}
    if payload.entra_tenant_id is not None:
        values["entra_tenant_id"] = payload.entra_tenant_id
    if payload.client_id is not None:
        values["client_id"] = payload.client_id
    if payload.client_secret is not None and payload.client_secret != "":
        values["client_secret_encrypted"] = encrypt_secret(payload.client_secret)
    if payload.enabled is not None:
        values["enabled"] = payload.enabled

    with engine.begin() as conn:
        conn.execute(
            update(tenant_oidc_config)
            .where(tenant_oidc_config.c.tenant_id == user.tenant_id)
            .values(**values)
        )
        after = get_config(conn, tenant_id=user.tenant_id)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.oidc.config_updated",
            entity_type="oidc",
            entity_id=str(user.tenant_id),
            before={
                "entra_tenant_id": before.entra_tenant_id,
                "client_id": before.client_id,
                "has_secret": before.has_secret,
                "enabled": before.enabled,
            },
            after={
                "entra_tenant_id": after.entra_tenant_id,
                "client_id": after.client_id,
                "has_secret": after.has_secret,
                "enabled": after.enabled,
                # Booleans only — the secret never appears in the
                # audit row.
                "secret_rotated": payload.client_secret is not None
                and payload.client_secret != "",
            },
        )
    return _to_response(after)
