"""FastAPI router for scheduled reports + email config + signed-URL
download.

Endpoints exposed (Admin-only writes; the signed-URL endpoint is
intentionally anonymous — operator-shareable token is the gate):

* ``GET   /api/email-config``                        — Admin
* ``PATCH /api/email-config``                        — Admin
* ``POST  /api/email-config/test``                   — Admin
* ``GET   /api/report-schedules``                    — Admin / HR
* ``POST  /api/report-schedules``                    — Admin
* ``PATCH /api/report-schedules/{id}``               — Admin
* ``DELETE /api/report-schedules/{id}``              — Admin
* ``POST  /api/report-schedules/{id}/run-now``       — Admin
* ``GET   /api/report-runs?schedule_id=...``         — Admin / HR
* ``GET   /api/reports/runs/{run_id}/download``      — Anonymous (token)
"""

from __future__ import annotations

import logging
import threading
import time as time_mod
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import insert, select, update

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import (
    CurrentUser,
    current_user,
    require_any_role,
    require_role,
)
from hadir.config import get_settings
from hadir.db import (
    email_config as email_config_t,
    get_engine,
    report_runs,
    report_schedules,
    tenants,
)
from hadir.emailing.providers import (
    EmailMessage,
    SenderConfig,
    get_sender,
)
from hadir.emailing.render import render_report_email_html
from hadir.emailing.secrets import decrypt_secret, encrypt_secret
from hadir.scheduled_reports.runner import (
    compute_next_run,
    run_schedule_now,
)
from hadir.scheduled_reports.schemas import (
    EmailConfigResponse,
    EmailConfigUpdateRequest,
    ReportFilterConfig,
    ReportRunResponse,
    ReportScheduleCreateRequest,
    ReportSchedulePatchRequest,
    ReportScheduleResponse,
    TestEmailRequest,
)
from hadir.scheduled_reports.signed_url import TokenError, validate_token
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["scheduled-reports"])

ADMIN = Depends(require_role("Admin"))
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
USER = Depends(current_user)


# ---------------------------------------------------------------------------
# Email config
# ---------------------------------------------------------------------------


def _email_config_response(row) -> EmailConfigResponse:
    return EmailConfigResponse(
        tenant_id=int(row.tenant_id),
        provider=str(row.provider),  # type: ignore[arg-type]
        smtp_host=str(row.smtp_host or ""),
        smtp_port=int(row.smtp_port),
        smtp_username=str(row.smtp_username or ""),
        smtp_use_tls=bool(row.smtp_use_tls),
        has_smtp_password=bool(row.smtp_password_encrypted),
        graph_tenant_id=str(row.graph_tenant_id or ""),
        graph_client_id=str(row.graph_client_id or ""),
        has_graph_client_secret=bool(row.graph_client_secret_encrypted),
        from_address=str(row.from_address or ""),
        from_name=str(row.from_name or ""),
        enabled=bool(row.enabled),
        updated_at=row.updated_at.isoformat()
        if row.updated_at is not None
        else "",
    )


def _read_email_row(conn, *, tenant_id: int):
    row = conn.execute(
        select(
            email_config_t.c.tenant_id,
            email_config_t.c.provider,
            email_config_t.c.smtp_host,
            email_config_t.c.smtp_port,
            email_config_t.c.smtp_username,
            email_config_t.c.smtp_password_encrypted,
            email_config_t.c.smtp_use_tls,
            email_config_t.c.graph_tenant_id,
            email_config_t.c.graph_client_id,
            email_config_t.c.graph_client_secret_encrypted,
            email_config_t.c.from_address,
            email_config_t.c.from_name,
            email_config_t.c.enabled,
            email_config_t.c.updated_at,
        ).where(email_config_t.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        # Lazy-create if absent (e.g. tenant pre-dating P18 seed).
        conn.execute(insert(email_config_t).values(tenant_id=tenant_id))
        row = conn.execute(
            select(
                email_config_t.c.tenant_id,
                email_config_t.c.provider,
                email_config_t.c.smtp_host,
                email_config_t.c.smtp_port,
                email_config_t.c.smtp_username,
                email_config_t.c.smtp_password_encrypted,
                email_config_t.c.smtp_use_tls,
                email_config_t.c.graph_tenant_id,
                email_config_t.c.graph_client_id,
                email_config_t.c.graph_client_secret_encrypted,
                email_config_t.c.from_address,
                email_config_t.c.from_name,
                email_config_t.c.enabled,
                email_config_t.c.updated_at,
            ).where(email_config_t.c.tenant_id == tenant_id)
        ).first()
    return row


@router.get("/api/email-config", response_model=EmailConfigResponse)
def get_email_config(
    user: Annotated[CurrentUser, ADMIN],
) -> EmailConfigResponse:
    with get_engine().begin() as conn:
        row = _read_email_row(conn, tenant_id=user.tenant_id)
    return _email_config_response(row)


@router.patch("/api/email-config", response_model=EmailConfigResponse)
def patch_email_config(
    payload: EmailConfigUpdateRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> EmailConfigResponse:
    provided = payload.model_dump(exclude_unset=True)
    values: dict = {}
    if "provider" in provided:
        values["provider"] = provided["provider"]
    for key in (
        "smtp_host",
        "smtp_port",
        "smtp_username",
        "smtp_use_tls",
        "graph_tenant_id",
        "graph_client_id",
        "from_address",
        "from_name",
        "enabled",
    ):
        if key in provided:
            values[key] = provided[key]

    # Secrets — empty string means "leave alone"; non-empty rotates.
    if "smtp_password" in provided:
        new = provided["smtp_password"] or ""
        if new:
            values["smtp_password_encrypted"] = encrypt_secret(new)
    if "graph_client_secret" in provided:
        new = provided["graph_client_secret"] or ""
        if new:
            values["graph_client_secret_encrypted"] = encrypt_secret(new)

    with get_engine().begin() as conn:
        _read_email_row(conn, tenant_id=user.tenant_id)  # ensure row exists
        if values:
            values["updated_at"] = datetime.now(timezone.utc)
            conn.execute(
                update(email_config_t)
                .where(email_config_t.c.tenant_id == user.tenant_id)
                .values(**values)
            )
        # Audit — never log the raw secrets. Record what *kind* of
        # change happened so an operator can trace a rotation.
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="email_config.updated",
            entity_type="email_config",
            after={
                "fields_changed": sorted(
                    k for k in values.keys() if k != "updated_at"
                ),
                "smtp_password_rotated": "smtp_password_encrypted" in values,
                "graph_client_secret_rotated": (
                    "graph_client_secret_encrypted" in values
                ),
            },
        )
        row = _read_email_row(conn, tenant_id=user.tenant_id)
    return _email_config_response(row)


@router.post("/api/email-config/test")
def send_test_email(
    payload: TestEmailRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> dict:
    with get_engine().begin() as conn:
        row = _read_email_row(conn, tenant_id=user.tenant_id)
    sender_cfg = SenderConfig(
        provider=str(row.provider),
        smtp_host=str(row.smtp_host or ""),
        smtp_port=int(row.smtp_port),
        smtp_username=str(row.smtp_username or ""),
        smtp_password=decrypt_secret(row.smtp_password_encrypted),
        smtp_use_tls=bool(row.smtp_use_tls),
        graph_tenant_id=str(row.graph_tenant_id or ""),
        graph_client_id=str(row.graph_client_id or ""),
        graph_client_secret=decrypt_secret(row.graph_client_secret_encrypted),
        from_address=str(row.from_address or ""),
        from_name=str(row.from_name or ""),
        enabled=bool(row.enabled),
    )
    if not sender_cfg.from_address:
        raise HTTPException(
            status_code=400,
            detail="set a from_address before sending a test email",
        )
    sender = get_sender(sender_cfg)
    html = render_report_email_html(
        context={
            "subject": "Hadir test email",
            "tenant": {"name": "Hadir"},
            "branding": {
                "accent_hex": "#117a7a",
                "accent_soft_hex": "#e6f5f5",
                "font_family": "Arial, Helvetica, sans-serif",
            },
            "schedule": {
                "name": "Test",
                "report_type": "attendance",
                "format": "pdf",
            },
            "run": {
                "id": 0,
                "started_at_label": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%d %H:%M UTC"
                ),
                "generated_at_label": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%d %H:%M UTC"
                ),
                "range_label": "—",
                "status_label": "test",
                "row_count": None,
            },
            "delivery": {
                "mode": "attached",
                "filename": "test.txt",
                "size_label": "0 B",
                "download_url": None,
                "ttl_label": "",
            },
        }
    )
    message = EmailMessage(
        subject="Hadir email configuration test",
        html=html,
        text="This is a test from Hadir's email configuration page.",
        to=(payload.to,),
        from_address=sender_cfg.from_address,
        from_name=sender_cfg.from_name,
    )
    try:
        sender.send(message)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "test email failed: provider=%s err=%s",
            sender_cfg.provider,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail=f"could not deliver test email: {type(exc).__name__}",
        ) from exc

    with get_engine().begin() as conn:
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="email_config.test_sent",
            entity_type="email_config",
            after={"to": str(payload.to)},
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Report schedules
# ---------------------------------------------------------------------------


def _schedule_response(row) -> ReportScheduleResponse:
    fc = row.filter_config or {}
    return ReportScheduleResponse(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        name=str(row.name),
        report_type=str(row.report_type),  # type: ignore[arg-type]
        format=str(row.format),  # type: ignore[arg-type]
        filter_config=ReportFilterConfig(**fc) if fc else ReportFilterConfig(),
        recipients=list(row.recipients or []),
        schedule_cron=str(row.schedule_cron),
        active=bool(row.active),
        last_run_at=row.last_run_at,
        last_run_status=row.last_run_status,
        next_run_at=row.next_run_at,
        created_by_user_id=row.created_by_user_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


_SCHEDULE_COLS = (
    report_schedules.c.id,
    report_schedules.c.tenant_id,
    report_schedules.c.name,
    report_schedules.c.report_type,
    report_schedules.c.format,
    report_schedules.c.filter_config,
    report_schedules.c.recipients,
    report_schedules.c.schedule_cron,
    report_schedules.c.active,
    report_schedules.c.last_run_at,
    report_schedules.c.last_run_status,
    report_schedules.c.next_run_at,
    report_schedules.c.created_by_user_id,
    report_schedules.c.created_at,
    report_schedules.c.updated_at,
)


@router.get(
    "/api/report-schedules", response_model=list[ReportScheduleResponse]
)
def list_schedules(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> list[ReportScheduleResponse]:
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(*_SCHEDULE_COLS)
            .where(report_schedules.c.tenant_id == user.tenant_id)
            .order_by(report_schedules.c.id.asc())
        ).all()
    return [_schedule_response(r) for r in rows]


@router.post(
    "/api/report-schedules",
    response_model=ReportScheduleResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_schedule(
    payload: ReportScheduleCreateRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> ReportScheduleResponse:
    next_run = compute_next_run(payload.schedule_cron)
    with get_engine().begin() as conn:
        new_id = int(
            conn.execute(
                insert(report_schedules)
                .values(
                    tenant_id=user.tenant_id,
                    name=payload.name,
                    report_type=payload.report_type,
                    format=payload.format,
                    filter_config=payload.filter_config.model_dump(),
                    recipients=[str(r) for r in payload.recipients],
                    schedule_cron=payload.schedule_cron,
                    active=payload.active,
                    next_run_at=next_run,
                    created_by_user_id=user.id,
                )
                .returning(report_schedules.c.id)
            ).scalar_one()
        )
        row = conn.execute(
            select(*_SCHEDULE_COLS).where(report_schedules.c.id == new_id)
        ).first()
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="report_schedule.created",
            entity_type="report_schedule",
            entity_id=str(new_id),
            after={
                "name": payload.name,
                "format": payload.format,
                "schedule_cron": payload.schedule_cron,
                "recipients_count": len(payload.recipients),
            },
        )
    assert row is not None
    return _schedule_response(row)


@router.patch(
    "/api/report-schedules/{schedule_id}",
    response_model=ReportScheduleResponse,
)
def patch_schedule(
    schedule_id: int,
    payload: ReportSchedulePatchRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> ReportScheduleResponse:
    provided = payload.model_dump(exclude_unset=True)
    values: dict = {}
    for key in ("name", "format", "schedule_cron", "active"):
        if key in provided:
            values[key] = provided[key]
    if "filter_config" in provided:
        values["filter_config"] = provided["filter_config"]
    if "recipients" in provided:
        values["recipients"] = [str(r) for r in provided["recipients"]]
    if "schedule_cron" in provided:
        values["next_run_at"] = compute_next_run(
            provided["schedule_cron"]
        )

    with get_engine().begin() as conn:
        existing = conn.execute(
            select(report_schedules.c.id).where(
                report_schedules.c.id == schedule_id,
                report_schedules.c.tenant_id == user.tenant_id,
            )
        ).first()
        if existing is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        if values:
            values["updated_at"] = datetime.now(timezone.utc)
            conn.execute(
                update(report_schedules)
                .where(report_schedules.c.id == schedule_id)
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=user.tenant_id,
                actor_user_id=user.id,
                action="report_schedule.updated",
                entity_type="report_schedule",
                entity_id=str(schedule_id),
                after={
                    "fields_changed": sorted(
                        k for k in values.keys() if k != "updated_at"
                    )
                },
            )
        row = conn.execute(
            select(*_SCHEDULE_COLS).where(
                report_schedules.c.id == schedule_id
            )
        ).first()
    assert row is not None
    return _schedule_response(row)


@router.delete(
    "/api/report-schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_schedule(
    schedule_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    with get_engine().begin() as conn:
        existing = conn.execute(
            select(report_schedules.c.id, report_schedules.c.name).where(
                report_schedules.c.id == schedule_id,
                report_schedules.c.tenant_id == user.tenant_id,
            )
        ).first()
        if existing is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        conn.execute(
            report_schedules.delete().where(
                report_schedules.c.id == schedule_id
            )
        )
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="report_schedule.deleted",
            entity_type="report_schedule",
            entity_id=str(schedule_id),
            before={"name": str(existing.name)},
        )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post(
    "/api/report-schedules/{schedule_id}/run-now",
    response_model=ReportRunResponse,
)
def run_now(
    schedule_id: int,
    user: Annotated[CurrentUser, ADMIN],
) -> ReportRunResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    try:
        result = run_schedule_now(scope=scope, schedule_id=schedule_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    with get_engine().begin() as conn:
        run_row = conn.execute(
            select(
                report_runs.c.id,
                report_runs.c.tenant_id,
                report_runs.c.schedule_id,
                report_runs.c.started_at,
                report_runs.c.finished_at,
                report_runs.c.status,
                report_runs.c.file_size_bytes,
                report_runs.c.recipients_delivered_to,
                report_runs.c.error_message,
                report_runs.c.delivery_mode,
            ).where(report_runs.c.id == result.run_id)
        ).first()
        write_audit(
            conn,
            tenant_id=user.tenant_id,
            actor_user_id=user.id,
            action="report_schedule.run_now",
            entity_type="report_schedule",
            entity_id=str(schedule_id),
            after={
                "run_id": result.run_id,
                "status": result.status,
                "delivery_mode": result.delivery_mode,
            },
        )
    assert run_row is not None
    return ReportRunResponse(
        id=int(run_row.id),
        tenant_id=int(run_row.tenant_id),
        schedule_id=run_row.schedule_id,
        started_at=run_row.started_at,
        finished_at=run_row.finished_at,
        status=str(run_row.status),  # type: ignore[arg-type]
        file_size_bytes=run_row.file_size_bytes,
        recipients_delivered_to=list(run_row.recipients_delivered_to or []),
        error_message=run_row.error_message,
        delivery_mode=run_row.delivery_mode,
    )


# ---------------------------------------------------------------------------
# Runs list
# ---------------------------------------------------------------------------


@router.get("/api/report-runs", response_model=list[ReportRunResponse])
def list_runs(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    schedule_id: Annotated[Optional[int], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[ReportRunResponse]:
    stmt = (
        select(
            report_runs.c.id,
            report_runs.c.tenant_id,
            report_runs.c.schedule_id,
            report_runs.c.started_at,
            report_runs.c.finished_at,
            report_runs.c.status,
            report_runs.c.file_size_bytes,
            report_runs.c.recipients_delivered_to,
            report_runs.c.error_message,
            report_runs.c.delivery_mode,
        )
        .where(report_runs.c.tenant_id == user.tenant_id)
        .order_by(report_runs.c.id.desc())
        .limit(limit)
    )
    if schedule_id is not None:
        stmt = stmt.where(report_runs.c.schedule_id == schedule_id)
    with get_engine().begin() as conn:
        rows = conn.execute(stmt).all()
    return [
        ReportRunResponse(
            id=int(r.id),
            tenant_id=int(r.tenant_id),
            schedule_id=r.schedule_id,
            started_at=r.started_at,
            finished_at=r.finished_at,
            status=str(r.status),  # type: ignore[arg-type]
            file_size_bytes=r.file_size_bytes,
            recipients_delivered_to=list(r.recipients_delivered_to or []),
            error_message=r.error_message,
            delivery_mode=r.delivery_mode,
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Signed-URL download — anonymous, token-gated, IP-rate-limited.
# ---------------------------------------------------------------------------


_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, deque] = defaultdict(deque)


def _rate_limit_check(*, ip: str) -> None:
    settings = get_settings()
    limit = max(1, int(settings.report_signed_url_rate_limit_per_minute))
    now = time_mod.monotonic()
    cutoff = now - 60.0
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[ip]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(
                status_code=429,
                detail="too many download requests from this IP",
            )
        bucket.append(now)


@router.get(
    "/api/reports/runs/{run_id}/download",
)
def download_run(
    run_id: int,
    request: Request,
    token: str = Query(...),
) -> Response:
    """Stream the report file behind a HMAC token. Anonymous: the
    operator only needs the URL, which the recipient already received
    by email. Per-IP rate limited + audit-logged on every access.

    The download endpoint never resolves a tenant context the
    middleware-way (anonymous). We look the run up across the
    ``report_runs`` rows in the active schema by joining via the
    URL's run_id; the multi-mode middleware refuses without a
    tenant context, so this endpoint is mounted with a ``X-Hadir-
    Tenant`` header derived from the token's run_id → tenant
    lookup. **Pilot simplification:** we resolve the tenant by
    scanning ``public.tenants`` and trying each schema until we
    find the run. That's cheap for pilot scale (<10 tenants) and
    keeps the contract that the URL stands alone.
    """

    settings = get_settings()
    ip = request.client.host if request.client else "unknown"
    _rate_limit_check(ip=ip)

    try:
        validate_token(token, expected_run_id=run_id)
    except TokenError as exc:
        raise HTTPException(status_code=403, detail=exc.detail) from exc

    # Resolve which tenant schema this run lives in. We scan
    # public.tenants and pick the first match — the run_id is
    # tenant-scoped so there's exactly one.
    from hadir.db import (  # noqa: PLC0415
        make_engine,
        tenant_context,
    )

    target_schema: Optional[str] = None
    target_path: Optional[str] = None
    target_tenant_id: Optional[int] = None
    target_size: Optional[int] = None
    # Use the admin engine to enumerate tenants without a tenant
    # context (search_path defaults to ``main`` in single mode).
    from hadir.db import make_admin_engine  # noqa: PLC0415

    admin_engine = make_admin_engine()
    try:
        # ``public`` matches the tenant-schema regex and gives the
        # checkout listener a valid search_path so multi-mode
        # doesn't fail-closed for this anonymous endpoint.
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                tenant_rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).where(
                        tenants.c.status == "active"
                    )
                ).all()
    finally:
        admin_engine.dispose()

    eng = get_engine()
    for tr in tenant_rows:
        with tenant_context(str(tr.schema_name)):
            with eng.begin() as conn:
                row = conn.execute(
                    select(
                        report_runs.c.tenant_id,
                        report_runs.c.file_path,
                        report_runs.c.file_size_bytes,
                        report_runs.c.delivery_mode,
                    ).where(report_runs.c.id == run_id)
                ).first()
                if row is not None:
                    target_schema = str(tr.schema_name)
                    target_tenant_id = int(row.tenant_id)
                    target_path = (
                        str(row.file_path) if row.file_path else None
                    )
                    target_size = (
                        int(row.file_size_bytes)
                        if row.file_size_bytes is not None
                        else None
                    )
                    break

    if target_path is None or target_schema is None or target_tenant_id is None:
        raise HTTPException(status_code=404, detail="run not found")
    p = Path(target_path)
    if not p.is_file():
        raise HTTPException(
            status_code=410, detail="report file is no longer available"
        )

    # Audit access — token presence proves operator authorised the
    # link. We log the IP + run id; never the token.
    with tenant_context(target_schema):
        with eng.begin() as conn:
            write_audit(
                conn,
                tenant_id=target_tenant_id,
                actor_user_id=None,
                action="report.signed_url_downloaded",
                entity_type="report_run",
                entity_id=str(run_id),
                after={"ip": ip, "size_bytes": target_size},
            )

    media_type = (
        "application/pdf"
        if target_path.endswith(".pdf")
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    filename = p.name
    return StreamingResponse(
        _file_streamer(p),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


def _file_streamer(path: Path):
    with path.open("rb") as f:
        while True:
            chunk = f.read(64 * 1024)
            if not chunk:
                break
            yield chunk
