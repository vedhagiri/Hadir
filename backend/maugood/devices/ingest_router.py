"""Anonymous ingest endpoint for attendance terminals.

``POST /hik/{token}`` — the URL an operator pastes into the device's
*HTTP Listening* screen. This is the only unauthenticated write surface in
Maugood, so the rules here are deliberate:

* **The token in the path is the entire credential.** It resolves to a
  tenant via ``public.device_push_tokens`` before any schema is selected;
  everything after that runs inside ``tenant_context`` with an explicit
  ``tenant_id`` filter, exactly like an authenticated write.
* **Unknown and revoked tokens are indistinguishable to the client.**
  Anything else turns the endpoint into an oracle for guessing tokens.
* **The token is never logged**, here or anywhere else. Log ``device_id``.
* **We answer 200 for anything that isn't an auth failure** — unknown
  employee, nonsense clock, duplicate, keepalive. Terminals retry in a
  loop on non-2xx and fill their local buffer, turning one bad event into
  a stalled device.
* **Rate-limited per token**, so a leaked URL cannot be used to flood a
  tenant's attendance with forged taps faster than an operator notices.

Kept off ``/api/*`` on purpose: these devices have a short URL field and
the path an operator types should stay as small as possible.
"""

from __future__ import annotations

import json
import logging
import threading
import time as time_mod
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from maugood.db import get_engine, tenant_context
from maugood.devices import ingest as ingest_parser
from maugood.devices import processor
from maugood.devices import repository as repo
from maugood.devices import tokens
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["device-ingest"])

# Generous enough for a busy door (a tap every couple of seconds plus
# keepalives), tight enough that a leaked URL can't bulk-forge a month of
# attendance before anyone looks at the logs.
_RATE_LIMIT_PER_MINUTE = 120
_MAX_BODY_BYTES = 8 * 1024 * 1024  # a face JPEG rides along on multipart

_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)


def _rate_limit(key: str) -> None:
    now = time_mod.monotonic()
    cutoff = now - 60.0
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[key]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= _RATE_LIMIT_PER_MINUTE:
            raise HTTPException(status_code=429, detail="too many events")
        bucket.append(now)


async def _read_payload(request: Request) -> dict[str, Any]:
    """Parse the body as JSON, whether it arrived raw or inside multipart.

    Hikvision sends ``multipart/form-data`` (a JSON part plus a JPEG) when
    picture upload is enabled and ``application/json`` when it is not. An
    endpoint that handles only JSON silently drops half the events.
    """

    ctype = (request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in ctype:
        form = await request.form()
        # Prefer the part the device names. Falling back to "whichever part
        # looks like JSON" would silently change meaning the day a firmware
        # adds another JSON-ish field.
        for name in ("event_log", "AccessControllerEvent", "json", "data"):
            value = form.get(name)
            if isinstance(value, str) and value.strip():
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    continue
        for value in form.values():
            if isinstance(value, str) and value.strip().startswith("{"):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    continue
        return {}

    body = await request.body()
    if len(body) > _MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")
    if not body.strip():
        return {}
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _resolve(token: str) -> Optional[tokens.TokenRoute]:
    """Look the token up in the global registry (no tenant context yet)."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            return tokens.resolve(conn, token)


@router.post("/hik/{token}")
@router.post("/api/devices/ingest/{token}")
async def ingest_event(token: str, request: Request) -> dict[str, str]:
    _rate_limit(tokens.hash_token(token))

    route = _resolve(token)
    if route is None:
        # Deliberately identical for unknown and revoked. Logged without
        # the token so a stale terminal is still diagnosable by IP.
        client = request.client
        logger.warning(
            "device ingest rejected: unknown or revoked token ip=%s",
            client.host if client else "unknown",
        )
        raise HTTPException(status_code=401, detail="unknown device")

    payload = await _read_payload(request)
    received_at = datetime.now(tz=timezone.utc)
    reported_name = request.query_params.get("device_name")

    scope = TenantScope(
        tenant_id=route.tenant_id, tenant_schema=route.tenant_schema
    )
    tap = ingest_parser.normalise(payload, received_at=received_at)

    with tenant_context(route.tenant_schema):
        with get_engine().begin() as conn:
            device = repo.get_device(conn, scope, route.device_id)
            if device is None or not device.enabled:
                # Registry says this token is live but the device row is
                # gone or switched off. Acknowledge so the terminal stops
                # retrying; an operator sees it in the device list.
                logger.info(
                    "device ingest ignored: device_id=%s missing_or_disabled",
                    route.device_id,
                )
                return {"status": "ok"}

            repo.note_event_received(
                conn,
                scope,
                device_id=route.device_id,
                at=received_at,
                reported_device_name=reported_name,
                clock_suspect=bool(tap and tap.clock_suspect),
            )
            # Hardware facts only if the payload actually carries them.
            # Hikvision's access event does not reliably include a device
            # serial, so this usually no-ops — better than inventing a
            # value from ``serialNo``, which is the *event* counter.
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
                model=_str_or_none(
                    payload.get("deviceModel") or event_block.get("deviceName")
                ),
                firmware=_str_or_none(payload.get("firmwareVersion")),
            )

            if tap is None:
                # Keepalive, door-held, tamper — a real post with no person.
                return {"status": "ok"}

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
                    occurred_at=tap.occurred_at,
                ),
                occurred_at=tap.occurred_at,
                verify_mode=tap.verify_mode,
                direction=tap.direction,
                clock_suspect=tap.clock_suspect,
                employee_id=employee_id,
                raw=tap.raw,
            )

    if staged_id is None:
        # Already stored — a re-post after a missed acknowledgement.
        return {"status": "ok"}

    if employee_id is not None:
        # Small and synchronous: one detection row + one recompute. The
        # 30-second drainer is the safety net for anything that fails here.
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
    return {"status": "ok"}


def _str_or_none(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    return str(value).strip() or None
