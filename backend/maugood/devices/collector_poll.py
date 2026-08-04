"""Fetch attendance events from the collector server.

Terminals cannot reach Maugood — it has no public address — so they post
to a collector at ``MAUGOOD_COLLECTOR_URL`` which writes day-wise JSON
files per device. Maugood reads them back from the *same URL the device
posts to*:

    POST {collector}/hik/{token}   device sends a tap
    GET  {collector}/hik/{token}   every day-file for that device

One request per device per sweep. The token is the credential in both
directions, so any push device Maugood knows about is a device it can
read — nothing extra to configure. This sweeps every tenant's push
devices; one collector serves all of them.

**The collector has no acknowledgement step.** It serves everything it
holds every time, so correctness rests entirely on Maugood's own dedup:
``insert_tap`` keys on ``sha256(device_id|event_serial|occurred_at)`` and
ignores a repeat. Re-reading the same record is therefore a no-op, which
is what makes a stateless collector safe to poll.

To avoid re-submitting every record every 30 seconds, a per-(token, file)
cursor remembers how many were already handled. It is a *cost*
optimisation only — the collector appends, so index N onward is new. If
that assumption is ever wrong the cursor may re-read records, and dedup
absorbs it. Losing the cursor on restart costs one redundant pass.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from maugood.config import get_settings
from maugood.db import attendance_devices, get_engine, tenant_context, tenants
from maugood.devices import ingest_service, tokens

logger = logging.getLogger(__name__)

# One in-flight sweep at a time. A slow sweep must not overlap the next
# tick and double-submit.
_POLL_LOCK = threading.Lock()

# (token_hash, date) -> number of records already handled. Keyed by hash so
# a plaintext token never sits in a long-lived structure.
_cursor: dict[tuple[str, str], int] = {}


def _hik_shape(record: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the Hikvision payload from the collector's flat record.

    The collector normalises before writing, but Maugood's ingest expects
    the device's own shape — and must, because the direct-post path (a
    terminal aimed straight at Maugood) delivers exactly that. Converting
    here keeps ONE parsing path instead of two that can drift.
    """

    return {
        "dateTime": record.get("event_time"),
        "eventType": "AccessControllerEvent",
        "AccessControllerEvent": {
            "employeeNoString": record.get("employee_no"),
            "name": record.get("name"),
            "attendanceStatus": record.get("attendance_status"),
            "currentVerifyMode": record.get("verify_mode"),
            "serialNo": record.get("event_serial"),
        },
    }


def _push_devices() -> list[tuple[int, str, int, str]]:
    """Every enabled push device, as (tenant_id, schema, device_id, token)."""

    with tenant_context("public"):
        with get_engine().begin() as conn:
            rows = conn.execute(
                select(tenants.c.id, tenants.c.schema_name).where(
                    tenants.c.status == "active"
                )
            ).all()

    found: list[tuple[int, str, int, str]] = []
    for tenant_id, schema in rows:
        try:
            with tenant_context(schema):
                with get_engine().begin() as conn:
                    devices = conn.execute(
                        select(
                            attendance_devices.c.id,
                            attendance_devices.c.push_token_encrypted,
                        ).where(
                            attendance_devices.c.tenant_id == tenant_id,
                            attendance_devices.c.enabled.is_(True),
                            attendance_devices.c.push_token_encrypted.isnot(None),
                        )
                    ).all()
        except Exception:  # noqa: BLE001
            logger.exception("collector: could not list devices for %s", schema)
            continue

        for device_id, ciphertext in devices:
            try:
                found.append(
                    (
                        tenant_id,
                        schema,
                        int(device_id),
                        tokens.decrypt_token(ciphertext),
                    )
                )
            except Exception:  # noqa: BLE001
                # A key rotation can orphan an old ciphertext. Skip that
                # device rather than failing the whole sweep.
                logger.warning(
                    "collector: could not decrypt token for device id=%s",
                    device_id,
                )
    return found


def _read_device(
    client: httpx.Client, base: str, token: str, device_id: int
) -> dict[str, int]:
    """Read one device's whole buffer and stage anything new."""

    counts = {"fetched": 0, "stored": 0, "duplicate": 0, "dropped": 0}

    resp = client.get(f"{base}/hik/{token}")
    if resp.status_code == 404:
        # No directory yet — this device has never posted. Normal.
        return counts
    if resp.status_code in (401, 403):
        logger.warning(
            "collector: device id=%s is not registered on the collector",
            device_id,
        )
        return counts
    resp.raise_for_status()

    files = resp.json().get("files") or {}
    if not isinstance(files, dict) or not files:
        return counts

    route: Optional[Any] = None
    token_hash = tokens.hash_token(token)

    # Filenames are dates, so sorting them is chronological — and order
    # matters, because in/out is derived from tap sequence.
    for filename in sorted(files):
        records = files.get(filename) or []
        if not isinstance(records, list):
            continue
        counts["fetched"] += len(records)

        key = (token_hash, filename)
        already = _cursor.get(key, 0)
        if already >= len(records):
            # Nothing appended to this day since the last sweep.
            continue

        if route is None:
            route = ingest_service.resolve_token(token)
            if route is None:
                logger.warning(
                    "collector: device id=%s has no live token in Maugood, "
                    "skipping",
                    device_id,
                )
                return counts

        handled = already
        for record in records[already:]:
            if not isinstance(record, dict):
                logger.warning(
                    "collector: unusable record in %s for device id=%s",
                    filename,
                    device_id,
                )
                counts["dropped"] += 1
                handled += 1
                continue
            try:
                outcome = ingest_service.handle_tap(
                    route,
                    _hik_shape(record),
                    # The collector's record carries no arrival timestamp,
                    # so a device with a broken clock falls back to now.
                    # Sweeps run every 30s, so "now" is close to the truth.
                    received_at=datetime.now(tz=timezone.utc),
                    reported_device_name=record.get("device"),
                )
            except Exception:  # noqa: BLE001
                # Stop at the first failure rather than skipping past it —
                # order within a device matters. The cursor is not advanced
                # past this record, so the next sweep retries from here.
                logger.exception(
                    "collector: failed to store record %s of %s for "
                    "device id=%s",
                    handled,
                    filename,
                    device_id,
                )
                _cursor[key] = handled
                return counts

            if outcome == "duplicate":
                counts["duplicate"] += 1
            elif outcome in ("staged", "keepalive"):
                counts["stored"] += 1
            else:
                counts["dropped"] += 1
            handled += 1

        _cursor[key] = handled

    return counts


def poll_once() -> dict[str, int]:
    """Sweep every push device."""

    settings = get_settings()
    base = (settings.collector_url or "").rstrip("/")
    totals = {
        "devices": 0,
        "fetched": 0,
        "stored": 0,
        "duplicate": 0,
        "dropped": 0,
    }
    if not base:
        return totals

    devices = _push_devices()
    totals["devices"] = len(devices)
    if not devices:
        return totals

    with httpx.Client(
        timeout=settings.collector_timeout_seconds,
        # The collector redirects http -> https.
        follow_redirects=True,
    ) as client:
        for _tenant_id, _schema, device_id, token in devices:
            try:
                counts = _read_device(client, base, token, device_id)
            except httpx.HTTPError as exc:
                # One unreachable device (or a collector blip) must not stop
                # the sweep for the others.
                logger.warning(
                    "collector: read failed for device id=%s (%s)",
                    device_id,
                    type(exc).__name__,
                )
                continue
            for key, value in counts.items():
                totals[key] += value

    if totals["stored"]:
        logger.info(
            "collector poll: devices=%(devices)s fetched=%(fetched)s "
            "stored=%(stored)s duplicate=%(duplicate)s dropped=%(dropped)s",
            totals,
        )
    return totals


def reset_cursor() -> None:
    """Forget what has been read, so the next sweep re-reads every day.

    Dedup makes this safe: a re-read of an already-stored tap is ignored.
    Used by the operator-facing resync and by tests.
    """

    _cursor.clear()


def _tick() -> None:
    if not _POLL_LOCK.acquire(blocking=False):
        logger.debug("collector poll still running, skipping this tick")
        return
    try:
        poll_once()
    except httpx.HTTPError as exc:
        # Expected and transient: collector restarting, network down. Warn
        # without a stack trace so the log stays readable.
        logger.warning("collector unreachable: %s", type(exc).__name__)
    except Exception:  # noqa: BLE001
        logger.exception("collector poll failed")
    finally:
        _POLL_LOCK.release()


class CollectorPoller:
    """APScheduler wrapper. No-op unless a collector URL is configured."""

    def __init__(self) -> None:
        self._scheduler: Optional[BackgroundScheduler] = None

    def start(self) -> None:
        settings = get_settings()
        if not settings.collector_url:
            logger.info("collector poller disabled (no MAUGOOD_COLLECTOR_URL)")
            return
        if self._scheduler is not None:
            return

        self._scheduler = BackgroundScheduler(timezone="UTC")
        self._scheduler.add_job(
            _tick,
            "interval",
            seconds=settings.collector_poll_seconds,
            id="collector_poll",
            coalesce=True,
            max_instances=1,
            # First run right away so a restart picks up the backlog instead
            # of waiting out a full interval.
            next_run_time=datetime.now(tz=timezone.utc),
        )
        self._scheduler.start()
        logger.info(
            "collector poller started: %s every %ss",
            settings.collector_url,
            settings.collector_poll_seconds,
        )

    def stop(self) -> None:
        if self._scheduler is not None:
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


collector_poller = CollectorPoller()
