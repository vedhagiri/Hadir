"""FastAPI router for the ERP file-drop config + Run-now endpoint."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from io import BytesIO
from typing import Annotated, Literal, Optional

from croniter import croniter
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.config import get_settings
from maugood.db import erp_export_config, get_engine
from maugood.erp_export.paths import UnsafeOutputPath, resolve_safe_dir, tenant_root
from maugood.erp_export.runner import run_export_now
from maugood.scheduled_reports.runner import compute_next_run
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["erp-export"])
ADMIN = Depends(require_role("Admin"))


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ErpExportConfigResponse(BaseModel):
    tenant_id: int
    enabled: bool
    format: Literal["csv", "json"]
    output_path: str
    schedule_cron: str
    window_days: int
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    last_run_path: Optional[str] = None
    last_run_error: Optional[str] = None
    next_run_at: Optional[datetime] = None
    tenant_root: str


class ErpExportConfigPatch(BaseModel):
    enabled: Optional[bool] = None
    format: Optional[Literal["csv", "json"]] = None
    output_path: Optional[str] = Field(default=None, max_length=1024)
    schedule_cron: Optional[str] = Field(default=None, max_length=200)
    window_days: Optional[int] = Field(default=None, ge=1, le=180)

    @model_validator(mode="after")
    def _check_cron(self) -> "ErpExportConfigPatch":
        if self.schedule_cron is not None and self.schedule_cron.strip():
            try:
                croniter(self.schedule_cron)
            except (ValueError, KeyError) as exc:
                raise ValueError(
                    f"invalid cron expression: {exc}"
                ) from exc
        return self


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_response(row, *, scope: TenantScope) -> ErpExportConfigResponse:  # type: ignore[no-untyped-def]
    return ErpExportConfigResponse(
        tenant_id=int(row.tenant_id),
        enabled=bool(row.enabled),
        format=str(row.format),  # type: ignore[arg-type]
        output_path=str(row.output_path or ""),
        schedule_cron=str(row.schedule_cron or ""),
        window_days=int(row.window_days),
        last_run_at=row.last_run_at,
        last_run_status=row.last_run_status,
        last_run_path=row.last_run_path,
        last_run_error=row.last_run_error,
        next_run_at=row.next_run_at,
        tenant_root=str(tenant_root(tenant_id=scope.tenant_id)),
    )


def _read_row(conn, *, tenant_id: int):
    return conn.execute(
        select(
            erp_export_config.c.tenant_id,
            erp_export_config.c.enabled,
            erp_export_config.c.format,
            erp_export_config.c.output_path,
            erp_export_config.c.schedule_cron,
            erp_export_config.c.window_days,
            erp_export_config.c.last_run_at,
            erp_export_config.c.last_run_status,
            erp_export_config.c.last_run_path,
            erp_export_config.c.last_run_error,
            erp_export_config.c.next_run_at,
        ).where(erp_export_config.c.tenant_id == tenant_id)
    ).first()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/erp-export-config", response_model=ErpExportConfigResponse)
def get_config(user: Annotated[CurrentUser, ADMIN]) -> ErpExportConfigResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = _read_row(conn, tenant_id=user.tenant_id)
    if row is None:
        raise HTTPException(
            status_code=500, detail="erp_export_config row missing"
        )
    return _row_to_response(row, scope=scope)


@router.patch(
    "/api/erp-export-config", response_model=ErpExportConfigResponse
)
def patch_config(
    payload: ErpExportConfigPatch,
    user: Annotated[CurrentUser, ADMIN],
) -> ErpExportConfigResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)
    values: dict = {}
    for key in ("enabled", "format", "schedule_cron", "window_days"):
        if key in provided:
            values[key] = provided[key]

    if "output_path" in provided:
        # Validate the operator-supplied path now so an invalid
        # value never lands in the DB. The runner re-validates on
        # every dispatch (defence in depth).
        try:
            resolve_safe_dir(
                tenant_id=user.tenant_id,
                raw=str(provided["output_path"]),
            )
        except UnsafeOutputPath as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        values["output_path"] = provided["output_path"]

    if "schedule_cron" in provided and provided["schedule_cron"].strip():
        values["next_run_at"] = compute_next_run(
            provided["schedule_cron"]
        )

    with get_engine().begin() as conn:
        if values:
            values["updated_at"] = datetime.now(timezone.utc)
            conn.execute(
                update(erp_export_config)
                .where(
                    erp_export_config.c.tenant_id == user.tenant_id
                )
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=user.tenant_id,
                actor_user_id=user.id,
                action="erp_export.config_updated",
                entity_type="erp_export_config",
                after={
                    "fields_changed": sorted(
                        k for k in values.keys() if k != "updated_at"
                    )
                },
            )
        row = _read_row(conn, tenant_id=user.tenant_id)
    return _row_to_response(row, scope=scope)


@router.post("/api/erp-export-config/run-now")
def run_now(user: Annotated[CurrentUser, ADMIN]) -> Response:
    """Trigger an immediate export. The file is written to disk under
    the tenant root **and** streamed back so the operator can verify
    locally without rummaging through the file-drop directory.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    result = run_export_now(scope=scope)

    with get_engine().begin() as conn:
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action=f"erp_export.run_{result.status}",
            entity_type="erp_export_run",
            after={
                "row_count": result.row_count,
                "filename": result.filename,
                "range_start": (
                    result.range_start.isoformat()
                    if result.range_start
                    else None
                ),
                "range_end": (
                    result.range_end.isoformat() if result.range_end else None
                ),
                "error": result.error_message,
                "file_path": (
                    str(result.file_path)
                    if result.file_path is not None
                    else None
                ),
            },
        )

    if result.status == "failed":
        raise HTTPException(
            status_code=400,
            detail=result.error_message or "erp export failed",
        )

    assert result.file_bytes is not None
    assert result.filename is not None
    media_type = (
        "text/csv" if result.filename.endswith(".csv") else "application/json"
    )
    return StreamingResponse(
        BytesIO(result.file_bytes),
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{result.filename}"'
            ),
            "Content-Length": str(len(result.file_bytes)),
        },
    )
