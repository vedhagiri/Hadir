"""Schedule runner — APScheduler interval job + ``run_schedule_now``.

Every minute the runner scans every tenant schema for active
``report_schedules`` rows whose ``next_run_at <= now()`` and runs
each. ``run_schedule_now`` is the same engine called from the
"Run now" admin button.

The engine is intentionally narrow:

1. Insert a ``report_runs`` row with status=``running`` so a crash
   leaves an audit trail.
2. Build the report (XLSX or PDF).
3. Decide attach-vs-link based on the size cap.
4. Render the email body via Jinja, send via the configured
   provider.
5. Update the run row to ``succeeded`` / ``failed`` and bump the
   schedule's ``last_run_*`` + ``next_run_at``.

The runner stays inside ``tenant_context(...)`` blocks per tenant —
same pattern as the attendance scheduler.
"""

from __future__ import annotations

import logging
import threading
import uuid as uuid_lib
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from croniter import croniter
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection

from hadir.attendance.repository import load_tenant_settings
from hadir.config import get_settings
from hadir.db import (
    email_config as email_config_t,
    get_engine,
    make_admin_engine,
    report_runs,
    report_schedules,
    tenant_branding,
    tenant_context,
    tenants,
)
from hadir.branding.constants import (
    DEFAULT_FONT_KEY,
    DEFAULT_PRIMARY_COLOR_KEY,
    FONT_OPTIONS,
)
from hadir.emailing.providers import (
    EmailMessage,
    SenderConfig,
    get_sender,
)
from hadir.emailing.render import render_report_email_html
from hadir.emailing.secrets import decrypt_secret
from hadir.reporting.attendance import build_xlsx
from hadir.reporting.pdf import HEX_PALETTE, build_pdf
from hadir.scheduled_reports.signed_url import build_download_url, make_token
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_JOB_ID = "report-runner-tick"


# ---------------------------------------------------------------------------
# Cron helpers
# ---------------------------------------------------------------------------


def compute_next_run(
    cron_expr: str, *, after: Optional[datetime] = None
) -> datetime:
    base = after or datetime.now(timezone.utc)
    itr = croniter(cron_expr, base)
    nxt = itr.get_next(datetime)
    # croniter returns a tz-aware datetime when ``base`` is tz-aware.
    if nxt.tzinfo is None:
        nxt = nxt.replace(tzinfo=timezone.utc)
    return nxt


# ---------------------------------------------------------------------------
# Building the report
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _BuiltReport:
    bytes_: bytes
    filename: str
    content_type: str
    row_count: int
    range_start: date
    range_end: date


def _build_report_for_schedule(
    conn: Connection, scope: TenantScope, *, schedule_row, tenant_slug: str
) -> _BuiltReport:
    fc = schedule_row.filter_config or {}
    window_days = int(fc.get("window_days", 7))
    department_id = fc.get("department_id")
    employee_id = fc.get("employee_id")

    # Use the tenant's own timezone for the range cutoff so a
    # 09:00-Asia/Muscat schedule's "yesterday" doesn't slip
    # depending on container TZ.
    settings = load_tenant_settings(conn, scope)
    tz = settings.weekend_days  # not the right object — use the same load helper
    # ``load_tenant_settings`` returns the timezone string in
    # ``.timezone``; convert to ZoneInfo via ``local_tz_for``.
    from hadir.attendance.repository import local_tz_for  # noqa: PLC0415

    today_local = datetime.now(timezone.utc).astimezone(
        local_tz_for(settings)
    ).date()
    end = today_local
    start = end - timedelta(days=max(0, window_days - 1))

    department_ids = [int(department_id)] if department_id else None

    fmt = str(schedule_row.format)
    if fmt == "xlsx":
        data, rows = build_xlsx(
            conn,
            scope,
            start_date=start,
            end_date=end,
            department_ids=department_ids,
            employee_id=int(employee_id) if employee_id else None,
        )
        content_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        ext = "xlsx"
    elif fmt == "pdf":
        data, rows = build_pdf(
            conn,
            scope,
            start_date=start,
            end_date=end,
            department_ids=department_ids,
            employee_id=int(employee_id) if employee_id else None,
            generated_by_email="scheduled-runner@hadir",
        )
        content_type = "application/pdf"
        ext = "pdf"
    else:
        raise ValueError(f"unknown report format: {fmt!r}")

    filename = (
        f"hadir-attendance-{tenant_slug}-{start.isoformat()}"
        f"-to-{end.isoformat()}.{ext}"
    )
    return _BuiltReport(
        bytes_=data,
        filename=filename,
        content_type=content_type,
        row_count=rows,
        range_start=start,
        range_end=end,
    )


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _store_file(*, scope: TenantScope, data: bytes, ext: str) -> Path:
    settings = get_settings()
    base = Path(settings.report_output_root) / str(scope.tenant_id) / "runs"
    base.mkdir(parents=True, exist_ok=True)
    fname = f"{uuid_lib.uuid4().hex}.{ext}"
    path = base / fname
    path.write_bytes(data)
    return path


def _read_email_config(conn: Connection, *, tenant_id: int) -> Optional[SenderConfig]:
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
        ).where(email_config_t.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        return None
    return SenderConfig(
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


def _branding_for_email(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(
            tenant_branding.c.primary_color_key,
            tenant_branding.c.font_key,
        ).where(tenant_branding.c.tenant_id == tenant_id)
    ).first()
    primary_key = (
        str(row.primary_color_key) if row is not None else DEFAULT_PRIMARY_COLOR_KEY
    )
    font_key = (
        str(row.font_key) if row is not None else DEFAULT_FONT_KEY
    )
    palette = HEX_PALETTE.get(primary_key, HEX_PALETTE[DEFAULT_PRIMARY_COLOR_KEY])
    font_family = FONT_OPTIONS.get(font_key, FONT_OPTIONS[DEFAULT_FONT_KEY])
    return {
        "accent_hex": palette["accent"],
        "accent_soft_hex": palette["soft"],
        "font_family": font_family,
    }


def _tenant_summary(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(tenants.c.id, tenants.c.name, tenants.c.schema_name).where(
            tenants.c.id == tenant_id
        )
    ).first()
    assert row is not None
    return {
        "id": int(row.id),
        "name": str(row.name),
        "schema_name": str(row.schema_name),
    }


# ---------------------------------------------------------------------------
# Public engine
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunResult:
    run_id: int
    status: str
    delivery_mode: Optional[str]
    file_path: Optional[str]
    file_size_bytes: int
    recipients_delivered_to: list[str]
    error_message: Optional[str]


def run_schedule_now(*, scope: TenantScope, schedule_id: int) -> RunResult:
    """Execute one schedule end-to-end. Tolerates partial failures:
    even if email delivery throws, the run row is updated with the
    error so the operator can retry.

    Caller is responsible for setting ``tenant_context`` (the runner
    background loop does this; the API handler wraps via the
    middleware).
    """

    engine = get_engine()
    settings = get_settings()
    now = datetime.now(timezone.utc)

    # 1) Insert running row.
    with engine.begin() as conn:
        sched = conn.execute(
            select(
                report_schedules.c.id,
                report_schedules.c.tenant_id,
                report_schedules.c.name,
                report_schedules.c.format,
                report_schedules.c.report_type,
                report_schedules.c.filter_config,
                report_schedules.c.recipients,
                report_schedules.c.schedule_cron,
                report_schedules.c.active,
            ).where(
                report_schedules.c.id == schedule_id,
                report_schedules.c.tenant_id == scope.tenant_id,
            )
        ).first()
        if sched is None:
            raise ValueError(f"schedule {schedule_id} not found in scope")
        run_id = int(
            conn.execute(
                insert(report_runs)
                .values(
                    tenant_id=scope.tenant_id,
                    schedule_id=schedule_id,
                    status="running",
                )
                .returning(report_runs.c.id)
            ).scalar_one()
        )
        tenant_info = _tenant_summary(conn, tenant_id=scope.tenant_id)
        sender_cfg = _read_email_config(conn, tenant_id=scope.tenant_id)
        branding_ctx = _branding_for_email(conn, tenant_id=scope.tenant_id)

    # 2) Build + persist + send.
    error: Optional[str] = None
    delivery_mode: Optional[str] = None
    file_path: Optional[str] = None
    size_bytes = 0
    delivered_to: list[str] = []
    try:
        with engine.begin() as conn:
            built = _build_report_for_schedule(
                conn,
                scope,
                schedule_row=sched,
                tenant_slug=tenant_info["schema_name"],
            )
        size_bytes = len(built.bytes_)
        ext = built.filename.rsplit(".", 1)[-1]
        stored = _store_file(scope=scope, data=built.bytes_, ext=ext)
        file_path = str(stored)

        recipients = list(sched.recipients or [])
        if not recipients:
            raise RuntimeError("schedule has no recipients")
        if sender_cfg is None or not sender_cfg.enabled:
            raise RuntimeError(
                "email is not configured / enabled for this tenant"
            )

        # ``email_attachment_max_mb=0`` is a valid operator choice
        # ("never attach, always send a link") — don't clamp it up.
        max_bytes = max(0, settings.email_attachment_max_mb) * 1024 * 1024
        if max_bytes > 0 and size_bytes <= max_bytes:
            delivery_mode = "attached"
            attachments = (
                (built.filename, built.content_type, built.bytes_),
            )
            download_url = None
            ttl_label = ""
        else:
            delivery_mode = "link"
            token = make_token(run_id=run_id)
            base_url = (
                settings.oidc_redirect_base_url.rstrip("/")
                if settings.oidc_redirect_base_url
                else "http://localhost:8000"
            )
            download_url = build_download_url(
                base_url=base_url, run_id=run_id, token=token
            )
            ttl_label = f"{settings.report_signed_url_ttl_days} days"
            attachments = ()

        subject = (
            f"{tenant_info['name']} attendance report — "
            f"{built.range_start.isoformat()} to {built.range_end.isoformat()}"
        )
        html = render_report_email_html(
            context={
                "subject": subject,
                "tenant": tenant_info,
                "branding": branding_ctx,
                "schedule": {
                    "name": str(sched.name),
                    "report_type": str(sched.report_type),
                    "format": str(sched.format),
                },
                "run": {
                    "id": run_id,
                    "started_at_label": now.strftime("%Y-%m-%d %H:%M UTC"),
                    "generated_at_label": now.strftime(
                        "%Y-%m-%d %H:%M UTC"
                    ),
                    "range_label": (
                        f"{built.range_start.isoformat()} – "
                        f"{built.range_end.isoformat()}"
                    ),
                    "status_label": "succeeded",
                    "row_count": built.row_count,
                },
                "delivery": {
                    "mode": delivery_mode,
                    "filename": built.filename,
                    "size_label": _format_size(size_bytes),
                    "download_url": download_url,
                    "ttl_label": ttl_label,
                },
            }
        )
        text = (
            f"{subject}\n"
            f"Range: {built.range_start} – {built.range_end}\n"
            f"Rows: {built.row_count}\n"
            + (
                f"Download: {download_url}\n"
                if delivery_mode == "link"
                else f"See attached {built.filename}.\n"
            )
        )

        message = EmailMessage(
            subject=subject,
            html=html,
            text=text,
            to=tuple(recipients),
            from_address=sender_cfg.from_address or "no-reply@example.com",
            from_name=sender_cfg.from_name,
            attachments=attachments,
        )
        sender = get_sender(sender_cfg)
        sender.send(message)
        delivered_to = list(recipients)
    except Exception as exc:  # noqa: BLE001
        # Operator-safe message (no stack trace, no secret echoes).
        error = type(exc).__name__ + ": " + str(exc)[:500]
        logger.warning(
            "scheduled report run failed: tenant=%s schedule=%s err=%s",
            scope.tenant_id,
            schedule_id,
            type(exc).__name__,
        )

    # 3) Finalise.
    finished = datetime.now(timezone.utc)
    status = "succeeded" if error is None else "failed"
    next_run = compute_next_run(str(sched.schedule_cron), after=finished)
    with engine.begin() as conn:
        conn.execute(
            update(report_runs)
            .where(report_runs.c.id == run_id)
            .values(
                finished_at=finished,
                status=status,
                file_path=file_path,
                file_size_bytes=size_bytes if file_path else None,
                recipients_delivered_to=delivered_to,
                error_message=error,
                delivery_mode=delivery_mode,
            )
        )
        conn.execute(
            update(report_schedules)
            .where(report_schedules.c.id == schedule_id)
            .values(
                last_run_at=finished,
                last_run_status=status,
                next_run_at=next_run,
                updated_at=finished,
            )
        )
    return RunResult(
        run_id=run_id,
        status=status,
        delivery_mode=delivery_mode,
        file_path=file_path,
        file_size_bytes=size_bytes,
        recipients_delivered_to=delivered_to,
        error_message=error,
    )


def _format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


# ---------------------------------------------------------------------------
# Background scanner — picks up due schedules across every tenant.
# ---------------------------------------------------------------------------


def _tick() -> int:
    """Scan every tenant schema for due schedules and run them.

    This same tick also drives the P19 ERP file-drop runner so we
    don't run two APScheduler instances side-by-side.
    """

    # P19 ERP exports — independent of schedules but on the same
    # cadence. Failures are caught + logged inside ``tick_due_exports``;
    # they never break the scheduled-report scan below.
    try:
        from hadir.erp_export.runner import tick_due_exports  # noqa: PLC0415

        tick_due_exports()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "erp export tick raised before per-tenant scan: %s",
            type(exc).__name__,
        )

    # P20 camera-unreachable watcher — emits one ``camera_unreachable``
    # notification per outage. Dedupe + threshold logic live in the
    # watcher itself.
    try:
        from hadir.notifications.camera_watch import (  # noqa: PLC0415
            tick_camera_unreachable,
        )

        tick_camera_unreachable()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "camera-unreachable tick raised before per-tenant scan: %s",
            type(exc).__name__,
        )

    fired = 0
    admin_engine = make_admin_engine()
    try:
        # Public is what the global tenants table lives in;
        # passing it as the tenant context keeps the multi-mode
        # checkout listener happy for this cross-tenant scan.
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                tenant_rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).where(
                        tenants.c.status == "active"
                    )
                ).all()
    finally:
        admin_engine.dispose()

    now = datetime.now(timezone.utc)
    for tenant_row in tenant_rows:
        scope = TenantScope(tenant_id=int(tenant_row.id))
        try:
            with tenant_context(str(tenant_row.schema_name)):
                with get_engine().begin() as conn:
                    due = conn.execute(
                        select(
                            report_schedules.c.id,
                            report_schedules.c.next_run_at,
                        )
                        .where(
                            report_schedules.c.tenant_id == scope.tenant_id,
                            report_schedules.c.active.is_(True),
                            report_schedules.c.next_run_at.isnot(None),
                            report_schedules.c.next_run_at <= now,
                        )
                        .order_by(report_schedules.c.next_run_at.asc())
                    ).all()
                for row in due:
                    try:
                        run_schedule_now(
                            scope=scope, schedule_id=int(row.id)
                        )
                        fired += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "scheduled run dispatch failed: tenant=%s "
                            "schedule=%s err=%s",
                            scope.tenant_id,
                            row.id,
                            type(exc).__name__,
                        )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "scheduler scan failed for tenant %s: %s",
                tenant_row.schema_name,
                type(exc).__name__,
            )
    return fired


class ReportRunner:
    """Thin supervisor for the periodic dispatch job."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: Optional[BackgroundScheduler] = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            settings = get_settings()
            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(
                _tick,
                "interval",
                seconds=settings.report_runner_poll_seconds,
                id=_JOB_ID,
                replace_existing=True,
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info(
                "report runner started: interval=%ds",
                settings.report_runner_poll_seconds,
            )

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


report_runner = ReportRunner()
