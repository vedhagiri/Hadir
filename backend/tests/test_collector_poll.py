"""Collector polling — the pull path that replaces direct device posts.

Maugood has no public address, so terminals post to a collector that
writes day-wise JSON files, and Maugood reads them back per device token.
These tests stand up a fake collector in-process because every failure
mode here is silent: the collector has no acknowledgement step, so if
Maugood's dedup ever stops working, every sweep would add the whole day's
taps again and quietly inflate attendance.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import delete, select

from maugood.db import (
    attendance_devices,
    detection_events,
    device_attendance_events,
    device_users,
    get_engine,
    tenant_context,
)
from maugood.devices import collector_poll, tokens
from maugood.tenants.scope import TenantScope

TENANT_ID = 1
SCHEMA = "main"
TOKEN = "aaaa-bbbbb"

TODAY = datetime.now(tz=timezone.utc).date().isoformat()


# --- fake collector ---------------------------------------------------------


class FakeCollector:
    """In-memory stand-in for getdata.mts-om.com.

    Mirrors the deployed shape: day-wise files of flat records, served at
    ``/hik/{token}/{date}``, with no ack endpoint.
    """

    def __init__(self) -> None:
        # {token: {date: [record, ...]}}
        self.days: dict[str, dict[str, list]] = {}
        self.known_tokens: set[str] = {TOKEN}
        self.reads: list[str] = []

    def add(self, token: str, rec, *, day: str = TODAY) -> None:
        self.days.setdefault(token, {}).setdefault(day, []).append(rec)

    def handler(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.strip("/").split("/")
        if len(parts) != 2 or parts[0] != "hik":
            return httpx.Response(404, json={"message": "not found"})
        token = parts[1]
        if token not in self.known_tokens:
            return httpx.Response(403, json={"message": "unknown token"})

        self.reads.append(token)
        by_day = self.days.get(token)
        if by_day is None:
            return httpx.Response(404, json={"message": "Token not found"})
        return httpx.Response(
            200,
            json={
                "token": token,
                # The deployed collector keys by filename, not bare date.
                "files": {f"{day}.json": recs for day, recs in by_day.items()},
            },
        )


@pytest.fixture
def collector(monkeypatch):
    fake = FakeCollector()
    real_client = httpx.Client

    def _client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(fake.handler)
        kwargs.setdefault("base_url", "https://collector.test")
        return real_client(*args, **kwargs)

    monkeypatch.setattr(collector_poll.httpx, "Client", _client)
    # get_settings() builds a fresh Settings each call, so config has to be
    # set in the environment rather than patched onto an instance.
    monkeypatch.setenv("MAUGOOD_COLLECTOR_URL", "https://collector.test")
    collector_poll.reset_cursor()
    yield fake
    collector_poll.reset_cursor()


# --- a real device to route to ----------------------------------------------


@pytest.fixture
def push_device(admin_engine):
    """Register a push device + its token, and tear both down after."""

    from maugood.devices import repository as repo

    scope = TenantScope(tenant_id=TENANT_ID, tenant_schema=SCHEMA)
    with tenant_context(SCHEMA):
        with get_engine().begin() as conn:
            device_id = repo.create_push_device(
                conn,
                scope,
                name="collector-test",
                location="",
                driver="hikvision",
                enabled=True,
                push_token_hash=tokens.hash_token(TOKEN),
                push_token_encrypted=tokens.encrypt_token(TOKEN),
            )
    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.register(
                conn,
                token_hash=tokens.hash_token(TOKEN),
                tenant_id=TENANT_ID,
                tenant_schema=SCHEMA,
                device_id=device_id,
            )

    yield device_id

    with tenant_context("public"):
        with get_engine().begin() as conn:
            tokens.delete_for_device(
                conn, tenant_id=TENANT_ID, device_id=device_id
            )
    with tenant_context(SCHEMA):
        with get_engine().begin() as conn:
            conn.execute(
                delete(detection_events).where(
                    detection_events.c.device_id == device_id
                )
            )
            conn.execute(
                delete(device_attendance_events).where(
                    device_attendance_events.c.device_id == device_id
                )
            )
            conn.execute(
                delete(device_users).where(device_users.c.device_id == device_id)
            )
            conn.execute(
                delete(attendance_devices).where(
                    attendance_devices.c.id == device_id
                )
            )


def record(serial: int, *, when=None, employee_no="7001", status="checkIn"):
    """One record in the collector's flat shape."""

    when = when or datetime.now(tz=timezone.utc).replace(microsecond=0)
    return {
        "branch": "branch1",
        "device": "device1",
        "employee_no": employee_no,
        "name": "Collector Person",
        "attendance_status": status,
        "verify_mode": "faceOrFpOrCardOrPw",
        "event_serial": serial,
        "event_time": when.isoformat(),
    }


def staged(device_id: int):
    with tenant_context(SCHEMA):
        with get_engine().begin() as conn:
            return conn.execute(
                select(
                    device_attendance_events.c.event_serial,
                    device_attendance_events.c.direction,
                    device_attendance_events.c.occurred_at,
                    device_attendance_events.c.clock_suspect,
                )
                .where(device_attendance_events.c.device_id == device_id)
                .order_by(device_attendance_events.c.id)
            ).all()


# --- tests ------------------------------------------------------------------


def test_disabled_without_config(monkeypatch):
    monkeypatch.delenv("MAUGOOD_COLLECTOR_URL", raising=False)
    assert collector_poll.poll_once() == {
        "devices": 0,
        "fetched": 0,
        "stored": 0,
        "duplicate": 0,
        "dropped": 0,
    }


def test_reads_the_day_file_and_stages_it(collector, push_device):
    collector.add(TOKEN, record(501))
    collector.add(TOKEN, record(502, status="checkOut"))

    counts = collector_poll.poll_once()

    assert counts["stored"] == 2
    rows = staged(push_device)
    assert [r.event_serial for r in rows] == ["501", "502"]
    assert [r.direction for r in rows] == ["checkIn", "checkOut"]


def test_flat_record_is_converted_to_the_device_shape(collector, push_device):
    """The collector normalises; ingest expects Hikvision. Conversion must
    preserve the person, the direction and the time."""

    when = datetime(2026, 8, 4, 6, 30, tzinfo=timezone.utc)
    collector.add(TOKEN, record(510, when=when, status="checkOut"))

    collector_poll.poll_once()

    rows = staged(push_device)
    assert len(rows) == 1
    assert rows[0].direction == "checkOut"
    assert rows[0].occurred_at == when
    assert rows[0].clock_suspect is False


def test_resweeping_the_same_day_does_not_duplicate(collector, push_device):
    """The collector has no ack — it serves the whole day every time."""

    collector.add(TOKEN, record(520))
    collector_poll.poll_once()

    # Cursor cleared, so the second sweep genuinely re-reads and
    # re-submits — exactly what happens after a Maugood restart.
    collector_poll.reset_cursor()
    counts = collector_poll.poll_once()

    assert counts["duplicate"] == 1
    assert counts["stored"] == 0
    assert len(staged(push_device)) == 1


def test_cursor_skips_already_handled_records(collector, push_device):
    collector.add(TOKEN, record(530))
    collector_poll.poll_once()

    collector.add(TOKEN, record(531))
    counts = collector_poll.poll_once()

    # Only the newly appended record is submitted, not the whole file.
    assert counts["stored"] == 1
    assert counts["duplicate"] == 0
    assert len(staged(push_device)) == 2


def test_missing_day_file_is_not_an_error(collector, push_device):
    """Most days in the window have no file — a 404 is normal."""

    counts = collector_poll.poll_once()

    assert counts["fetched"] == 0
    assert counts["stored"] == 0
    assert staged(push_device) == []


def test_reads_every_day_file_in_one_request(collector, push_device):
    """One GET per device returns the whole buffer, whatever dates it spans.

    That also removes any need to guess the collector's timezone — a file
    named with tomorrow's date (collector at UTC+4) is read regardless.
    """

    today = datetime.now(tz=timezone.utc).date()
    collector.add(TOKEN, record(540), day=(today - timedelta(days=3)).isoformat())
    collector.add(TOKEN, record(541), day=(today + timedelta(days=1)).isoformat())

    counts = collector_poll.poll_once()

    assert counts["stored"] == 2
    assert collector.reads == [TOKEN]      # exactly one request


def test_day_files_are_processed_in_date_order(collector, push_device):
    """in/out derivation depends on tap order, so files must sort by date."""

    today = datetime.now(tz=timezone.utc).date()
    older = (today - timedelta(days=1)).isoformat()
    collector.add(TOKEN, record(551), day=today.isoformat())
    collector.add(TOKEN, record(550), day=older)

    collector_poll.poll_once()

    assert [r.event_serial for r in staged(push_device)] == ["550", "551"]


def test_device_unknown_to_the_collector_is_skipped(collector, push_device):
    """Registered in Maugood, not yet added to the collector's DEVICES."""

    collector.known_tokens.clear()

    counts = collector_poll.poll_once()

    assert counts["devices"] >= 1
    assert counts["stored"] == 0
    assert staged(push_device) == []


def test_broken_device_clock_falls_back_to_now(collector, push_device):
    collector.add(
        TOKEN, record(550, when=datetime(1970, 1, 1, 1, 16, tzinfo=timezone.utc))
    )

    collector_poll.poll_once()

    rows = staged(push_device)
    assert len(rows) == 1
    assert rows[0].clock_suspect is True
    assert abs(rows[0].occurred_at - datetime.now(tz=timezone.utc)) < timedelta(
        minutes=2
    )


def test_unusable_record_does_not_stop_the_rest(collector, push_device):
    collector.add(TOKEN, "garbage")
    collector.add(TOKEN, record(560))

    counts = collector_poll.poll_once()

    assert counts["dropped"] == 1
    assert counts["stored"] == 1


def test_tick_swallows_a_dead_collector(monkeypatch):
    """A network blip must not kill the scheduler thread."""

    monkeypatch.setenv("MAUGOOD_COLLECTOR_URL", "https://collector.test")

    def _boom(*args, **kwargs):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(collector_poll, "poll_once", _boom)
    collector_poll._tick()  # must not raise
