"""Branding endpoints.

Two surfaces sharing the same business logic:

* ``/api/branding`` — caller's tenant. Read open to any authenticated
  user; write requires Admin role. Used by the tenant-side Settings →
  Branding page and by the SPA's ``BrandingProvider`` to apply the
  ``<style>`` block at startup.
* ``/api/super-admin/tenants/{id}/branding`` — operator-side. Used
  by the Super-Admin tenant detail "Branding" tab to edit any
  tenant's branding without first hitting "Access as". (The detail
  page also offers Access-as for cases where the operator wants to
  experience the tenant shell.)

Audit:

* Tenant-side update → ``branding.updated`` in the tenant audit log
  (and in ``public.super_admin_audit`` if an operator is in
  impersonation context — that dual-write is automatic via P3's
  ``write_audit`` ContextVar).
* Operator-side update → ``branding.updated`` in BOTH the tenant
  audit log (so the tenant Admin sees the change) AND
  ``public.super_admin_audit`` (so MTS keeps a cross-tenant
  history). Invoked via ``write_audit_dual``.
"""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, current_user, require_role
from maugood.branding import css as branding_css
from maugood.branding import logo as logo_io
from maugood.branding import repository as branding_repo
from maugood.branding.constants import BRAND_PALETTE, FONT_OPTIONS
from maugood.branding.schemas import BrandingPatchRequest, BrandingResponse
from maugood.db import get_engine, tenant_context, tenants
from maugood.super_admin.audit import write_audit_dual
from maugood.super_admin.dependencies import (
    CurrentSuperAdmin,
    current_super_admin,
)

logger = logging.getLogger(__name__)

# Tenant-side router — caller acts on their own tenant.
router = APIRouter(prefix="/api/branding", tags=["branding"])

# Operator-side router — caller targets a specific tenant by id.
super_admin_router = APIRouter(
    prefix="/api/super-admin/tenants/{tenant_id}/branding",
    tags=["branding", "super-admin"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_response(
    row: branding_repo.BrandingRow,
    *,
    display_name: str = "",
) -> BrandingResponse:
    return BrandingResponse(
        tenant_id=row.tenant_id,
        primary_color_key=row.primary_color_key,
        font_key=row.font_key,
        has_logo=row.logo_path is not None,
        updated_at=row.updated_at.isoformat(),
        display_name=display_name,
    )


def _read_display_name(tenant_id: int) -> str:
    """Read ``public.tenants.name`` for one tenant. Returns the empty
    string when the tenant row is missing (callers treat that as "use
    the product fallback")."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            row = conn.execute(
                select(tenants.c.name).where(tenants.c.id == tenant_id)
            ).first()
    return str(row.name) if row and row.name else ""


def _write_display_name(
    tenant_id: int,
    name: str,
    *,
    actor_user_id: Optional[int],
    super_admin_user_id: Optional[int] = None,
    super_admin_ip: Optional[str] = None,
) -> str:
    """Update ``public.tenants.name`` and write a paired audit row.

    The unique constraint on ``tenants.name`` can refuse the update
    when another tenant already holds the name; we surface that as a
    400 in the patch handler. Returns the value that actually landed
    in the row."""

    from sqlalchemy import update as _sa_update  # noqa: PLC0415
    from sqlalchemy.exc import IntegrityError  # noqa: PLC0415

    before = _read_display_name(tenant_id)
    if before == name:
        return before

    with tenant_context("public"):
        with get_engine().begin() as conn:
            try:
                conn.execute(
                    _sa_update(tenants)
                    .where(tenants.c.id == tenant_id)
                    .values(name=name)
                )
            except IntegrityError as exc:
                # Unique constraint hit — another tenant already owns
                # this display name. Surface as a 400 to the caller.
                raise HTTPException(
                    status_code=400,
                    detail="display name already in use by another tenant",
                ) from exc

    # Audit lands in the tenant's own log so the rename is visible to
    # the tenant Admin alongside the rest of the branding history.
    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    with tenant_context(schema):
        with get_engine().begin() as conn:
            if super_admin_user_id is not None:
                write_audit_dual(
                    conn,
                    tenant_id=tenant_id,
                    super_admin_user_id=super_admin_user_id,
                    actor_user_id=None,
                    action="branding.display_name_updated",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    before={"display_name": before},
                    after={"display_name": name},
                    ip=super_admin_ip,
                )
            else:
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=actor_user_id,
                    action="branding.display_name_updated",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    before={"display_name": before},
                    after={"display_name": name},
                )
    return name


def _resolve_tenant_schema(*, tenant_id: int) -> str:
    """Look up ``tenants.schema_name`` for an operator-targeted tenant."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            row = conn.execute(
                select(tenants.c.schema_name).where(tenants.c.id == tenant_id)
            ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="tenant not found")
    return str(row.schema_name)


# ---------------------------------------------------------------------------
# Tenant-side: caller acts on their own tenant
# ---------------------------------------------------------------------------


@router.get("")
def get_my_branding(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> BrandingResponse:
    engine = get_engine()
    with engine.begin() as conn:
        row = branding_repo.get_branding(conn, tenant_id=user.tenant_id)
    return _to_response(row, display_name=_read_display_name(user.tenant_id))


@router.get(".css")
def get_my_branding_css(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> Response:
    """Stream the per-tenant CSS overrides as ``text/css``."""

    engine = get_engine()
    with engine.begin() as conn:
        row = branding_repo.get_branding(conn, tenant_id=user.tenant_id)
    css = branding_css.render_css(row)
    return Response(
        content=css,
        media_type="text/css",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/options")
def get_options(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> dict:
    """Expose the curated palette + font list for the picker UI."""

    return {
        "palette": [
            {
                "key": key,
                "accent": entry["accent"],
                "accent_hover": entry["accent_hover"],
                "accent_soft": entry["accent_soft"],
                "accent_border": entry["accent_border"],
                "accent_text": entry["accent_text"],
            }
            for key, entry in BRAND_PALETTE.items()
        ],
        "fonts": [
            {"key": key, "stack": stack} for key, stack in FONT_OPTIONS.items()
        ],
    }


@router.patch("")
def patch_my_branding(
    payload: BrandingPatchRequest,
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
) -> BrandingResponse:
    try:
        primary = payload.validated_color()
        font = payload.validated_font()
        display_name = payload.validated_display_name()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _do_branding_patch(
        tenant_id=user.tenant_id,
        actor_user_id=user.id,
        primary_color_key=primary,
        font_key=font,
        display_name=display_name,
    )


@router.post("/logo", status_code=status.HTTP_200_OK)
def upload_my_logo(
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
    logo: UploadFile = File(...),
) -> BrandingResponse:
    return _do_logo_upload(
        tenant_id=user.tenant_id, actor_user_id=user.id, upload=logo
    )


@router.delete("/logo", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_logo(
    request: Request,
    user: Annotated[CurrentUser, Depends(require_role("Admin"))],
) -> Response:
    _do_logo_delete(tenant_id=user.tenant_id, actor_user_id=user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/logo")
def get_my_logo(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> Response:
    return _serve_logo(tenant_id=user.tenant_id)


# ---------------------------------------------------------------------------
# Operator-side: act on a specific tenant by id
# ---------------------------------------------------------------------------


@super_admin_router.get("")
def super_admin_get_branding(
    tenant_id: int,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> BrandingResponse:
    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            row = branding_repo.get_branding(conn, tenant_id=tenant_id)
    return _to_response(row, display_name=_read_display_name(tenant_id))


@super_admin_router.patch("")
def super_admin_patch_branding(
    tenant_id: int,
    payload: BrandingPatchRequest,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> BrandingResponse:
    try:
        primary = payload.validated_color()
        font = payload.validated_font()
        display_name = payload.validated_display_name()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _do_branding_patch(
        tenant_id=tenant_id,
        actor_user_id=None,  # operator, not a tenant user
        primary_color_key=primary,
        font_key=font,
        display_name=display_name,
        super_admin_user_id=super_admin.id,
        super_admin_ip=getattr(request.state, "client_ip", None),
    )


@super_admin_router.post("/logo", status_code=status.HTTP_200_OK)
def super_admin_upload_logo(
    tenant_id: int,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
    logo: UploadFile = File(...),
) -> BrandingResponse:
    return _do_logo_upload(
        tenant_id=tenant_id,
        actor_user_id=None,
        upload=logo,
        super_admin_user_id=super_admin.id,
        super_admin_ip=getattr(request.state, "client_ip", None),
    )


@super_admin_router.delete("/logo", status_code=status.HTTP_204_NO_CONTENT)
def super_admin_delete_logo(
    tenant_id: int,
    request: Request,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> Response:
    _do_logo_delete(
        tenant_id=tenant_id,
        actor_user_id=None,
        super_admin_user_id=super_admin.id,
        super_admin_ip=getattr(request.state, "client_ip", None),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@super_admin_router.get("/logo")
def super_admin_get_logo(
    tenant_id: int,
    super_admin: Annotated[CurrentSuperAdmin, Depends(current_super_admin)],
) -> Response:
    return _serve_logo(tenant_id=tenant_id)


# ---------------------------------------------------------------------------
# Shared business logic
# ---------------------------------------------------------------------------


def _do_branding_patch(
    *,
    tenant_id: int,
    actor_user_id: Optional[int],
    primary_color_key: Optional[str],
    font_key: Optional[str],
    display_name: Optional[str] = None,
    super_admin_user_id: Optional[int] = None,
    super_admin_ip: Optional[str] = None,
) -> BrandingResponse:
    """Patch primary_color_key / font_key / display_name for ``tenant_id``.

    For tenant-side calls, the request is already inside the tenant
    context (set by the middleware). For operator-side calls, we hop
    into the target tenant's schema explicitly. ``display_name`` lives
    in ``public.tenants.name`` rather than ``tenant_branding`` so it
    has its own audit row + writer.
    """

    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    engine = get_engine()

    only_display_name = (
        primary_color_key is None and font_key is None and display_name is not None
    )

    with tenant_context(schema):
        with engine.begin() as conn:
            before = branding_repo.get_branding(conn, tenant_id=tenant_id)
            # Only touch tenant_branding if there's something to write
            # for it. A display-name-only patch leaves the row alone
            # (and its updated_at — we don't want a rename to invalidate
            # the cached CSS).
            if only_display_name:
                after = before
            else:
                after = branding_repo.update_branding(
                    conn,
                    tenant_id=tenant_id,
                    primary_color_key=primary_color_key,
                    font_key=font_key,
                )
            if not only_display_name:
                if super_admin_user_id is not None:
                    write_audit_dual(
                        conn,
                        tenant_id=tenant_id,
                        super_admin_user_id=super_admin_user_id,
                        actor_user_id=None,
                        action="branding.updated",
                        entity_type="branding",
                        entity_id=str(tenant_id),
                        before={
                            "primary_color_key": before.primary_color_key,
                            "font_key": before.font_key,
                        },
                        after={
                            "primary_color_key": after.primary_color_key,
                            "font_key": after.font_key,
                        },
                        ip=super_admin_ip,
                    )
                else:
                    write_audit(
                        conn,
                        tenant_id=tenant_id,
                        actor_user_id=actor_user_id,
                        action="branding.updated",
                        entity_type="branding",
                        entity_id=str(tenant_id),
                        before={
                            "primary_color_key": before.primary_color_key,
                            "font_key": before.font_key,
                        },
                        after={
                            "primary_color_key": after.primary_color_key,
                            "font_key": after.font_key,
                        },
                    )

    if not only_display_name:
        branding_css.invalidate_tenant(tenant_id)

    # Display-name update is its own write + audit row. Done after the
    # branding row update so the audit ordering reads cleanly in the
    # log.
    if display_name is not None:
        _write_display_name(
            tenant_id,
            display_name,
            actor_user_id=actor_user_id,
            super_admin_user_id=super_admin_user_id,
            super_admin_ip=super_admin_ip,
        )

    return _to_response(after, display_name=_read_display_name(tenant_id))


def _do_logo_upload(
    *,
    tenant_id: int,
    actor_user_id: Optional[int],
    upload: UploadFile,
    super_admin_user_id: Optional[int] = None,
    super_admin_ip: Optional[str] = None,
) -> BrandingResponse:
    content = upload.file.read()
    try:
        stored = logo_io.write_logo(tenant_id=tenant_id, content=content)
    except logo_io.LogoValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            after = branding_repo.update_branding(
                conn, tenant_id=tenant_id, logo_path=str(stored.path)
            )
            audit_after = {
                "ext": stored.ext,
                "size_bytes": stored.size_bytes,
            }
            if super_admin_user_id is not None:
                write_audit_dual(
                    conn,
                    tenant_id=tenant_id,
                    super_admin_user_id=super_admin_user_id,
                    actor_user_id=None,
                    action="branding.logo_uploaded",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    after=audit_after,
                    ip=super_admin_ip,
                )
            else:
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=actor_user_id,
                    action="branding.logo_uploaded",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    after=audit_after,
                )

    branding_css.invalidate_tenant(tenant_id)
    return _to_response(after, display_name=_read_display_name(tenant_id))


def _do_logo_delete(
    *,
    tenant_id: int,
    actor_user_id: Optional[int],
    super_admin_user_id: Optional[int] = None,
    super_admin_ip: Optional[str] = None,
) -> None:
    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            before = branding_repo.get_branding(conn, tenant_id=tenant_id)
            branding_repo.update_branding(
                conn, tenant_id=tenant_id, clear_logo=True
            )
            if super_admin_user_id is not None:
                write_audit_dual(
                    conn,
                    tenant_id=tenant_id,
                    super_admin_user_id=super_admin_user_id,
                    actor_user_id=None,
                    action="branding.logo_deleted",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    before={"logo_path": before.logo_path},
                    ip=super_admin_ip,
                )
            else:
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=actor_user_id,
                    action="branding.logo_deleted",
                    entity_type="branding",
                    entity_id=str(tenant_id),
                    before={"logo_path": before.logo_path},
                )

    logo_io.delete_logo(tenant_id=tenant_id)
    branding_css.invalidate_tenant(tenant_id)


def _serve_logo(*, tenant_id: int) -> Response:
    """Serve a tenant's logo bytes. 404 if no logo set."""

    schema = _resolve_tenant_schema(tenant_id=tenant_id)
    engine = get_engine()
    with tenant_context(schema):
        with engine.begin() as conn:
            row = branding_repo.get_branding(conn, tenant_id=tenant_id)

    if row.logo_path is None:
        raise HTTPException(status_code=404, detail="no logo set")
    content = logo_io.read_logo(row.logo_path)
    if content is None:
        raise HTTPException(status_code=410, detail="logo file missing on disk")

    ext = row.logo_path.rsplit(".", 1)[-1] if "." in row.logo_path else "png"
    return Response(
        content=content,
        media_type=logo_io.content_type_for(ext),
        headers={"Cache-Control": "no-store"},
    )
