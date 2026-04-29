"""Camera-unreachable watcher (v1.0 P20 producer).

Picks up cameras whose **latest** health snapshot is
``reachable=false`` AND whose first unreachable snapshot in the
current outage window is older than ``threshold_minutes`` (default
5). Emits one notification per outage — a follow-up "still
unreachable" cycle won't re-fire because we look at the most
recent ``camera_unreachable`` notification per camera and skip
when it's newer than the camera's latest snapshot.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import and_, desc, func as sa_func, select
from sqlalchemy.engine import Connection

from maugood.db import (
    cameras,
    camera_health_snapshots,
    notifications,
    tenant_context,
    tenants,
)
from maugood.db import get_engine, make_admin_engine
from maugood.notifications.producer import notify_camera_unreachable
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def _scan_one_tenant(scope: TenantScope, *, threshold_minutes: int) -> int:
    engine = get_engine()
    fired = 0
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=threshold_minutes)

    with engine.begin() as conn:
        # Latest snapshot per camera (in tenant). Postgres-friendly via
        # a per-camera DISTINCT ON would be cleaner but SQLAlchemy
        # Core's portability is preferred — we group + max.
        latest_subq = (
            select(
                camera_health_snapshots.c.camera_id,
                sa_func.max(camera_health_snapshots.c.captured_at).label(
                    "latest_at"
                ),
            )
            .where(
                camera_health_snapshots.c.tenant_id == scope.tenant_id,
            )
            .group_by(camera_health_snapshots.c.camera_id)
            .subquery()
        )
        rows = conn.execute(
            select(
                cameras.c.id.label("camera_id"),
                cameras.c.name.label("camera_name"),
                camera_health_snapshots.c.reachable,
                camera_health_snapshots.c.captured_at,
            )
            .select_from(
                cameras.join(
                    latest_subq,
                    latest_subq.c.camera_id == cameras.c.id,
                ).join(
                    camera_health_snapshots,
                    and_(
                        camera_health_snapshots.c.camera_id
                        == latest_subq.c.camera_id,
                        camera_health_snapshots.c.captured_at
                        == latest_subq.c.latest_at,
                        camera_health_snapshots.c.tenant_id
                        == scope.tenant_id,
                    ),
                )
            )
            .where(
                cameras.c.tenant_id == scope.tenant_id,
                cameras.c.enabled.is_(True),
                camera_health_snapshots.c.reachable.is_(False),
                camera_health_snapshots.c.captured_at <= cutoff,
            )
        ).all()

        for r in rows:
            # Outage start = the earliest unreachable snapshot since
            # the most recent reachable=true one (or the first
            # snapshot ever, if it's been unreachable from the start).
            last_reachable = conn.execute(
                select(
                    sa_func.max(
                        camera_health_snapshots.c.captured_at
                    )
                ).where(
                    camera_health_snapshots.c.tenant_id == scope.tenant_id,
                    camera_health_snapshots.c.camera_id == int(r.camera_id),
                    camera_health_snapshots.c.reachable.is_(True),
                )
            ).scalar_one()
            outage_started = (
                last_reachable + timedelta(microseconds=1)
                if last_reachable is not None
                else None
            )

            # Skip if we've already notified for this outage window.
            existing = conn.execute(
                select(notifications.c.id, notifications.c.created_at)
                .where(
                    notifications.c.tenant_id == scope.tenant_id,
                    notifications.c.category == "camera_unreachable",
                    notifications.c.payload[
                        "camera_id"
                    ].as_integer()
                    == int(r.camera_id),
                )
                .order_by(desc(notifications.c.id))
                .limit(1)
            ).first()
            if existing is not None:
                # If the prior notification's created_at is after the
                # outage started, this same outage already fired.
                if outage_started is None or existing.created_at >= outage_started:
                    continue

            minutes_unreachable = max(
                threshold_minutes,
                int((now - r.captured_at).total_seconds() // 60),
            )
            written = notify_camera_unreachable(
                conn,
                scope,
                camera_id=int(r.camera_id),
                camera_name=str(r.camera_name),
                minutes_unreachable=minutes_unreachable,
            )
            fired += len(written)
    return fired


def tick_camera_unreachable(*, threshold_minutes: int = 5) -> int:
    """Scan every active tenant for unreachable cameras."""

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
        try:
            scope = TenantScope(tenant_id=int(tr.id))
            with tenant_context(str(tr.schema_name)):
                fired += _scan_one_tenant(
                    scope, threshold_minutes=threshold_minutes
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "camera-unreachable scan failed for %s: %s",
                tr.schema_name,
                type(exc).__name__,
            )
    return fired
