"""ERP export runner.

``run_export_now`` is the engine called from the API "Run now"
button and from the periodic tick. The tick (``tick_due_exports``)
slots into the existing 60-second scheduler in
``hadir.scheduled_reports.runner._tick`` so we don't run two
APScheduler instances side-by-side.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from croniter import croniter
from sqlalchemy import select, update
from sqlalchemy.engine import Connection

from hadir.attendance.repository import load_tenant_settings, local_tz_for
from hadir.config import get_settings
from hadir.db import (
    erp_export_config,
    get_engine,
    make_admin_engine,
    tenant_context,
    tenants,
)
from hadir.erp_export.builder import (
    ExportRow,
    fetch_rows,
    filename_for,
    get_tenant_slug,
    render_csv,
    render_json,
)
from hadir.erp_export.paths import UnsafeOutputPath, resolve_safe_dir
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ExportResult:
    status: str  # 'succeeded' | 'failed'
    file_path: Optional[Path]
    file_bytes: Optional[bytes]
    row_count: int
    error_message: Optional[str]
    range_start: Optional[date]
    range_end: Optional[date]
    filename: Optional[str]


def _compute_next_run(cron_expr: str, *, after: datetime) -> datetime:
    nxt = croniter(cron_expr, after).get_next(datetime)
    if nxt.tzinfo is None:
        nxt = nxt.replace(tzinfo=timezone.utc)
    return nxt


def _read_config(conn: Connection, *, tenant_id: int):
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
            erp_export_config.c.next_run_at,
        ).where(erp_export_config.c.tenant_id == tenant_id)
    ).first()


def run_export_now(*, scope: TenantScope) -> ExportResult:
    """Build + write the ERP file for ``scope`` using the saved config.

    Returns the result + the file bytes so the API "Run now" handler
    can stream them to the operator's browser. The persisted file is
    always written to disk under ``{erp_export_root}/{tenant_id}/``.
    """

    engine = get_engine()
    error: Optional[str] = None
    file_path: Optional[Path] = None
    file_bytes: Optional[bytes] = None
    row_count = 0
    rng_start: Optional[date] = None
    rng_end: Optional[date] = None
    filename: Optional[str] = None
    finished_status = "failed"

    try:
        with engine.begin() as conn:
            cfg = _read_config(conn, tenant_id=scope.tenant_id)
            if cfg is None:
                raise RuntimeError("erp_export_config row not found")
            settings = load_tenant_settings(conn, scope)
            tenant_slug = get_tenant_slug(conn, tenant_id=scope.tenant_id)

        tz = local_tz_for(settings)
        now_local = datetime.now(timezone.utc).astimezone(tz)
        rng_end = now_local.date()
        rng_start = rng_end - timedelta(days=max(0, int(cfg.window_days) - 1))

        # Resolve safe output directory.
        safe_dir = resolve_safe_dir(
            tenant_id=scope.tenant_id, raw=str(cfg.output_path or "")
        )
        safe_dir.mkdir(parents=True, exist_ok=True)

        fmt = str(cfg.format)
        if fmt not in ("csv", "json"):
            raise RuntimeError(f"unknown format {fmt!r}")
        now_utc = datetime.now(timezone.utc)
        filename = filename_for(fmt=fmt, now=now_utc)
        file_path = safe_dir / filename

        with engine.begin() as conn:
            rows = fetch_rows(
                conn,
                scope,
                start_date=rng_start,
                end_date=rng_end,
                tenant_slug=tenant_slug,
            )
        row_count = len(rows)

        if fmt == "csv":
            file_bytes = render_csv(rows)
        else:
            metadata = {
                "tenant_slug": tenant_slug,
                "generated_at": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "range_start": rng_start.isoformat(),
                "range_end": rng_end.isoformat(),
                "row_count": row_count,
                "schema_version": 1,
            }
            file_bytes = render_json(rows, metadata=metadata)

        file_path.write_bytes(file_bytes)
        finished_status = "succeeded"
    except UnsafeOutputPath as exc:
        error = f"unsafe output_path: {exc}"
        logger.warning(
            "erp export rejected unsafe path: tenant=%s detail=%s",
            scope.tenant_id,
            exc,
        )
    except Exception as exc:  # noqa: BLE001
        error = type(exc).__name__ + ": " + str(exc)[:500]
        logger.warning(
            "erp export run failed: tenant=%s err=%s",
            scope.tenant_id,
            type(exc).__name__,
        )

    finished = datetime.now(timezone.utc)
    # Advance next_run_at when we have a cron.
    next_run: Optional[datetime] = None
    with engine.begin() as conn:
        cfg = _read_config(conn, tenant_id=scope.tenant_id)
    if cfg is not None and cfg.schedule_cron:
        try:
            next_run = _compute_next_run(
                str(cfg.schedule_cron), after=finished
            )
        except Exception:  # noqa: BLE001
            next_run = None

    with engine.begin() as conn:
        conn.execute(
            update(erp_export_config)
            .where(erp_export_config.c.tenant_id == scope.tenant_id)
            .values(
                last_run_at=finished,
                last_run_status=finished_status,
                last_run_path=str(file_path) if file_path is not None else None,
                last_run_error=error,
                next_run_at=next_run,
                updated_at=finished,
            )
        )

    return ExportResult(
        status=finished_status,
        file_path=file_path if finished_status == "succeeded" else None,
        file_bytes=file_bytes if finished_status == "succeeded" else None,
        row_count=row_count,
        error_message=error,
        range_start=rng_start,
        range_end=rng_end,
        filename=filename,
    )


def tick_due_exports() -> int:
    """Scan every tenant for due ERP exports and run each.

    Called by the existing ``hadir.scheduled_reports.runner._tick``
    so we don't duplicate the scheduler infrastructure. Returns the
    number of tenants whose export fired this tick.
    """

    now = datetime.now(timezone.utc)
    fired = 0
    admin_engine = make_admin_engine()
    try:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                tenant_rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).where(
                        tenants.c.status == "active"
                    )
                ).all()
    finally:
        admin_engine.dispose()

    for tr in tenant_rows:
        scope = TenantScope(tenant_id=int(tr.id))
        try:
            with tenant_context(str(tr.schema_name)):
                with get_engine().begin() as conn:
                    row = conn.execute(
                        select(
                            erp_export_config.c.enabled,
                            erp_export_config.c.next_run_at,
                            erp_export_config.c.schedule_cron,
                        ).where(
                            erp_export_config.c.tenant_id == scope.tenant_id
                        )
                    ).first()
                if row is None:
                    continue
                if not row.enabled or not row.schedule_cron:
                    continue
                if row.next_run_at is None or row.next_run_at > now:
                    continue
                run_export_now(scope=scope)
                fired += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "erp export tick failed for tenant %s: %s",
                tr.schema_name,
                type(exc).__name__,
            )
    return fired
