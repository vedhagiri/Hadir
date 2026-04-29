"""Reclassify ``detection_events`` rows whose face crop is missing on disk.

Background: P28.5b validation surfaced 251 ``detection_events`` rows in
``tenant_mts_demo`` whose ``face_crop_path`` pointed at files that
weren't on disk. The forward-going write path is now hardened (see
``maugood/capture/events.py`` invariants), but the existing rows have to
be reclassified so the API can stop returning 410 for every missing
crop and the Camera Logs UI can show a clean "Crop unavailable"
placeholder instead of a broken image.

Strategy:

* For every active tenant in ``public.tenants``, open a
  ``tenant_context(schema)`` and SELECT ``id, face_crop_path`` from
  ``detection_events`` where ``face_crop_path IS NOT NULL``.
* For each row, check whether the file exists on disk.
* If missing: ``UPDATE detection_events SET face_crop_path = NULL,
  orphaned_at = now() WHERE id = :id``. Idempotent — rows already
  reclassified (``face_crop_path IS NULL`` from a prior run) are
  skipped because the SELECT excludes them.

Audit trail: writes one ``detection_events.orphan_swept`` audit row
per tenant carrying the count of rows reclassified — so the operator
can confirm the sweep ran from the audit log alone.

Run via:

    docker compose exec backend python -m scripts.cleanup_orphan_detection_events

Idempotent + safe on a healthy DB (does nothing if no orphans). Safe
to run while the capture worker is live — the UPDATE only touches
rows whose file is already missing; a worker that just inserted a
fresh row + file is unaffected because the file exists.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from maugood.auth.audit import write_audit
from maugood.db import (
    audit_log,
    detection_events,
    make_admin_engine,
    tenant_context,
    tenants,
)


logger = logging.getLogger("maugood.cleanup_orphan_detection_events")


def _make_admin_engine() -> Engine:
    return make_admin_engine()


def _sweep_one_tenant(
    engine: Engine, *, tenant_id: int, schema: str
) -> tuple[int, int]:
    """Sweep one tenant. Returns (scanned, reclassified)."""

    scanned = 0
    reclassified: list[int] = []

    with tenant_context(schema):
        with engine.begin() as conn:
            rows = conn.execute(
                select(
                    detection_events.c.id,
                    detection_events.c.face_crop_path,
                ).where(
                    detection_events.c.tenant_id == tenant_id,
                    detection_events.c.face_crop_path.isnot(None),
                )
            ).all()

        for row in rows:
            scanned += 1
            path_str = str(row.face_crop_path)
            if Path(path_str).exists():
                continue
            reclassified.append(int(row.id))

        if reclassified:
            with engine.begin() as conn:
                conn.execute(
                    update(detection_events)
                    .where(
                        detection_events.c.tenant_id == tenant_id,
                        detection_events.c.id.in_(reclassified),
                    )
                    .values(
                        face_crop_path=None,
                        orphaned_at=datetime.now(tz=timezone.utc),
                    )
                )
                # One audit row per tenant carrying the count. No PII,
                # opaque ids only — the operator confirmation that the
                # sweep ran lives in the audit log.
                write_audit(
                    conn,
                    tenant_id=tenant_id,
                    actor_user_id=None,
                    action="detection_events.orphan_swept",
                    entity_type="detection_event",
                    entity_id=None,
                    after={
                        "scanned": scanned,
                        "reclassified": len(reclassified),
                        "first_id": reclassified[0],
                        "last_id": reclassified[-1],
                    },
                )

    return scanned, len(reclassified)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    engine = _make_admin_engine()

    with tenant_context("public"):
        with engine.begin() as conn:
            tenant_rows = conn.execute(
                select(tenants.c.id, tenants.c.schema_name).where(
                    tenants.c.status == "active"
                )
            ).all()

    if not tenant_rows:
        logger.warning("no active tenants found in public.tenants")
        return 1

    total_scanned = 0
    total_reclassified = 0
    for r in tenant_rows:
        tenant_id = int(r.id)
        schema = str(r.schema_name)
        scanned, reclassified = _sweep_one_tenant(
            engine, tenant_id=tenant_id, schema=schema
        )
        logger.info(
            "tenant=%s (id=%d) scanned=%d reclassified=%d",
            schema, tenant_id, scanned, reclassified,
        )
        total_scanned += scanned
        total_reclassified += reclassified

    logger.info(
        "sweep complete: total_scanned=%d total_reclassified=%d",
        total_scanned, total_reclassified,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    # Tests import ``_sweep_one_tenant`` / ``main`` directly so this
    # branch is just the CLI entry point.
    sys.exit(main())
