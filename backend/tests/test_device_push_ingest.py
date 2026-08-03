"""Device push ingest — token handling and payload normalisation.

These cover the two failure modes that are invisible in production if we
get them wrong (a device with an unset clock, and a serial counter that
resets), plus the token rules that make the anonymous endpoint safe.

Pure units — no DB, no HTTP. The end-to-end path has its own live smoke at
``scripts/smoke_device_push.py``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pytest

from maugood.devices import ingest, tokens
from maugood.logging_config import RedactSecretPathsFilter

NOW = datetime(2026, 8, 4, 9, 0, tzinfo=timezone.utc)


def _hik(**over):
    event = {
        "employeeNoString": "OM00044",
        "name": "Harikrishnan",
        "attendanceStatus": "checkIn",
        "currentVerifyMode": "faceOrFpOrCardOrPw",
        "serialNo": 168,
    }
    event.update(over.pop("event", {}))
    payload = {"dateTime": "2026-08-04T12:30:00+04:00", "AccessControllerEvent": event}
    payload.update(over)
    return payload


# --- tokens -----------------------------------------------------------------


def test_minted_token_matches_the_operator_facing_shape():
    token = tokens.mint_token()
    left, _, right = token.partition("-")
    assert len(left) == 4 and len(right) == 5
    assert all(c in "0123456789abcdef" for c in left + right)


def test_tokens_are_not_predictable():
    minted = {tokens.mint_token() for _ in range(200)}
    assert len(minted) > 190, "mint_token is repeating far too often"


def test_hash_is_stable_and_not_reversible():
    token = "b1d1-9f3a7"
    assert tokens.hash_token(token) == tokens.hash_token(token)
    assert token not in tokens.hash_token(token)
    assert len(tokens.hash_token(token)) == 64


def test_hash_ignores_surrounding_whitespace():
    # A terminal that pastes a trailing newline into the URL field must not
    # become permanently unroutable.
    assert tokens.hash_token(" b1d1-9f3a7\n") == tokens.hash_token("b1d1-9f3a7")


def test_encrypted_token_round_trips_and_hides_the_plaintext():
    token = tokens.mint_token()
    blob = tokens.encrypt_token(token)
    assert token not in blob
    assert tokens.decrypt_token(blob) == token


# --- clock sanity -----------------------------------------------------------


def test_unset_device_clock_is_replaced_not_trusted():
    """A 1970 stamp would book attendance in 1970 and read absent forever."""

    reported = datetime(1970, 1, 1, 1, 16, 27, tzinfo=timezone(timedelta(hours=4)))
    resolved, suspect = ingest.resolve_occurred_at(reported, received_at=NOW)
    assert resolved == NOW
    assert suspect is True


def test_missing_timestamp_falls_back_to_receive_time():
    resolved, suspect = ingest.resolve_occurred_at(None, received_at=NOW)
    assert resolved == NOW
    assert suspect is True


def test_plausible_timestamp_is_preserved_exactly():
    reported = NOW - timedelta(hours=3)
    resolved, suspect = ingest.resolve_occurred_at(reported, received_at=NOW)
    assert resolved == reported
    assert suspect is False


def test_a_few_hours_of_timezone_skew_is_still_believed():
    # Misconfigured device timezone — wrong, but not nonsense. Discarding
    # it would silently move real taps to the wrong time.
    reported = NOW - timedelta(hours=11)
    resolved, suspect = ingest.resolve_occurred_at(reported, received_at=NOW)
    assert resolved == reported
    assert suspect is False


def test_far_future_timestamp_is_rejected():
    reported = NOW + timedelta(days=400)
    resolved, suspect = ingest.resolve_occurred_at(reported, received_at=NOW)
    assert resolved == NOW
    assert suspect is True


# --- dedup ------------------------------------------------------------------


def test_same_tap_twice_produces_one_key():
    at = NOW
    a = ingest.dedup_key(device_id=7, event_serial="168", occurred_at=at)
    b = ingest.dedup_key(device_id=7, event_serial="168", occurred_at=at)
    assert a == b


def test_serial_counter_reset_does_not_collide_with_history():
    """The reason the key is not the serial alone.

    A terminal's ``serialNo`` restarts at zero after a factory reset. With a
    serial-only key the reused numbers would collide with old rows and every
    new event would be swallowed as a duplicate — silently, with attendance
    just looking thin.
    """

    old = ingest.dedup_key(
        device_id=7, event_serial="168", occurred_at=NOW - timedelta(days=30)
    )
    after_reset = ingest.dedup_key(device_id=7, event_serial="168", occurred_at=NOW)
    assert old != after_reset


def test_same_serial_on_two_devices_does_not_collide():
    a = ingest.dedup_key(device_id=7, event_serial="1", occurred_at=NOW)
    b = ingest.dedup_key(device_id=8, event_serial="1", occurred_at=NOW)
    assert a != b


# --- normalisation ----------------------------------------------------------


def test_hikvision_event_maps_onto_a_tap():
    tap = ingest.normalise(_hik(), received_at=NOW)
    assert tap is not None
    assert tap.device_user_id == "OM00044"
    assert tap.person_name == "Harikrishnan"
    assert tap.event_serial == "168"
    assert tap.verify_mode == "faceOrFpOrCardOrPw"
    assert tap.direction == "checkIn"
    assert tap.clock_suspect is False


def test_keepalive_without_a_person_is_not_a_tap():
    # A real post that must be acknowledged, not an error and not attendance.
    assert ingest.normalise({"dateTime": NOW.isoformat()}, received_at=NOW) is None
    assert (
        ingest.normalise(
            {"AccessControllerEvent": {"serialNo": 9}}, received_at=NOW
        )
        is None
    )


def test_empty_or_malformed_payload_is_not_a_tap():
    assert ingest.normalise({}, received_at=NOW) is None
    assert ingest.normalise([], received_at=NOW) is None  # type: ignore[arg-type]


def test_flattened_payload_from_a_forwarding_collector_still_parses():
    tap = ingest.normalise(
        {
            "employee_no": "1001",
            "name": "Giri",
            "event_serial": 170,
            "event_time": "2026-08-04T11:00:00+04:00",
        },
        received_at=NOW,
    )
    assert tap is not None
    assert tap.device_user_id == "1001"
    assert tap.event_serial == "170"


def test_direction_is_recorded_but_never_authoritative():
    """Stored for the record; the engine derives in/out from first/last tap.

    Staff tap the wrong way round constantly and terminals mislabel after a
    reboot, so a checkOut label on the day's first tap must not make it an
    out-time.
    """

    tap = ingest.normalise(
        _hik(event={"attendanceStatus": "checkOut"}), received_at=NOW
    )
    assert tap is not None
    assert tap.direction == "checkOut"


def test_1970_payload_end_to_end_is_flagged_and_retimed():
    tap = ingest.normalise(
        _hik(dateTime="1970-01-01T01:16:27+04:00"), received_at=NOW
    )
    assert tap is not None
    assert tap.clock_suspect is True
    assert tap.occurred_at == NOW


def test_device_user_id_whitespace_is_trimmed():
    tap = ingest.normalise(
        _hik(event={"employeeNoString": "  OM00044 "}), received_at=NOW
    )
    assert tap is not None
    assert tap.device_user_id == "OM00044"


@pytest.mark.parametrize(
    "value",
    ["2026-08-04T12:30:00Z", "2026-08-04T12:30:00+00:00", "2026-08-04T12:30:00"],
)
def test_timestamp_formats_terminals_actually_send(value):
    assert ingest.parse_datetime(value) is not None


def test_unparseable_timestamp_does_not_raise():
    assert ingest.parse_datetime("not-a-date") is None
    assert ingest.parse_datetime(None) is None
    assert ingest.parse_datetime(12345) is None


# --- log redaction ----------------------------------------------------------
#
# The push token rides in the URL path, and uvicorn's access logger writes
# the whole request line. Without redaction a live credential lands in
# app.log and in ``docker logs`` in plaintext.


def _record(msg, args):
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=args,
        exc_info=None,
    )


def test_access_log_token_is_redacted_from_args():
    rec = _record(
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "POST", "/hik/b1d1-9f3a7?device_name=entrance", "1.1", 200),
    )
    RedactSecretPathsFilter().filter(rec)
    line = rec.getMessage()
    assert "b1d1-9f3a7" not in line
    assert "/hik/***" in line
    # The device label is not a secret and stays readable for diagnostics.
    assert "device_name=entrance" in line


def test_api_alias_path_is_redacted_too():
    rec = _record("%s", ("/api/devices/ingest/b1d1-9f3a7",))
    RedactSecretPathsFilter().filter(rec)
    assert "b1d1-9f3a7" not in rec.getMessage()


def test_redaction_applies_to_a_preformatted_message():
    rec = _record("POST /hik/c47a-1e9d2 failed", None)
    RedactSecretPathsFilter().filter(rec)
    assert "c47a-1e9d2" not in rec.getMessage()


def test_redaction_leaves_ordinary_lines_alone():
    rec = _record("device tap: device_id=%s mapped=%s", (7, True))
    RedactSecretPathsFilter().filter(rec)
    assert rec.getMessage() == "device tap: device_id=7 mapped=True"
