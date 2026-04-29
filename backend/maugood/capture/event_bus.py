"""In-process pub/sub for live detection events (P28.5).

The capture worker emits a ``DetectionEvent`` on every successful
``emit_detection_event``; the Live Capture WebSocket endpoint
subscribes to a per-camera channel and forwards each event as JSON.

Why pub/sub instead of polling ``detection_events`` from the WS
handler:

* Polling adds load proportional to viewer count; pub/sub only
  delivers when something changes.
* The capture worker already owns the moment-of-truth — the
  matcher result, the bbox, the employee_id — and would otherwise
  have to be re-derived by a poll query.
* Process-local. No Redis. The capture worker and the WS handler
  share a process; broadcasting cross-process is a future concern
  that comes with horizontal scaling.

Tenant isolation: subscribers register with ``(tenant_id, camera_id)``
so a stray write to a buggy camera_id can't leak across tenants.
The router enforces tenant scoping *before* subscribing — this
module is the transport, not the gate.

Implementation: an ``asyncio.Queue`` per subscriber. Bounded
(maxsize=64); on overflow we drop the oldest event so a frozen
client doesn't grow memory unbounded. The capture worker publishes
from a thread (not asyncio) — we hop onto the event loop via
``loop.call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DetectionEvent:
    """One detection emitted by the capture pipeline.

    ``event_id`` is the row id from the just-completed
    ``detection_events`` INSERT — included so live viewers can fetch
    the encrypted face crop via ``/api/detection-events/{id}/crop``
    without an extra round trip to look up the row first. ``None`` is
    permitted so non-DB-backed publishers (tests, ad-hoc) can still
    use this dataclass.
    """

    tenant_id: int
    camera_id: int
    captured_at: float
    employee_id: Optional[int]
    employee_code: Optional[str]
    employee_name: Optional[str]
    confidence: Optional[float]
    bbox: dict
    event_id: Optional[int] = None


@dataclass
class _Subscription:
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    # Coarse stats — useful for debugging "why is my client lagging".
    delivered: int = 0
    dropped: int = 0


class EventBus:
    """Per-(tenant, camera) async fan-out for detection events."""

    QUEUE_MAXSIZE = 64

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Key shape ``(tenant_id, camera_id)``; value = list of subs.
        self._subs: dict[tuple[int, int], list[_Subscription]] = {}

    # ------------------------------------------------------------------
    # Subscriber side (asyncio)
    # ------------------------------------------------------------------

    def subscribe(self, *, tenant_id: int, camera_id: int) -> _Subscription:
        """Register a new async subscriber. Caller awaits on
        ``sub.queue.get()`` and must call ``unsubscribe(sub)`` on exit.
        """

        sub = _Subscription(
            queue=asyncio.Queue(maxsize=self.QUEUE_MAXSIZE),
            loop=asyncio.get_running_loop(),
        )
        key = (tenant_id, camera_id)
        with self._lock:
            self._subs.setdefault(key, []).append(sub)
        return sub

    def unsubscribe(self, *, tenant_id: int, camera_id: int, sub: _Subscription) -> None:
        key = (tenant_id, camera_id)
        with self._lock:
            subs = self._subs.get(key, [])
            try:
                subs.remove(sub)
            except ValueError:
                return
            if not subs:
                self._subs.pop(key, None)

    def subscriber_count(self, *, tenant_id: int, camera_id: int) -> int:
        with self._lock:
            return len(self._subs.get((tenant_id, camera_id), []))

    # ------------------------------------------------------------------
    # Publisher side (thread; capture worker)
    # ------------------------------------------------------------------

    def publish(self, event: DetectionEvent) -> None:
        """Fan out to every subscriber for this (tenant, camera).

        Called from the capture worker thread. Each subscriber owns
        its own asyncio loop reference; we hop onto each loop via
        ``call_soon_threadsafe`` so the queue.put_nowait runs on
        the loop that owns the queue. If a queue is full we drop
        the oldest event for that subscriber — better than blocking
        the producer for a single slow client.
        """

        key = (event.tenant_id, event.camera_id)
        with self._lock:
            targets = list(self._subs.get(key, ()))

        for sub in targets:
            try:
                sub.loop.call_soon_threadsafe(_deliver_or_drop, sub, event)
            except RuntimeError:
                # Loop closed. Caller's unsubscribe just hasn't fired
                # yet — the next subscribe cycle cleans the entry.
                logger.debug(
                    "event_bus: target loop closed for tenant=%d camera=%d",
                    event.tenant_id,
                    event.camera_id,
                )


def _deliver_or_drop(sub: _Subscription, event: DetectionEvent) -> None:
    """Runs on the subscriber's event loop."""

    queue = sub.queue
    if queue.full():
        # Drop oldest, then enqueue the new event.
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        sub.dropped += 1
    queue.put_nowait(event)
    sub.delivered += 1


# Process-global singleton — same lifecycle as ``capture_manager``.
event_bus = EventBus()
