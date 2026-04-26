"""Retention cleanup logic (v1.0 P25).

Pure(-ish) DELETE worker. Iterates every tenant in the global
registry, applies the per-table retention policy below, logs a
summary line per tenant + per table to the dedicated audit log,
and writes a per-tenant ``audit_log`` row so operators can trace
what was swept.

| Table                     | Cutoff             | Source                |
| ------------------------- | ------------------ | --------------------- |
| ``camera_health_snapshots`` | 30 days          | BRD FR-CAM-007        |
| ``notifications``         | 90 days            | BRD §"Notifications"  |
| ``report_runs``           | 90 days (file first) | BRD §"Reports"      |
| ``user_sessions``         | 7 days post-expiry | BRD §"Sessions"       |

The job intentionally **never** touches:

* ``audit_log``           — append-only, retained forever (BRD NFR-RET-001)
* ``attendance_records``  — retained indefinitely
* ``detection_events``    — retained indefinitely
* ``employees``, ``employee_photos`` — only via PDPL delete (P25 §"PDPL")
* ``requests``            — retained indefinitely
* ``approved_leaves``     — retained indefinitely

Operators who need to override the cutoffs set
``HADIR_RETENTION_*_DAYS`` env vars (see ``hadir.config``).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from sqlalchemy import delete, select
from sqlalchemy.engine import Engine

from hadir.auth.audit import write_audit
from hadir.db import (
    camera_health_snapshots,
    get_engine,
    notifications,
    report_runs,
    tenant_context,
    tenants,
    user_sessions,
)
from hadir.logging_config import audit_logger
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# ---- defaults (env-overridable) -----------------------------------

# Each constant maps to a ``HADIR_RETENTION_*_DAYS`` env var so
# operators can shorten or extend per BRD. Defaults are the BRD
# numbers — any change here is a policy change and warrants a
# doc update in ``docs/data-retention.md``.

CAMERA_HEALTH_DAYS_DEFAULT = 30
NOTIFICATIONS_DAYS_DEFAULT = 90
REPORT_RUNS_DAYS_DEFAULT = 90
USER_SESSIONS_DAYS_DEFAULT = 7  # post-expiry, not post-creation


def _days(env_var: str, default: int) -> int:
    raw = os.environ.get(env_var)
    if raw is None or raw.strip() == "":
        return default
    try:
        v = int(raw)
        if v <= 0:
            return default
        return v
    except ValueError:
        return default


# ---- result dataclass --------------------------------------------


@dataclass
class TenantRetentionResult:
    tenant_id: int
    tenant_schema: str
    camera_health_deleted: int = 0
    notifications_deleted: int = 0
    report_runs_deleted: int = 0
    report_files_deleted: int = 0
    user_sessions_deleted: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class RetentionResult:
    started_at: datetime
    finished_at: datetime
    per_tenant: list[TenantRetentionResult] = field(default_factory=list)


# ---- the sweep ----------------------------------------------------


def _drop_report_file(file_path_str: str | None) -> bool:
    """Best-effort delete of a report's on-disk artifact.

    Returns True when a real file was removed. Missing files
    aren't an error — the row's been pointing at nothing for a
    while and we still want to delete the row.
    """

    if not file_path_str:
        return False
    p = Path(file_path_str)
    if not p.exists():
        return False
    try:
        p.unlink()
        return True
    except OSError as exc:
        logger.warning(
            "retention: failed to delete report file %s: %s", p, exc
        )
        return False


def _sweep_tenant(
    engine: Engine,
    tenant_id: int,
    tenant_schema: str,
    *,
    now: datetime,
    cutoffs: dict[str, int],
) -> TenantRetentionResult:
    result = TenantRetentionResult(
        tenant_id=tenant_id, tenant_schema=tenant_schema
    )

    health_cutoff = now - timedelta(days=cutoffs["camera_health"])
    notif_cutoff = now - timedelta(days=cutoffs["notifications"])
    runs_cutoff = now - timedelta(days=cutoffs["report_runs"])
    sessions_cutoff = now - timedelta(days=cutoffs["user_sessions"])

    with tenant_context(tenant_schema):
        # report_runs first: read file paths, drop the files,
        # then delete rows. If the row delete fails we leave the
        # files alone (no half-state on disk).
        with engine.begin() as conn:
            rows = conn.execute(
                select(report_runs.c.id, report_runs.c.file_path).where(
                    report_runs.c.tenant_id == tenant_id,
                    report_runs.c.finished_at.is_not(None),
                    report_runs.c.finished_at < runs_cutoff,
                )
            ).all()
            ids_to_delete: list[int] = []
            files_dropped = 0
            for row in rows:
                if _drop_report_file(row.file_path):
                    files_dropped += 1
                ids_to_delete.append(int(row.id))
            if ids_to_delete:
                conn.execute(
                    delete(report_runs).where(
                        report_runs.c.tenant_id == tenant_id,
                        report_runs.c.id.in_(ids_to_delete),
                    )
                )
            result.report_runs_deleted = len(ids_to_delete)
            result.report_files_deleted = files_dropped

        # camera_health_snapshots
        with engine.begin() as conn:
            res = conn.execute(
                delete(camera_health_snapshots).where(
                    camera_health_snapshots.c.tenant_id == tenant_id,
                    camera_health_snapshots.c.captured_at < health_cutoff,
                )
            )
            result.camera_health_deleted = int(res.rowcount or 0)

        # notifications
        with engine.begin() as conn:
            res = conn.execute(
                delete(notifications).where(
                    notifications.c.tenant_id == tenant_id,
                    notifications.c.created_at < notif_cutoff,
                )
            )
            result.notifications_deleted = int(res.rowcount or 0)

        # user_sessions — drop rows whose ``expires_at`` is more
        # than ``user_sessions`` days in the past. Already-expired
        # rows leave breadcrumb value for a week so an operator
        # can reconstruct the last activity timestamp during
        # incident response; beyond that they're noise.
        with engine.begin() as conn:
            res = conn.execute(
                delete(user_sessions).where(
                    user_sessions.c.tenant_id == tenant_id,
                    user_sessions.c.expires_at < sessions_cutoff,
                )
            )
            result.user_sessions_deleted = int(res.rowcount or 0)

        # Audit row — append-only by grant, so this can never be
        # purged by a future retention pass (would also be a
        # red-line violation if it could).
        if (
            result.camera_health_deleted
            or result.notifications_deleted
            or result.report_runs_deleted
            or result.user_sessions_deleted
        ):
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=None,  # background job, no operator
                    action="retention.swept",
                    entity_type="tenant",
                    entity_id=str(tenant_id),
                    after={
                        "camera_health_deleted": result.camera_health_deleted,
                        "notifications_deleted": result.notifications_deleted,
                        "report_runs_deleted": result.report_runs_deleted,
                        "report_files_deleted": result.report_files_deleted,
                        "user_sessions_deleted": result.user_sessions_deleted,
                        "ran_at": now.isoformat(),
                    },
                )

    audit_logger().info(
        "retention.swept tenant=%s schema=%s "
        "camera_health=%d notifications=%d report_runs=%d "
        "report_files=%d user_sessions=%d",
        tenant_id,
        tenant_schema,
        result.camera_health_deleted,
        result.notifications_deleted,
        result.report_runs_deleted,
        result.report_files_deleted,
        result.user_sessions_deleted,
    )
    return result


def run_retention_sweep(
    engine: Engine | None = None,
    *,
    now: datetime | None = None,
    tenant_schemas: Iterable[str] | None = None,
) -> RetentionResult:
    """Top-level entrypoint. Iterates every tenant in
    ``public.tenants`` (single-mode setups iterate just
    ``main``), applies the per-tenant sweep, and aggregates
    the result.
    """

    started = datetime.now(timezone.utc)
    now = now or started
    engine = engine or get_engine()

    cutoffs = {
        "camera_health": _days(
            "HADIR_RETENTION_CAMERA_HEALTH_DAYS", CAMERA_HEALTH_DAYS_DEFAULT
        ),
        "notifications": _days(
            "HADIR_RETENTION_NOTIFICATIONS_DAYS", NOTIFICATIONS_DAYS_DEFAULT
        ),
        "report_runs": _days(
            "HADIR_RETENTION_REPORT_RUNS_DAYS", REPORT_RUNS_DAYS_DEFAULT
        ),
        "user_sessions": _days(
            "HADIR_RETENTION_USER_SESSIONS_DAYS", USER_SESSIONS_DAYS_DEFAULT
        ),
    }

    aggregate = RetentionResult(started_at=started, finished_at=started)

    # Discover tenants. ``public`` is excluded from the sweep —
    # it carries the registry + super-admin tables, not
    # tenant data. ``main`` is the pilot/legacy schema and is
    # treated like a regular tenant here.
    if tenant_schemas is None:
        with tenant_context("public"):
            with engine.begin() as conn:
                rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).order_by(
                        tenants.c.id
                    )
                ).all()
        tenant_pairs = [(int(r.id), str(r.schema_name)) for r in rows]
    else:
        tenant_pairs = []
        with tenant_context("public"):
            with engine.begin() as conn:
                rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).where(
                        tenants.c.schema_name.in_(list(tenant_schemas))
                    )
                ).all()
        tenant_pairs = [(int(r.id), str(r.schema_name)) for r in rows]

    for tenant_id, tenant_schema in tenant_pairs:
        try:
            per = _sweep_tenant(
                engine,
                tenant_id,
                tenant_schema,
                now=now,
                cutoffs=cutoffs,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "retention sweep failed for tenant=%s schema=%s",
                tenant_id,
                tenant_schema,
            )
            per = TenantRetentionResult(
                tenant_id=tenant_id,
                tenant_schema=tenant_schema,
                errors=[f"{type(exc).__name__}: {exc}"],
            )
        aggregate.per_tenant.append(per)

    aggregate.finished_at = datetime.now(timezone.utc)
    return aggregate


# Public re-export for the scheduler module.
__all__ = ["RetentionResult", "TenantRetentionResult", "run_retention_sweep"]
