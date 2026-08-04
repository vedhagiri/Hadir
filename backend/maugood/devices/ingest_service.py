"""Shared ingest logic — one tap in, one staged row out.

Two callers reach this:

* ``ingest_router`` — a terminal posting directly at Maugood.
* ``collector_poll`` — Maugood pulling batches off the collector server
  because there is no public Maugood address for a terminal to reach.

They must behave identically. Routing a pulled event through a different
code path would mean dedup, clock handling and discovery could silently
diverge between the two, and only one of them is covered by the tests.

Everything here is tenant-scoped by the token: the caller has already
resolved ``token -> TokenRoute`` against the global registry, and every
statement below filters on that tenant's id inside its schema.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from maugood.db import get_engine, tenant_context
from maugood.devices import ingest as ingest_parser
from maugood.devices import processor
from maugood.devices import repository as repo
from maugood.devices import tokens
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def _str_or_none(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    return str(value).strip() or None


def handle_tap(
    route: tokens.TokenRoute,
    payload: dict[str, Any],
    *,
    received_at: datetime,
    reported_device_name: Optional[str],
    drain: bool = True,
) -> str:
    """Store one device event. Returns a short outcome string.

    Outcomes: ``device_missing``, ``keepalive``, ``duplicate``, ``staged``.
    All of them are successes from the caller's point of view — a terminal
    gets 200 and the poller acks. Only an exception means "don't ack".

    ``drain=False`` lets a batch caller stage many taps and drain once at
    the end instead of recomputing attendance per tap.
    """

    scope = TenantScope(
        tenant_id=route.tenant_id, tenant_schema=route.tenant_schema
    )
    tap = ingest_parser.normalise(payload, received_at=received_at)

    with tenant_context(route.tenant_schema):
        with get_engine().begin() as conn:
            device = repo.get_device(conn, scope, route.device_id)
            if device is None or not device.enabled:
                # Registry says the token is live but the device row is gone
                # or switched off. Treat as handled so the sender stops
                # retrying; the operator sees it in the device list.
                logger.info(
                    "device ingest ignored: device_id=%s missing_or_disabled",
                    route.device_id,
                )
                return "device_missing"

            repo.note_event_received(
                conn,
                scope,
                device_id=route.device_id,
                at=received_at,
                reported_device_name=reported_device_name,
                clock_suspect=bool(tap and tap.clock_suspect),
            )

            # Hardware facts only if the payload actually carries them.
            # Hikvision's access event does not reliably include a device
            # serial, so this usually no-ops — better than inventing a value
            # from ``serialNo``, which is the *event* counter.
            event_block = payload.get("AccessControllerEvent")
            event_block = event_block if isinstance(event_block, dict) else {}
            repo.learn_device_identity(
                conn,
                scope,
                device_id=route.device_id,
                serial_number=_str_or_none(
                    payload.get("deviceSerialNo")
                    or event_block.get("deviceSerialNo")
                    or payload.get("macAddress")
                ),
                # NOT ``deviceName`` — that is the operator-assigned label
                # typed into the terminal, and it lands in
                # ``reported_device_name``.
                model=_str_or_none(payload.get("deviceModel")),
                firmware=_str_or_none(payload.get("firmwareVersion")),
            )

            if tap is None:
                # Keepalive, door-held, tamper — a real post with no person.
                return "keepalive"

            employee_id = repo.discover_device_user(
                conn,
                scope,
                device_id=route.device_id,
                device_user_id=tap.device_user_id,
                name=tap.person_name,
                seen_at=received_at,
            )

            staged_id = repo.insert_tap(
                conn,
                scope,
                device_id=route.device_id,
                device_user_id=tap.device_user_id,
                person_name=tap.person_name,
                event_serial=tap.event_serial,
                dedup_key=ingest_parser.dedup_key(
                    device_id=route.device_id,
                    event_serial=tap.event_serial,
                    stamp=tap.dedup_stamp,
                ),
                occurred_at=tap.occurred_at,
                verify_mode=tap.verify_mode,
                direction=tap.direction,
                clock_suspect=tap.clock_suspect,
                employee_id=employee_id,
                raw=tap.raw,
            )

    if staged_id is None:
        # Already stored — a re-post after a missed acknowledgement. This is
        # the normal case when the collector re-serves an unacked batch.
        return "duplicate"

    if drain and employee_id is not None:
        # Small and synchronous: one detection row + one recompute. The
        # periodic drainer is the safety net for anything that fails here.
        try:
            processor.drain_pending(scope, limit=50)
        except Exception:  # noqa: BLE001
            logger.exception(
                "inline drain failed after ingest: device_id=%s", route.device_id
            )

    logger.info(
        "device tap: device_id=%s person=%s mapped=%s clock_suspect=%s",
        route.device_id,
        tap.device_user_id,
        employee_id is not None,
        tap.clock_suspect,
    )
    return "staged"


def resolve_token(token: str) -> Optional[tokens.TokenRoute]:
    """Look the token up in the global registry (no tenant context yet)."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            return tokens.resolve(conn, token)
