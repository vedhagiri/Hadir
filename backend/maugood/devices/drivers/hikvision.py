"""Hikvision ISAPI driver — device identity read.

``read_info`` connects to the terminal's ``/ISAPI/System/deviceInfo`` and
returns its serial, model, and firmware. It is **best-effort**: if the
device is unreachable (common in dev / before the hardware is on the
network), it returns a synthesized serial derived from host:port and
``reachable=False`` so registration still succeeds and the operator can
re-test later. The real serial is picked up on the next successful probe.

Only the identity read is implemented here — user sync, enrollment push,
and event ingest land in follow-up phases behind the same driver seam.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_TIMEOUT_S = 5.0


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    serial_number: str
    model: str | None
    firmware: str | None
    reachable: bool


@dataclass(frozen=True, slots=True)
class DeviceUser:
    """One person as stored on the terminal."""

    device_user_id: str  # Hikvision ``employeeNo``
    name: str | None
    card_no: str | None


_MAX_RESULTS = 30
_MAX_PAGES = 200  # hard stop (up to ~6000 users)


def list_users(
    host: str, port: int, username: str, password: str
) -> tuple[list[DeviceUser], bool]:
    """Pull the terminal's person list via ISAPI ``UserInfo/Search``.

    Returns ``(users, reachable)``. Best-effort: on any error it returns
    ``([], False)`` — the caller must NOT wipe existing rows on an empty
    result (an unreachable device is not the same as "zero users").
    Paginates ``searchResultPosition`` until a short page ends the list.
    """

    url = f"http://{host}:{port}/ISAPI/AccessControl/UserInfo/Search?format=json"
    users: list[DeviceUser] = []
    try:
        import httpx  # local import: keep module import cheap for tests

        auth = httpx.DigestAuth(username, password)
        position = 0
        with httpx.Client(auth=auth, timeout=_TIMEOUT_S) as client:
            for _ in range(_MAX_PAGES):
                body = {
                    "UserInfoSearchCond": {
                        "searchID": "maugood",
                        "searchResultPosition": position,
                        "maxResults": _MAX_RESULTS,
                    }
                }
                resp = client.post(url, json=body)
                resp.raise_for_status()
                data = resp.json().get("UserInfoSearch", {})
                page = data.get("UserInfo", []) or []
                for u in page:
                    emp_no = str(u.get("employeeNo", "")).strip()
                    if not emp_no:
                        continue
                    users.append(
                        DeviceUser(
                            device_user_id=emp_no,
                            name=(u.get("name") or None),
                            card_no=None,  # cards come from a separate ISAPI call
                        )
                    )
                if len(page) < _MAX_RESULTS:
                    break
                position += len(page)
        return users, True
    except Exception:  # noqa: BLE001 — dev-safe: unreachable is expected
        logger.info("device unreachable during user sync (host=%s)", host)
        return [], False


def _fallback_serial(host: str, port: int) -> str:
    """Deterministic placeholder so the row is registerable in dev and the
    unique-per-tenant constraint still catches a duplicate host:port."""

    return f"UNVERIFIED-{host.replace(':', '_')}-{port}"


def read_info(host: str, port: int, username: str, password: str) -> DeviceInfo:
    """Read device identity over ISAPI. Never raises — returns an
    ``unreachable`` fallback on any error."""

    url = f"http://{host}:{port}/ISAPI/System/deviceInfo"
    try:
        import httpx  # local import: keep module import cheap for tests

        # Hikvision ISAPI uses HTTP Digest auth.
        auth = httpx.DigestAuth(username, password)
        resp = httpx.get(url, auth=auth, timeout=_TIMEOUT_S)
        resp.raise_for_status()
        body = resp.text
        serial = _extract_tag(body, "serialNumber")
        model = _extract_tag(body, "model")
        firmware = _extract_tag(body, "firmwareVersion")
        if serial:
            return DeviceInfo(
                serial_number=serial,
                model=model,
                firmware=firmware,
                reachable=True,
            )
        logger.warning("device deviceInfo missing serialNumber (host=%s)", host)
    except Exception:  # noqa: BLE001 — dev-safe: unreachable is expected
        logger.info(
            "device unreachable during register — using fallback serial (host=%s)",
            host,
        )
    return DeviceInfo(
        serial_number=_fallback_serial(host, port),
        model=None,
        firmware=None,
        reachable=False,
    )


def _extract_tag(xml: str, tag: str) -> str | None:
    """Tiny tag extractor — avoids pulling an XML parser for three fields."""

    open_t = f"<{tag}>"
    close_t = f"</{tag}>"
    start = xml.find(open_t)
    if start == -1:
        return None
    start += len(open_t)
    end = xml.find(close_t, start)
    if end == -1:
        return None
    return xml[start:end].strip() or None
