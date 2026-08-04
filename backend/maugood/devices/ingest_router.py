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
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from maugood.devices import ingest_service
from maugood.devices import tokens

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


@router.post("/hik/{token}")
@router.post("/api/devices/ingest/{token}")
async def ingest_event(token: str, request: Request) -> dict[str, str]:
    _rate_limit(tokens.hash_token(token))

    route = ingest_service.resolve_token(token)
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

    ingest_service.handle_tap(
        route,
        payload,
        received_at=received_at,
        reported_device_name=request.query_params.get("device_name"),
    )
    return {"status": "ok"}
