"""FastAPI router for ``/api/auth/*`` endpoints.

Three routes make up the pilot's login surface:

* ``POST /api/auth/login``   — email+password → session cookie
* ``POST /api/auth/logout``  — clear the session and cookie
* ``GET  /api/auth/me``      — describe the caller

Every outcome (success, wrong password, unknown email, rate-limited,
logout, expiry) writes an append-only row to ``main.audit_log``. Plain
passwords never appear in those rows — we only ever record the attempted
email and a short reason string.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    _load_current_user_bundle,
    current_user,
    primary_role,
)
from maugood.auth.passwords import verify_password
from maugood.auth.ratelimit import LoginRateLimiter, get_rate_limiter
from maugood.auth.sessions import (
    create_session,
    delete_session,
    update_active_role,
)
from maugood.config import get_settings
from maugood.db import (
    employees as employees_table,
    get_engine,
    tenant_context,
    tenants,
    users,
)
from maugood.tenants import TenantScope, get_tenant_scope
from maugood.tenants.slug import SLUG_RE

# Cookie that carries the tenant the session belongs to. Set alongside
# ``maugood_session`` at login, read by ``TenantScopeMiddleware`` to
# resolve which schema's ``user_sessions`` to look the cookie up in.
#
# Carries the **schema name** (e.g. ``tenant_mts_demo``), not the
# friendly slug. The cookie is HttpOnly server-set / server-read
# state — never user input — so it doesn't follow the slug-only
# rule that login bodies do. Storing schema_name spares the
# middleware a per-request slug→schema lookup against
# ``public.tenants``.
TENANT_COOKIE_NAME = "maugood_tenant"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    """Body of ``POST /api/auth/login``.

    The ``email`` field accepts any of three identifiers:

    1. An email address (``dawud@acme.com``) — the historical contract,
       resolved via ``users.email`` (CITEXT, case-insensitive).
    2. An employee code (``EMP001``, ``OM350``) — resolved via
       ``employees.employee_code`` → that row's ``email`` →
       ``users.email``. Lets HR import an XLSX without an email column
       and let staff log in with their badge number.
    3. A "username" (the local part of an email, ``dawud``) — resolved
       by an exact match on the local part of ``users.email`` when the
       lookup is unambiguous (one and only one user matches). Falls
       back silently if the local-part is shared.

    The wire field stays named ``email`` to avoid breaking the existing
    frontend; future clients can rename it.

    ``tenant_slug`` (v1.0 P5; reworked alongside migration 0026) is
    the **friendly slug** of the tenant — the value an operator types
    into the login form, what credentials.txt prints, and what
    ``public.tenants.slug`` stores. The handler resolves the slug to
    its row, reads ``schema_name`` from that row, and uses the
    schema name for ``SET search_path``. The two identifiers must
    not be confused: the schema name (``tenant_mts_demo``) is
    internal; passing it as ``tenant_slug`` returns 401 — there's
    exactly one valid identifier per tenant.

    Optional for backward compatibility with the pilot's
    single-tenant flow — when omitted in single mode, login defaults
    to the pilot's tenant (``slug='main'``). Required in multi mode.
    """

    # Accepts email / employee_code / username. Validation is
    # delegated to the resolver helper; the field stays a free-form
    # string to support all three. We still bound the length to keep
    # the rate-limiter key cardinality sane.
    email: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1024)
    tenant_slug: str | None = Field(default=None, max_length=40)


class MeResponse(BaseModel):
    id: int
    email: str
    full_name: str
    # P7: ``roles`` carries only the active role (preserves the pilot
    # contract — older clients that don't know about the switcher
    # treat the user as if they hold exactly that role). ``active_role``
    # makes that explicit for new clients; ``available_roles`` is the
    # full set the user holds and drives the topbar dropdown.
    roles: list[str]
    available_roles: list[str]
    active_role: str
    departments: list[int]
    # P3: True when ``current_user`` resolved a synthetic Super-Admin
    # in impersonation mode. The tenant shell uses this to render the
    # "Viewing as SuperAdmin" red banner.
    is_super_admin_impersonation: bool = False
    super_admin_user_id: int | None = None
    # P21: explicit per-user UI language (``en`` / ``ar``). ``None``
    # means "follow browser" — the frontend's i18next detector reads
    # ``navigator.language`` in that case.
    preferred_language: str | None = None
    # P22: theme + density. ``None`` on theme = "follow system";
    # ``None`` on density = "comfortable" (the design's default).
    preferred_theme: str | None = None
    preferred_density: str | None = None
    # Display name of the active tenant — read directly from
    # ``public.tenants.name``. Empty string on a fresh install before
    # the operator's setup wizard renames it; the frontend falls back
    # to the product name ("Maugood") in that case so the brand row
    # never renders blank.
    tenant_name: str = ""
    # ``True`` when the tenant has uploaded a brand logo through
    # ``/api/branding/logo``. The sidebar uses it to decide between
    # the tenant logo and the static product-mark fallback.
    has_brand_logo: bool = False
    # ISO timestamp from ``tenant_branding.updated_at`` — the sidebar
    # appends it as a ``?v=`` query string so the browser refetches
    # ``/api/branding/logo`` after the operator uploads a new file
    # (server already sends Cache-Control: no-store, but the
    # cache-buster guards against intermediaries).
    brand_logo_version: str | None = None
    # Session expiry surface for the frontend's "session about to expire"
    # warning modal. Every authenticated request slides the expiry; the
    # modal computes a countdown from ``session_expires_at`` and the
    # "Stay signed in" button POSTs ``/api/auth/refresh`` to extend it.
    session_expires_at: datetime | None = None
    session_idle_minutes: int = 0


class RefreshSessionResponse(BaseModel):
    """Returned from ``POST /api/auth/refresh``.

    The endpoint itself is a no-op besides the sliding-expiry side
    effect on ``current_user``; this response just gives the frontend
    the new ``session_expires_at`` so it can reset its countdown.
    """

    session_expires_at: datetime
    session_idle_minutes: int


class PreferredLanguageRequest(BaseModel):
    # ``None`` clears the preference and lets the browser drive.
    preferred_language: str | None = Field(default=None, max_length=8)


class PreferredThemeRequest(BaseModel):
    # ``None`` clears the preference and falls back to "system".
    preferred_theme: str | None = Field(default=None, max_length=16)


class PreferredDensityRequest(BaseModel):
    # ``None`` clears the preference and falls back to "comfortable".
    preferred_density: str | None = Field(default=None, max_length=16)


class SwitchRoleRequest(BaseModel):
    role: str = Field(min_length=1, max_length=64)


def _client_ip(request: Request) -> str:
    """Best-effort client IP. ``request.client.host`` is enough for pilot."""

    client = request.client
    return client.host if client is not None else "unknown"


def _resolve_user_for_login(
    conn,
    *,
    tenant_id: int,
    identifier: str,
):
    """Look up a user by email / employee_code / username (in that order).

    Returns the same row shape as the original ``select(users)`` so the
    caller can pattern-match without caring which path matched. ``None``
    when no candidate is found by any path.

    The three paths run sequentially — we don't try every path and pick
    a winner. The first hit wins, which means the order matters: an
    email always beats an employee_code, an employee_code always beats
    a username. Operators with a "username == employee_code" collision
    get the email/employee_code interpretation, never the username one.
    """

    from sqlalchemy import func as _func  # noqa: PLC0415

    base_select = select(
        users.c.id,
        users.c.tenant_id,
        users.c.email,
        users.c.full_name,
        users.c.password_hash,
        users.c.is_active,
    )

    # Path 1 — email. The ``@`` heuristic skips spurious lookups when
    # the operator typed an employee_code (no ``@`` in the string).
    if "@" in identifier:
        row = conn.execute(
            base_select.where(
                users.c.tenant_id == tenant_id,
                users.c.email == identifier.lower(),
            )
        ).first()
        if row is not None:
            return row

    # Path 2 — employee_code. Cross-table walk:
    #   employees.employee_code → employees.email → users.email
    # ``employees.email`` is nullable (post-#1) so we filter rows that
    # actually carry an email; an employee without an email simply
    # can't log in with their code yet (Admin must set one first).
    code = identifier.strip()
    if code:
        emp_row = conn.execute(
            select(employees_table.c.email).where(
                employees_table.c.tenant_id == tenant_id,
                employees_table.c.employee_code == code,
                employees_table.c.email.is_not(None),
            )
        ).first()
        if emp_row is not None and emp_row.email:
            row = conn.execute(
                base_select.where(
                    users.c.tenant_id == tenant_id,
                    users.c.email == str(emp_row.email).lower(),
                )
            ).first()
            if row is not None:
                return row

    # Path 3 — username (local part of email). Only resolves when
    # exactly one user matches. Two users sharing a local part is
    # ambiguous — fall through to the unknown-credential path so an
    # attacker can't oracle which account exists.
    if "@" not in identifier:
        candidates = conn.execute(
            base_select.where(
                users.c.tenant_id == tenant_id,
                _func.split_part(users.c.email, "@", 1)
                == identifier.lower(),
            ).limit(2)
        ).all()
        if len(candidates) == 1:
            return candidates[0]

    return None


def _resolve_login_target(
    *,
    tenant_slug: str | None,
    settings,
    engine,
) -> tuple[int, str]:
    """Return ``(tenant_id, tenant_schema)`` the login should run under.

    Path A — explicit ``tenant_slug`` (v1.0 multi-tenant): validate the
    slug against the friendly-slug regex (the same CHECK migration
    0026 enforces), then look up the row in the global registry by
    ``slug``. The row's ``schema_name`` is what we hand back for
    ``SET search_path``. Refuse suspended tenants. Refuse unknown
    slugs (401, not 404 — preventing tenant enumeration).

    The schema name (``tenant_mts_demo``) is **not** a valid
    ``tenant_slug``: every Postgres schema name created post-pilot
    starts with ``tenant_``, which fails the slug regex's
    "must start with [a-z], not underscore" rule. Pass the friendly
    slug (``mts_demo``) — there's exactly one valid identifier per
    tenant by design.

    Path B — no slug, ``MAUGOOD_TENANT_MODE=single`` (pilot single-tenant
    compatibility): use the configured default tenant id and the
    conventional ``main`` schema. In ``multi`` mode an omitted slug
    returns 400 — there is no defensible tenant to default to.
    """

    if tenant_slug is not None:
        if not SLUG_RE.match(tenant_slug):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid tenant_slug",
            )
        with tenant_context("public"):
            with engine.begin() as conn:
                row = conn.execute(
                    select(
                        tenants.c.id,
                        tenants.c.schema_name,
                        tenants.c.status,
                    ).where(tenants.c.slug == tenant_slug)
                ).first()
        if row is None:
            # Don't 404 — that leaks tenant existence by oracle. Treat
            # as bad credentials so attackers can't enumerate tenants.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid credentials",
            )
        if str(row.status) == "suspended":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="tenant suspended",
            )
        return int(row.id), str(row.schema_name)

    if settings.tenant_mode == "multi":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tenant_slug is required",
        )
    return settings.default_tenant_id, "main"


@router.post("/login", status_code=status.HTTP_200_OK)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    scope: Annotated[TenantScope, Depends(get_tenant_scope)],
    limiter: Annotated[LoginRateLimiter, Depends(get_rate_limiter)],
) -> MeResponse:
    """Verify credentials, start a session, set the cookie."""

    # Keep the typed identifier verbatim for the audit trail (so the
    # operator can see what was actually entered — email, code, or
    # username), and a separate normalised key for the rate-limiter
    # bucket so an attacker can't cycle case to dodge the throttle.
    typed_identifier = payload.email.strip()
    rate_key = typed_identifier.lower()
    ip = _client_ip(request)
    settings = get_settings()
    engine = get_engine()

    # INFO log on every attempt so a tenant-routing failure is visible
    # in the operator's log even when no audit row gets written (the
    # unknown-tenant 401 happens before we have a tenant_id to scope
    # the audit insert under). Never logs the password.
    logger.info(
        "login attempt identifier=%s tenant_slug=%s ip=%s",
        typed_identifier,
        payload.tenant_slug or "<none>",
        ip,
    )

    target_tenant_id, target_schema = _resolve_login_target(
        tenant_slug=payload.tenant_slug, settings=settings, engine=engine
    )

    # All DB ops below run under the resolved tenant's schema. The
    # checkout listener applies SET search_path on every borrowed
    # connection. Login pre-dates the middleware setting any schema
    # (the request was anonymous on entry), so this context is what
    # makes multi-tenant login work.
    with tenant_context(target_schema):
        if limiter.is_blocked(rate_key, ip):
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=target_tenant_id,
                    action="auth.login.rate_limited",
                    entity_type="user",
                    entity_id=None,
                    after={"identifier_attempted": typed_identifier, "ip": ip},
                )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="too many login attempts",
            )

        # Load the user in a short read-only transaction. We end it
        # before any branch that might ``raise HTTPException`` —
        # raising inside ``engine.begin()`` would roll back the audit
        # write that follows. The resolver tries email →
        # employee_code → username (see ``_resolve_user_for_login``).
        with engine.begin() as conn:
            user_row = _resolve_user_for_login(
                conn,
                tenant_id=target_tenant_id,
                identifier=typed_identifier,
            )

        # Single "invalid credentials" path for (a) unknown email, (b)
        # wrong password, and (c) inactive user. We still audit each case
        # with a distinct ``reason`` so operators can tell them apart in
        # the log, but the client sees one generic 401.
        failure_reason: str | None = None
        if user_row is None:
            failure_reason = "unknown_email"
        elif not user_row.is_active:
            failure_reason = "inactive_user"
        elif not verify_password(user_row.password_hash, payload.password):
            failure_reason = "wrong_password"

        if failure_reason is not None:
            attempts = limiter.register_failure(rate_key, ip)
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=target_tenant_id,
                    actor_user_id=int(user_row.id) if user_row is not None else None,
                    action="auth.login.failure",
                    entity_type="user",
                    entity_id=str(user_row.id) if user_row is not None else None,
                    after={
                        "identifier_attempted": typed_identifier,
                        "ip": ip,
                        "reason": failure_reason,
                        "attempts": attempts,
                    },
                )
            logger.info(
                "login failed identifier=%s tenant_schema=%s reason=%s attempts=%d",
                typed_identifier,
                target_schema,
                failure_reason,
                attempts,
            )
            # Do not reveal which case fired — PROJECT_CONTEXT §12 red line.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid credentials",
            )

        assert user_row is not None  # narrowed by the failure_reason branch.

        # Success — reset the counter, create the session, audit, load bundle.
        limiter.reset_key(rate_key, ip)
        # The resolved row's email is the canonical identifier from
        # here on (audit + log lines). The typed identifier might
        # have been an employee_code or a username.
        resolved_email = str(user_row.email)
        with engine.begin() as conn:
            # P7: prime ``active_role`` with the user's highest role
            # so a fresh session lands on the most-capable nav by
            # default. We have to load the bundle once up front to
            # know which roles they hold.
            initial_bundle = _load_current_user_bundle(
                conn,
                user_id=int(user_row.id),
                tenant_id=target_tenant_id,
            )
            initial_active = primary_role(
                initial_bundle.roles if initial_bundle is not None else ()
            )
            session = create_session(
                conn,
                tenant_id=target_tenant_id,
                user_id=int(user_row.id),
                idle_minutes=settings.session_idle_minutes,
                tenant_schema=target_schema,
                active_role=initial_active,
            )
            write_audit(
                conn,
                tenant_id=target_tenant_id,
                actor_user_id=int(user_row.id),
                action="auth.login.success",
                entity_type="user",
                entity_id=str(user_row.id),
                after={
                    "ip": ip,
                    "session_id": session.id,
                    "tenant_schema": target_schema,
                },
            )
            bundle = _load_current_user_bundle(
                conn,
                user_id=int(user_row.id),
                tenant_id=target_tenant_id,
            )
        logger.info(
            "login success email=%s identifier=%s tenant_schema=%s user_id=%d",
            resolved_email,
            typed_identifier,
            target_schema,
            int(user_row.id),
        )

    # bundle can't be None here — we just authenticated the row.
    assert bundle is not None

    response.set_cookie(
        key=settings.session_cookie_name,
        value=session.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    # P5: pin the session to its tenant. The middleware reads this on
    # every subsequent request to know which ``user_sessions`` table to
    # look the opaque ``maugood_session`` token up in.
    response.set_cookie(
        key=TENANT_COOKIE_NAME,
        value=target_schema,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )

    has_logo, version = _resolve_brand_logo_meta(target_tenant_id)
    return MeResponse(
        id=bundle.id,
        email=bundle.email,
        full_name=bundle.full_name,
        roles=[initial_active],
        available_roles=list(bundle.roles),
        active_role=initial_active,
        departments=list(bundle.departments),
        preferred_language=bundle.preferred_language,
        preferred_theme=bundle.preferred_theme,
        preferred_density=bundle.preferred_density,
        tenant_name=_resolve_tenant_name(target_tenant_id),
        has_brand_logo=has_logo,
        brand_logo_version=version,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> Response:
    """Drop the session row and clear the cookie."""

    settings = get_settings()
    engine = get_engine()
    ip = _client_ip(request)

    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.logout",
            entity_type="session",
            entity_id=user.session_id,
            after={"ip": ip},
        )
        delete_session(conn, user.session_id)

    response.delete_cookie(key=settings.session_cookie_name, path="/")
    response.delete_cookie(key=TENANT_COOKIE_NAME, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
def me(
    request: Request,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """Describe the caller."""

    is_imp = bool(getattr(request.state, "is_super_admin", False)) and user.id == 0
    sa_user_id: int | None = (
        int(getattr(request.state, "super_admin_user_id", 0)) if is_imp else None
    )
    return _to_me_response(user, is_imp=is_imp, sa_user_id=sa_user_id, request=request)


# ── Session refresh ─────────────────────────────────────────────────────
# A no-op endpoint: the dependency chain calls ``current_user`` which
# slides ``expires_at`` and refreshes the cookie. The body just returns
# the new expiry so the frontend's "session about to expire" modal can
# reset its countdown.
@router.post("/refresh", response_model=RefreshSessionResponse)
def refresh_session(
    request: Request,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> RefreshSessionResponse:
    settings = get_settings()
    session_exp = getattr(request.state, "session_expires_at", None)
    # Defensive fallback — if the synthetic Super-Admin path hits this,
    # touch_session wasn't called, so we hand back a synthetic expiry
    # one idle-window from now. (Won't actually happen in production —
    # super-admin sessions use their own cookie path.)
    if session_exp is None:
        session_exp = datetime.now(tz=timezone.utc) + timedelta(
            minutes=settings.session_idle_minutes
        )
    # Silent audit. Useful when an operator wants to inspect "did the
    # user actually click 'Stay signed in' or was their browser idle?"
    engine = get_engine()
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id or None,
            action="auth.session.refreshed",
            entity_type="session",
            entity_id=str(user.session_id),
            after={"new_expires_at": session_exp.isoformat()},
        )
    return RefreshSessionResponse(
        session_expires_at=session_exp,
        session_idle_minutes=settings.session_idle_minutes,
    )


def _resolve_tenant_name(tenant_id: int) -> str:
    """Look up ``public.tenants.name`` for the active tenant.

    Used to thread the display name through ``/api/auth/me`` so the
    frontend brand row reflects whatever the operator's setup wizard
    set the value to. Returns an empty string for a missing row (new
    deployment before the wizard ran) — the frontend falls back to the
    product name when the value is empty.
    """

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(tenants.c.name).where(tenants.c.id == tenant_id)
        ).first()
    return str(row.name) if row and row.name else ""


def _resolve_brand_logo_meta(tenant_id: int) -> tuple[bool, str | None]:
    """Return ``(has_logo, version_str)`` from the active tenant's
    ``tenant_branding`` row.

    Surfaced through ``MeResponse`` so the sidebar can decide between
    the operator-uploaded logo and the static product-mark fallback
    without an extra round-trip. ``version_str`` is the row's
    ``updated_at`` ISO string — the sidebar appends it as ``?v=…`` so
    the browser refetches whenever the operator uploads a new file.
    Returns ``(False, None)`` when no row exists yet (lazily-created
    on first read elsewhere)."""

    from maugood.db import tenant_branding  # noqa: PLC0415

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(
                tenant_branding.c.logo_path,
                tenant_branding.c.updated_at,
            ).where(tenant_branding.c.tenant_id == tenant_id)
        ).first()
    if row is None or row.logo_path is None:
        return False, None
    return True, row.updated_at.isoformat()


def _to_me_response(
    user: CurrentUser,
    *,
    is_imp: bool = False,
    sa_user_id: int | None = None,
    request: Request | None = None,
) -> MeResponse:
    has_logo, version = _resolve_brand_logo_meta(user.tenant_id)
    settings = get_settings()
    # The session expiry is stashed on ``request.state`` by
    # ``current_user`` as a side effect of touch_session. Synthetic
    # Super-Admin impersonation doesn't go through ``touch_session``
    # so it'll be missing — we just omit the field in that case.
    session_exp: datetime | None = (
        getattr(request.state, "session_expires_at", None) if request else None
    )
    return MeResponse(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        roles=list(user.roles),
        available_roles=list(user.available_roles),
        active_role=user.active_role,
        departments=list(user.departments),
        is_super_admin_impersonation=is_imp,
        super_admin_user_id=sa_user_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
        tenant_name=_resolve_tenant_name(user.tenant_id),
        has_brand_logo=has_logo,
        brand_logo_version=version,
        session_expires_at=session_exp,
        session_idle_minutes=settings.session_idle_minutes,
    )


@router.patch("/preferred-language")
def set_preferred_language(
    payload: PreferredLanguageRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P21: persist the operator's UI language preference.

    Pass ``preferred_language=null`` to clear the choice and let the
    browser drive again. The DB CHECK on ``users.preferred_language``
    rejects anything other than ``en`` / ``ar`` / NULL.
    """

    from maugood.i18n import SUPPORTED_LANGUAGES  # noqa: PLC0415

    new_value = payload.preferred_language
    if new_value is not None and new_value not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_language must be null or one of: "
                + ", ".join(SUPPORTED_LANGUAGES)
            ),
        )

    if user.id == 0:
        # Synthetic Super-Admin — no real users row to update.
        # Return as-is so the topbar switcher in the impersonation
        # banner doesn't crash.
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(
                users.c.id == user.id, users.c.tenant_id == user.tenant_id
            )
            .values(preferred_language=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_language.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_language": user.preferred_language},
            after={"preferred_language": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=new_value,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)


# Allowed values mirror the DB CHECK constraints (migration 0023).
_THEME_OPTIONS = ("system", "light", "dark")
_DENSITY_OPTIONS = ("compact", "comfortable")


@router.patch("/preferred-theme")
def set_preferred_theme(
    payload: PreferredThemeRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P22: persist the operator's theme preference (system/light/dark).

    ``preferred_theme=null`` clears the explicit choice — the
    frontend's ThemeProvider then falls back to the OS preference
    via ``prefers-color-scheme``. The DB CHECK constraint rejects
    anything outside the documented enum.
    """

    new_value = payload.preferred_theme
    if new_value is not None and new_value not in _THEME_OPTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_theme must be null or one of: "
                + ", ".join(_THEME_OPTIONS)
            ),
        )

    if user.id == 0:
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(users.c.id == user.id, users.c.tenant_id == user.tenant_id)
            .values(preferred_theme=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_theme.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_theme": user.preferred_theme},
            after={"preferred_theme": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=new_value,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)


@router.patch("/preferred-density")
def set_preferred_density(
    payload: PreferredDensityRequest,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """P22: persist the operator's density preference (compact/comfortable)."""

    new_value = payload.preferred_density
    if new_value is not None and new_value not in _DENSITY_OPTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "preferred_density must be null or one of: "
                + ", ".join(_DENSITY_OPTIONS)
            ),
        )

    if user.id == 0:
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            users.update()
            .where(users.c.id == user.id, users.c.tenant_id == user.tenant_id)
            .values(preferred_density=new_value)
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.preferred_density.updated",
            entity_type="user",
            entity_id=str(user.id),
            before={"preferred_density": user.preferred_density},
            after={"preferred_density": new_value},
        )

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=user.roles,
        available_roles=user.available_roles,
        active_role=user.active_role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=new_value,
    )
    return _to_me_response(refreshed)


@router.post("/switch-role")
def switch_role(
    payload: SwitchRoleRequest,
    request: Request,
    user: Annotated[CurrentUser, Depends(current_user)],
) -> MeResponse:
    """Flip the session's active role (P7).

    Validates the user actually holds the role, persists the new
    ``active_role`` claim on ``user_sessions.data``, audits the
    transition, and returns the refreshed ``/me`` payload. Refuses
    for the synthetic Super-Admin (no real session row to update —
    operators QA non-Admin flows by signing in as a real test user).
    """

    if user.id == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot switch role for super-admin impersonation",
        )

    if payload.role not in user.available_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"user does not hold role {payload.role!r}",
        )
    if payload.role == user.active_role:
        # No-op — return current state without an audit row.
        return _to_me_response(user)

    engine = get_engine()
    with engine.begin() as conn:
        update_active_role(conn, user.session_id, active_role=payload.role)
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="auth.role.switched",
            entity_type="session",
            entity_id=user.session_id,
            before={"active_role": user.active_role},
            after={"active_role": payload.role},
        )
        bundle = _load_current_user_bundle(
            conn, user_id=user.id, tenant_id=user.tenant_id
        )
    assert bundle is not None

    refreshed = CurrentUser(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        full_name=user.full_name,
        roles=(payload.role,),
        available_roles=bundle.roles,
        active_role=payload.role,
        departments=user.departments,
        session_id=user.session_id,
        preferred_language=user.preferred_language,
        preferred_theme=user.preferred_theme,
        preferred_density=user.preferred_density,
    )
    return _to_me_response(refreshed)
