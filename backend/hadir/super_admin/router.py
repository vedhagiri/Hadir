"""FastAPI router for ``/api/super-admin/*`` endpoints.

Login + console + tenant provisioning + impersonation. Every action
writes a ``public.super_admin_audit`` row; impersonation start/end
is also visible in the affected tenant's own ``audit_log`` so a tenant
Admin reading their own log can see when MTS touched their data.

These endpoints share the request middleware with the tenant API but
use a distinct cookie (``hadir_super_session``) — a single browser can
hold both at once. The console itself only ever requires the super
cookie; tenant endpoints continue to require the tenant cookie except
during impersonation, when the super-admin's session also satisfies
``current_user`` via the synthetic-user shim.
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from hadir.auth.passwords import verify_password
from hadir.config import get_settings
from hadir.db import get_engine, mts_staff, tenant_context, tenants
from hadir.super_admin.audit import write_super_admin_audit
from hadir.super_admin.dependencies import CurrentSuperAdmin, current_super_admin
from hadir.super_admin.repository import (
    TenantDetail,
    TenantSummary,
    get_tenant_detail,
    list_tenants,
    update_tenant_status,
)
from hadir.super_admin.sessions import (
    SUPER_SESSION_COOKIE,
    create_session,
    delete_session,
    set_impersonation,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/super-admin", tags=["super-admin"])

# Slug rule shown in the UI: lowercase letters, digits, underscores; must
# start with a letter or underscore; matches the DB CHECK on
# ``public.tenants.schema_name``. Hyphens are intentionally disallowed
# because Postgres schema names containing hyphens require quoting at
# every reference site, which we'd rather not do.
_SLUG_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _client_ip(request: Request) -> str:
    client = request.client
    return client.host if client is not None else "unknown"


# ---------------------------------------------------------------------------
# Login / logout / me
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class MeResponse(BaseModel):
    id: int
    email: str
    full_name: str
    impersonated_tenant_id: Optional[int] = None


@router.post("/login", status_code=status.HTTP_200_OK)
def login(payload: LoginRequest, request: Request, response: Response) -> MeResponse:
    """Verify MTS staff credentials, start a Super-Admin session."""

    email = payload.email.lower()
    ip = _client_ip(request)
    settings = get_settings()
    engine = get_engine()

    # All super-admin tables live in public — pin search_path there.
    with tenant_context("public"):
        with engine.begin() as conn:
            staff_row = conn.execute(
                select(
                    mts_staff.c.id,
                    mts_staff.c.email,
                    mts_staff.c.full_name,
                    mts_staff.c.password_hash,
                    mts_staff.c.is_active,
                ).where(mts_staff.c.email == email)
            ).first()

        failure_reason: str | None = None
        if staff_row is None:
            failure_reason = "unknown_email"
        elif not staff_row.is_active:
            failure_reason = "inactive_user"
        elif not verify_password(staff_row.password_hash, payload.password):
            failure_reason = "wrong_password"

        if failure_reason is not None:
            # Audit the failure if we have a known staff id (so per-id
            # rate limiting and reporting can lean on actor_user_id).
            if staff_row is not None:
                with engine.begin() as conn:
                    write_super_admin_audit(
                        conn,
                        super_admin_user_id=int(staff_row.id),
                        action="super_admin.login.failure",
                        entity_type="mts_staff",
                        entity_id=str(staff_row.id),
                        after={"reason": failure_reason, "email_attempted": email},
                        ip=ip,
                    )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid credentials",
            )

        assert staff_row is not None
        with engine.begin() as conn:
            session = create_session(
                conn,
                mts_staff_id=int(staff_row.id),
                idle_minutes=settings.session_idle_minutes,
            )
            write_super_admin_audit(
                conn,
                super_admin_user_id=int(staff_row.id),
                action="super_admin.login.success",
                entity_type="mts_staff",
                entity_id=str(staff_row.id),
                after={"session_id": session.id},
                ip=ip,
            )

    response.set_cookie(
        key=SUPER_SESSION_COOKIE,
        value=session.id,
        max_age=settings.session_idle_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )

    return MeResponse(
        id=int(staff_row.id),
        email=str(staff_row.email),
        full_name=str(staff_row.full_name),
        impersonated_tenant_id=None,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> Response:
    """Drop the super-session row and clear the cookie."""

    engine = get_engine()
    ip = _client_ip(request)

    with tenant_context("public"):
        with engine.begin() as conn:
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                action="super_admin.logout",
                entity_type="session",
                entity_id=super_admin.session_id,
                ip=ip,
            )
            delete_session(conn, super_admin.session_id)

    response.delete_cookie(key=SUPER_SESSION_COOKIE, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
def me(
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> MeResponse:
    return MeResponse(
        id=super_admin.id,
        email=super_admin.email,
        full_name=super_admin.full_name,
        impersonated_tenant_id=super_admin.impersonated_tenant_id,
    )


# ---------------------------------------------------------------------------
# Tenants list / detail
# ---------------------------------------------------------------------------


class TenantSummaryResponse(BaseModel):
    id: int
    name: str
    schema_name: str
    status: str
    created_at: str
    admin_count: int
    employee_count: int


class TenantDetailResponse(TenantSummaryResponse):
    admin_users: list[dict]
    recent_super_admin_audit: list[dict]


def _summary_to_response(s: TenantSummary) -> TenantSummaryResponse:
    return TenantSummaryResponse(
        id=s.id,
        name=s.name,
        schema_name=s.schema_name,
        status=s.status,
        created_at=s.created_at,
        admin_count=s.admin_count,
        employee_count=s.employee_count,
    )


def _detail_to_response(d: TenantDetail) -> TenantDetailResponse:
    return TenantDetailResponse(
        id=d.id,
        name=d.name,
        schema_name=d.schema_name,
        status=d.status,
        created_at=d.created_at,
        admin_count=d.admin_count,
        employee_count=d.employee_count,
        admin_users=d.admin_users,
        recent_super_admin_audit=d.recent_super_admin_audit,
    )


@router.get("/tenants")
def list_all_tenants(
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> list[TenantSummaryResponse]:
    summaries = list_tenants(get_engine())
    return [_summary_to_response(s) for s in summaries]


@router.get("/tenants/{tenant_id}")
def get_one_tenant(
    tenant_id: int,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> TenantDetailResponse:
    detail = get_tenant_detail(get_engine(), tenant_id=tenant_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="tenant not found")

    # Audit "tenant viewed" — operator opened the detail page. The
    # row only goes to the operator log; a tenant Admin doesn't need
    # a notification every time MTS reads their summary.
    engine = get_engine()
    with tenant_context("public"):
        with engine.begin() as conn:
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                tenant_id=tenant_id,
                action="super_admin.tenant.viewed",
                entity_type="tenant",
                entity_id=str(tenant_id),
                after={"name": detail.name, "schema_name": detail.schema_name},
                ip=_client_ip(request),
            )
    return _detail_to_response(detail)


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


class ProvisionRequest(BaseModel):
    slug: str = Field(
        min_length=1,
        max_length=63,
        description=(
            "Schema name for the tenant. Lowercase letters, digits, and "
            "underscores; must start with a letter or underscore."
        ),
    )
    name: str = Field(min_length=1, max_length=200)
    admin_email: EmailStr
    admin_full_name: Optional[str] = None
    admin_password: str = Field(min_length=8, max_length=1024)


class ProvisionResponse(BaseModel):
    tenant_id: int
    schema_name: str
    name: str
    admin_user_id: int
    admin_email: str


@router.post("/tenants", status_code=status.HTTP_201_CREATED)
def provision_tenant_endpoint(
    payload: ProvisionRequest,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> ProvisionResponse:
    """Wrap the P2 provisioning CLI as an HTTP endpoint."""

    if not _SLUG_RE.match(payload.slug):
        raise HTTPException(
            status_code=400,
            detail=(
                "slug must be lowercase letters, digits, and underscores, "
                "starting with a letter or underscore (no hyphens, no spaces)"
            ),
        )

    # Local import — script module pulls in alembic + subprocess and
    # we don't want to slow the FastAPI cold start.
    from scripts.provision_tenant import provision  # noqa: PLC0415

    try:
        result = provision(
            slug=payload.slug,
            name=payload.name,
            admin_email=str(payload.admin_email),
            admin_full_name=payload.admin_full_name or "",
            admin_password=payload.admin_password,
        )
    except Exception as exc:
        # Audit the failure so an operator can see why a provisioning
        # attempt didn't land. ``str(exc)`` is safe — provision()'s
        # ValueErrors carry slug/email validation messages, never the
        # plain password.
        engine = get_engine()
        with tenant_context("public"):
            with engine.begin() as conn:
                write_super_admin_audit(
                    conn,
                    super_admin_user_id=super_admin.id,
                    action="super_admin.tenant.provision_failed",
                    entity_type="tenant",
                    entity_id=None,
                    after={"slug": payload.slug, "error": f"{type(exc).__name__}: {exc}"},
                    ip=_client_ip(request),
                )
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}")

    # Success — audit. Plain password never appears in the row.
    engine = get_engine()
    with tenant_context("public"):
        with engine.begin() as conn:
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                tenant_id=int(result["tenant_id"]),
                action="super_admin.tenant.provisioned",
                entity_type="tenant",
                entity_id=str(result["tenant_id"]),
                after={
                    "schema_name": result["schema"],
                    "name": result["name"],
                    "admin_user_id": result["admin_user_id"],
                    "admin_email": result["admin_email"],
                },
                ip=_client_ip(request),
            )

    return ProvisionResponse(
        tenant_id=int(result["tenant_id"]),
        schema_name=str(result["schema"]),
        name=str(result["name"]),
        admin_user_id=int(result["admin_user_id"]),
        admin_email=str(result["admin_email"]),
    )


# ---------------------------------------------------------------------------
# Impersonation ("Access as")
# ---------------------------------------------------------------------------


class AccessAsResponse(BaseModel):
    tenant_id: int
    tenant_schema: str
    tenant_name: str


@router.post("/tenants/{tenant_id}/access-as")
def access_as(
    tenant_id: int,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> AccessAsResponse:
    """Set ``impersonated_tenant_id`` on the super-session.

    On the next request, the middleware reads the super-session,
    resolves the impersonated tenant's schema from ``public.tenants``,
    and applies it as the request's tenant context. The frontend then
    redirects to ``/`` and renders the tenant shell with the red
    "viewing as super-admin" banner overlaid.
    """

    engine = get_engine()
    with tenant_context("public"):
        with engine.begin() as conn:
            row = conn.execute(
                select(tenants.c.id, tenants.c.name, tenants.c.schema_name, tenants.c.status).where(
                    tenants.c.id == tenant_id
                )
            ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="tenant not found")
    if str(row.status) == "suspended":
        raise HTTPException(
            status_code=400, detail="tenant is suspended; unsuspend before impersonating"
        )

    with tenant_context("public"):
        with engine.begin() as conn:
            set_impersonation(
                conn, super_admin.session_id, tenant_id=int(row.id)
            )
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                tenant_id=int(row.id),
                action="super_admin.access_as.start",
                entity_type="tenant",
                entity_id=str(row.id),
                after={"name": str(row.name), "schema_name": str(row.schema_name)},
                ip=_client_ip(request),
            )

    return AccessAsResponse(
        tenant_id=int(row.id),
        tenant_schema=str(row.schema_name),
        tenant_name=str(row.name),
    )


@router.post("/exit-impersonation", status_code=status.HTTP_204_NO_CONTENT)
def exit_impersonation(
    request: Request,
    response: Response,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> Response:
    """Clear ``impersonated_tenant_id`` on the super-session."""

    engine = get_engine()
    impersonated_id = super_admin.impersonated_tenant_id

    with tenant_context("public"):
        with engine.begin() as conn:
            set_impersonation(conn, super_admin.session_id, tenant_id=None)
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                tenant_id=impersonated_id,
                action="super_admin.access_as.end",
                entity_type="tenant",
                entity_id=str(impersonated_id) if impersonated_id is not None else None,
                ip=_client_ip(request),
            )

    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# ---------------------------------------------------------------------------
# Suspend / unsuspend
# ---------------------------------------------------------------------------


class StatusUpdateRequest(BaseModel):
    status: str = Field(pattern=r"^(active|suspended)$")


@router.post("/tenants/{tenant_id}/status")
def update_status(
    tenant_id: int,
    payload: StatusUpdateRequest,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> TenantSummaryResponse:
    """Toggle a tenant's status active↔suspended."""

    result = update_tenant_status(
        get_engine(), tenant_id=tenant_id, new_status=payload.status
    )
    if result is None:
        raise HTTPException(status_code=404, detail="tenant not found")

    action = (
        "super_admin.tenant.suspended"
        if payload.status == "suspended"
        else "super_admin.tenant.unsuspended"
    )
    engine = get_engine()
    with tenant_context("public"):
        with engine.begin() as conn:
            write_super_admin_audit(
                conn,
                super_admin_user_id=super_admin.id,
                tenant_id=tenant_id,
                action=action,
                entity_type="tenant",
                entity_id=str(tenant_id),
                before={"status": result["old_status"]},
                after={"status": result["new_status"]},
                ip=_client_ip(request),
            )

    # Re-read for the response so the body reflects the persisted state.
    detail = get_tenant_detail(engine, tenant_id=tenant_id)
    assert detail is not None
    return TenantSummaryResponse(
        id=detail.id,
        name=detail.name,
        schema_name=detail.schema_name,
        status=detail.status,
        created_at=detail.created_at,
        admin_count=detail.admin_count,
        employee_count=detail.employee_count,
    )
