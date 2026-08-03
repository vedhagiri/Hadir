"""Normalise a terminal's event payload into a tap we can store.

Pure module — no DB, no IO, no HTTP. Everything here is a function of the
posted JSON, so the two rules that actually bite in the field (bad clocks
and resetting serial counters) are unit-testable without a device.

Hikvision posts an ``AccessControllerEvent`` block; other vendors slot in
by adding a normaliser here rather than by touching the router.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# How far from "now" a device-reported timestamp may sit before we stop
# believing it. A terminal that lost its clock reports 1970; one whose
# timezone is misconfigured can report a few hours out, which is still
# plausible and must be preserved.
_CLOCK_PAST_LIMIT = timedelta(days=7)
_CLOCK_FUTURE_LIMIT = timedelta(days=1)


@dataclass(frozen=True, slots=True)
class DeviceTap:
    """One person-verified-at-the-door event, normalised."""

    device_user_id: str
    person_name: Optional[str]
    event_serial: str
    occurred_at: datetime
    verify_mode: Optional[str]
    direction: Optional[str]
    clock_suspect: bool
    raw: dict[str, Any]


def _first(d: dict[str, Any], *keys: str) -> Optional[Any]:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def parse_datetime(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp, tolerating a trailing ``Z``."""

    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # A device that omits the offset is reporting local wall time. We
        # cannot know its zone here, so treat it as UTC and let the clock
        # window below catch anything wildly wrong.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def resolve_occurred_at(
    reported: Optional[datetime], *, received_at: datetime
) -> tuple[datetime, bool]:
    """Decide which timestamp to trust. Returns ``(occurred_at, suspect)``.

    A terminal whose clock was never set stamps ``1970-01-01``. Believing it
    books attendance in 1970 and the employee reads absent today forever;
    dropping the event loses a real tap. So we substitute the receive time
    and flag the row, making the problem visible instead of silent.
    """

    if reported is None:
        return received_at, True
    if reported < received_at - _CLOCK_PAST_LIMIT:
        return received_at, True
    if reported > received_at + _CLOCK_FUTURE_LIMIT:
        return received_at, True
    return reported, False


def dedup_key(*, device_id: int, event_serial: str, occurred_at: datetime) -> str:
    """Stable identity for one tap.

    Deliberately includes ``occurred_at``. A terminal's ``serialNo`` counter
    restarts at zero after a factory reset or an event-log clear, so a
    serial-only key would collide with old rows and silently swallow every
    subsequent event — attendance would simply look thin, with nothing
    logged and nothing to notice until payroll.
    """

    material = f"{device_id}|{event_serial}|{occurred_at.isoformat()}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def normalise(payload: dict[str, Any], *, received_at: datetime) -> Optional[DeviceTap]:
    """Return the tap this payload describes, or ``None`` if it isn't one.

    ``None`` covers keepalives and access events with no person attached —
    both are legitimate posts that must be acknowledged, not errors.
    """

    if not isinstance(payload, dict):
        return None

    event = payload.get("AccessControllerEvent")
    if not isinstance(event, dict):
        event = payload  # already-flattened payloads (our own tests, proxies)

    device_user_id = _first(
        event, "employeeNoString", "employeeNo", "employee_no", "userId"
    )
    if device_user_id is None:
        # Keepalive / door-held / tamper events carry no person.
        return None

    serial = _first(event, "serialNo", "serial_no", "event_serial")
    reported = parse_datetime(
        _first(payload, "dateTime", "event_time", "time")
        or _first(event, "dateTime", "event_time", "time")
    )
    occurred_at, suspect = resolve_occurred_at(reported, received_at=received_at)

    name = _first(event, "name", "employeeName", "person_name")

    return DeviceTap(
        device_user_id=str(device_user_id).strip(),
        person_name=str(name).strip() if name is not None else None,
        # A device that sends no serial still needs a stable identity;
        # the timestamp alone carries it (dedup_key hashes both).
        event_serial=str(serial).strip() if serial is not None else "",
        occurred_at=occurred_at,
        verify_mode=(
            str(_first(event, "currentVerifyMode", "verifyMode", "verify_mode") or "")
            or None
        ),
        # Stored for the record, never used to compute attendance: the
        # engine derives in = first tap, out = last tap, because staff tap
        # the wrong way round constantly and terminals mislabel on reboot.
        direction=(
            str(_first(event, "attendanceStatus", "attendance_status") or "") or None
        ),
        clock_suspect=suspect,
        raw=payload,
    )
