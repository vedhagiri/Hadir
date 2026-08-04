"""Hikvision event collector — getdata.mts-om.com

Terminals cannot reach Maugood (no public address), so they post here and
Maugood fetches from here. One JSON file is the buffer.

    POST /hik/{token}              device posts an event  -> saved to JSON
    GET  /hik/{token}/events       Maugood fetches unsynced events
    POST /hik/{token}/events/ack   Maugood confirms it stored them

The token in the URL is the credential for all three. There is no separate
API key: the device is registered with that URL, and the same URL reads
back only that device's own events.

Duplicates are dropped on write. A terminal that misses our 200 resends
the same event, and the retry must not become a second attendance record.

Run:
    pip install fastapi uvicorn
    uvicorn main:app --host 0.0.0.0 --port 8080
"""

import json
import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone

from fastapi import Body, FastAPI, HTTPException, Query, Request

app = FastAPI()

# device registry: path token -> (branch, device)
DEVICES = {
    "b1d1-9f3a7": ("branch1", "device1"),
    "b1d2-2k8d1m": ("branch1", "device2"),
    # ... all 20
}

# Where the buffer lives. Point this somewhere persistent — the default is
# relative to the working directory.
STORE = os.environ.get("COLLECTOR_STORE", "events.json")

# How long a synced event stays in the file before being dropped. Long
# enough to re-fetch after a Maugood rebuild, short enough that the file
# stays small (every write rewrites it whole).
RETAIN_SYNCED_HOURS = 48

_lock = threading.Lock()
_events = []          # in-memory mirror; the file is the durable copy
_next_id = 1
_seen = set()         # dedup keys of everything currently in _events


# --- storage ----------------------------------------------------------------


def _dedup_key(token, payload):
    """Identity of one tap.

    serialNo alone is not enough — a terminal restarts its counter at zero
    after a factory reset, so old serials come round again. Pairing it with
    the event time keeps a reset device producing fresh keys.
    """

    ev = payload.get("AccessControllerEvent") or {}
    return f"{token}|{ev.get('serialNo')}|{payload.get('dateTime')}"


def _load():
    global _events, _next_id, _seen
    try:
        with open(STORE, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        _events, _next_id, _seen = [], 1, set()
        return
    except (json.JSONDecodeError, OSError) as exc:
        # Refuse to start on a damaged file. Starting empty would silently
        # discard an unsynced backlog, which is the one thing this server
        # exists to prevent.
        raise RuntimeError(
            f"{STORE} is unreadable ({exc}). Move it aside to start fresh — "
            f"do not delete it if events are still unsynced."
        ) from exc

    _events = data.get("events", []) if isinstance(data, dict) else []
    _next_id = max((int(e.get("id", 0)) for e in _events), default=0) + 1
    _seen = {
        _dedup_key(e.get("token", ""), e.get("payload") or {}) for e in _events
    }


def _save():
    """Atomic whole-file write. Caller holds _lock.

    Temp file in the same directory, fsync, then os.replace — atomic on
    POSIX. A crash leaves either the old file or the new one, never a
    half-written one.
    """

    directory = os.path.dirname(os.path.abspath(STORE)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".events-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"events": _events}, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, STORE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _purge():
    """Drop synced events past retention. Caller holds _lock."""

    cutoff = (
        datetime.now(tz=timezone.utc) - timedelta(hours=RETAIN_SYNCED_HOURS)
    ).isoformat()
    before = len(_events)
    kept = [
        e for e in _events
        if e.get("synced_at") is None or e["synced_at"] >= cutoff
    ]
    if len(kept) == before:
        return 0
    dropped = [e for e in _events if e not in kept]
    for e in dropped:
        _seen.discard(_dedup_key(e.get("token", ""), e.get("payload") or {}))
    _events[:] = kept
    return before - len(kept)


_load()


def _check_token(token):
    if token not in DEVICES:
        raise HTTPException(status_code=401)
    return DEVICES[token]


# --- device posts here ------------------------------------------------------


async def parse_hik_payload(request: Request) -> dict:
    """JSON body, or the JSON part of a multipart post (picture upload on)."""

    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart" in ctype:
        form = await request.form()
        # Prefer the parts Hikvision names, so a stray text field starting
        # with "{" can't be mistaken for the event.
        for key in ("event_log", "AccessControllerEvent", "json", "data"):
            raw = form.get(key)
            if isinstance(raw, str) and raw.strip().startswith("{"):
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    continue
        for value in form.values():
            if isinstance(value, str) and value.strip().startswith("{"):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    continue
        return {}
    try:
        return await request.json()
    except Exception:
        # A malformed body must not 500 — the device would just resend it.
        return {}


@app.post("/hik/{token}")
async def receive_event(token: str, request: Request):
    branch, device = _check_token(token)

    data = await parse_hik_payload(request)
    device_name = request.query_params.get("device_name")   # optional

    global _next_id
    with _lock:
        key = _dedup_key(token, data)
        ev = data.get("AccessControllerEvent") or {}
        # Keepalives carry no serial or time, so every one would collide.
        # Only dedup real taps.
        if ev.get("employeeNoString") and key in _seen:
            return {"status": "ok"}       # already have it

        _events.append({
            "id": _next_id,
            "token": token,
            "branch": branch,
            "device": device,
            "device_name": device_name,
            "received_at": datetime.now(tz=timezone.utc).isoformat(),
            "payload": data,
            "synced_at": None,
        })
        if ev.get("employeeNoString"):
            _seen.add(key)
        _next_id += 1
        _save()

    # ALWAYS 200, or the device keeps resending.
    return {"status": "ok"}


# --- Maugood fetches from here ----------------------------------------------


@app.get("/hik/{token}/events")
def fetch_events(token: str, limit: int = Query(200, ge=1, le=1000)):
    """Unsynced events for this device, oldest first.

    Order matters: Maugood derives in/out from tap order, so serving these
    out of sequence would produce a wrong attendance row.
    """

    _check_token(token)
    with _lock:
        pending = [
            e for e in _events
            if e["token"] == token and e.get("synced_at") is None
        ]
        batch = sorted(pending, key=lambda e: e["id"])[:limit]
        return {
            "items": [
                {
                    "id": e["id"],
                    "device_name": e.get("device_name"),
                    "received_at": e["received_at"],
                    "payload": e.get("payload") or {},
                }
                for e in batch
            ],
            "pending": len(pending),
        }


@app.post("/hik/{token}/events/ack")
def ack_events(token: str, body: dict = Body(...)):
    """Mark events synced, so they stop being served.

    Maugood calls this only after storing them. Anything unacked comes back
    on the next fetch — losing an ack costs a repeat, not a lost tap.
    """

    _check_token(token)
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return {"acked": 0, "purged": 0}

    wanted = {int(i) for i in ids}
    now = datetime.now(tz=timezone.utc).isoformat()
    with _lock:
        acked = 0
        for e in _events:
            if (
                e["token"] == token
                and e["id"] in wanted
                and e.get("synced_at") is None
            ):
                e["synced_at"] = now
                acked += 1
        purged = _purge()
        _save()
    return {"acked": acked, "purged": purged}


@app.get("/hik/{token}/status")
def device_status(token: str):
    """Is anything backing up for this device?"""

    branch, device = _check_token(token)
    with _lock:
        mine = [e for e in _events if e["token"] == token]
        pending = [e for e in mine if e.get("synced_at") is None]
        return {
            "branch": branch,
            "device": device,
            "pending": len(pending),
            "total": len(mine),
            "last_received_at": max((e["received_at"] for e in mine), default=None),
            "oldest_pending_at": min(
                (e["received_at"] for e in pending), default=None
            ),
        }


# --- unauthenticated ---------------------------------------------------------


@app.get("/")
async def root():
    return {"message": "Hikvision Event Server Running"}


@app.get("/health")
async def health():
    with _lock:
        pending = sum(1 for e in _events if e.get("synced_at") is None)
    return {
        "status": "ok",
        "service": "hikvision-event-server",
        "pending": pending,
    }
