"""StageQueue — bounded Queue + always-on worker thread(s).

The pipeline has two stages (Cropping, Matching). Each is a
``StageQueue`` instance with:

* one ``queue.Queue`` (bounded; full submissions are rejected so a
  runaway operator can't OOM the backend),
* N daemon worker threads (default 1 per stage — see module
  docstring on the package for the bottleneck rationale),
* observable counters the Pipeline Monitor reads every second:
  queue depth, in-flight job count, lifetime processed / failed.

The handler is injected: ``ClipPipeline`` wires its ``_handle_crop``
into the cropping stage and ``_handle_match`` into the matching
stage. The stage knows nothing about clips or use cases.
"""

from __future__ import annotations

import collections
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Generic, Optional, TypeVar

logger = logging.getLogger(__name__)


T = TypeVar("T")


# Rolling window sizes for the per-stage health + speed columns. Kept
# small so the deques don't burn memory on a long-running stage:
# * ``_RECENT_DURATIONS_MAX`` — last N completed job durations; powers
#   the median / p95 processing-time stats.
# * ``_RECENT_ERRORS_MAX`` — last N failures; used both for the error
#   rate and for the drill-down panel's recent-errors list.
_RECENT_DURATIONS_MAX = 50
_RECENT_ERRORS_MAX = 20
# A job that's been "in flight" for longer than this is considered
# stalled — surfaces in the worker health pill.
_STALLED_AFTER_S = 120.0


@dataclass
class WorkerSlot:
    """One always-on worker's observable state."""

    name: str
    busy: bool = False
    # Lightweight description of the currently-processing job — the
    # frontend renders this in the "current active worker tasks" panel.
    # Empty string when idle.
    current_job: str = ""
    # Wall-clock when the current job was picked up. Lets the UI show
    # "running for 12 s" live without a separate query.
    current_job_started_at: Optional[float] = None


@dataclass
class StageStats:
    queue_depth: int = 0
    in_flight: int = 0
    lifetime_processed: int = 0
    lifetime_failed: int = 0
    workers: list[dict[str, Any]] = field(default_factory=list)
    # Speed (None when no completed jobs yet — UI renders "—").
    median_duration_ms: Optional[float] = None
    p95_duration_ms: Optional[float] = None
    avg_duration_ms: Optional[float] = None
    # Health — derived bucket so the UI doesn't have to compute.
    # One of: "healthy" (no stalls + low error rate),
    #         "degraded" (recent failures > 0 but workers still running),
    #         "stalled" (at least one worker has been on a single job
    #          longer than _STALLED_AFTER_S),
    #         "idle" (no workers busy and no recent activity).
    health: str = "idle"
    # Failures in the last hour (rolling window).
    failures_last_hour: int = 0
    # Recent errors — drill-down for the dashboard side panel.
    recent_errors: list[dict[str, Any]] = field(default_factory=list)


class StageQueue(Generic[T]):
    """Bounded FIFO + worker pool wrapper.

    Jobs flow in via ``submit`` and out via ``handler``. Each worker
    blocks on ``queue.get`` (timed) so ``stop`` can unwind cleanly.
    """

    def __init__(
        self,
        name: str,
        handler: Callable[[T], None],
        *,
        worker_count: int = 1,
        max_depth: int = 4096,
    ) -> None:
        self._name = name
        self._handler = handler
        self._worker_count = max(1, int(worker_count))
        self._queue: "queue.Queue[T]" = queue.Queue(maxsize=int(max_depth))
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._workers: list[threading.Thread] = []
        self._slots: list[WorkerSlot] = []
        self._in_flight = 0
        self._lifetime_processed = 0
        self._lifetime_failed = 0
        # Speed + health tracking. Bounded deques — see _RECENT_*_MAX.
        self._recent_durations_ms: "collections.deque[float]" = (
            collections.deque(maxlen=_RECENT_DURATIONS_MAX)
        )
        self._recent_errors: "collections.deque[dict[str, Any]]" = (
            collections.deque(maxlen=_RECENT_ERRORS_MAX)
        )

    # -- lifecycle ----------------------------------------------------

    def start(self) -> None:
        with self._lock:
            if self._workers:
                return
            for i in range(self._worker_count):
                slot = WorkerSlot(name=f"{self._name}-{i + 1}")
                self._slots.append(slot)
                t = threading.Thread(
                    target=self._worker_loop,
                    name=f"{self._name}-worker-{i + 1}",
                    args=(slot,),
                    daemon=True,
                )
                t.start()
                self._workers.append(t)
            logger.info(
                "clip_pipeline stage '%s' started with %d worker(s)",
                self._name,
                self._worker_count,
            )

    def stop(self, *, timeout_s: float = 5.0) -> None:
        self._stop.set()
        for t in list(self._workers):
            t.join(timeout=timeout_s)
        with self._lock:
            self._workers.clear()
            self._slots.clear()
            self._in_flight = 0
        logger.info("clip_pipeline stage '%s' stopped", self._name)

    # -- submission ---------------------------------------------------

    def submit(self, job: T) -> bool:
        """Push a job onto the queue. Returns False when the queue is
        full (operator should back off or retry). Non-blocking."""

        try:
            self._queue.put_nowait(job)
            return True
        except queue.Full:
            logger.warning(
                "clip_pipeline stage '%s' queue full (depth=%d) — dropping job",
                self._name,
                self._queue.maxsize,
            )
            return False

    # -- worker loop --------------------------------------------------

    def _worker_loop(self, slot: WorkerSlot) -> None:
        while not self._stop.is_set():
            try:
                job = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            start_ts = time.time()
            with self._lock:
                self._in_flight += 1
                slot.busy = True
                slot.current_job = _describe_job(job)
                slot.current_job_started_at = start_ts
            try:
                self._handler(job)
                duration_ms = (time.time() - start_ts) * 1000.0
                with self._lock:
                    self._lifetime_processed += 1
                    self._recent_durations_ms.append(duration_ms)
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "clip_pipeline stage '%s' handler failed: %s",
                    self._name,
                    type(exc).__name__,
                )
                with self._lock:
                    self._lifetime_failed += 1
                    self._recent_errors.append(
                        {
                            "at": time.time(),
                            "job": _describe_job(job),
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )
            finally:
                with self._lock:
                    self._in_flight -= 1
                    slot.busy = False
                    slot.current_job = ""
                    slot.current_job_started_at = None
                self._queue.task_done()

    # -- observability ------------------------------------------------

    def stats(self) -> StageStats:
        with self._lock:
            now = time.time()
            workers = [
                {
                    "name": s.name,
                    "busy": s.busy,
                    "current_job": s.current_job,
                    "running_for_s": (
                        round(now - s.current_job_started_at, 2)
                        if s.busy and s.current_job_started_at is not None
                        else None
                    ),
                }
                for s in self._slots
            ]

            # Speed — median / p95 / avg over the rolling window.
            durations = sorted(self._recent_durations_ms)
            median_ms: Optional[float] = None
            p95_ms: Optional[float] = None
            avg_ms: Optional[float] = None
            if durations:
                n = len(durations)
                median_ms = round(durations[n // 2], 1)
                # Nearest-rank p95.
                p95_idx = max(0, min(n - 1, int(round(n * 0.95)) - 1))
                p95_ms = round(durations[p95_idx], 1)
                avg_ms = round(sum(durations) / n, 1)

            # Failures in the last hour.
            hour_ago = now - 3600.0
            failures_last_hour = sum(
                1 for e in self._recent_errors if e.get("at", 0) >= hour_ago
            )

            # Stalled detection — any worker that's been on the same
            # job longer than the threshold.
            stalled = any(
                s.busy
                and s.current_job_started_at is not None
                and (now - s.current_job_started_at) > _STALLED_AFTER_S
                for s in self._slots
            )

            any_busy = any(s.busy for s in self._slots)
            if stalled:
                health = "stalled"
            elif failures_last_hour > 0:
                health = "degraded"
            elif any_busy:
                health = "healthy"
            else:
                # No active work right now but the worker thread is
                # alive — that's the steady-state for an unloaded
                # always-on stage.
                health = "idle"

            recent_errors = [
                {
                    "at": e["at"],
                    "job": e.get("job", ""),
                    "error": e.get("error", ""),
                }
                for e in list(self._recent_errors)[-5:]
            ]

            return StageStats(
                queue_depth=self._queue.qsize(),
                in_flight=self._in_flight,
                lifetime_processed=self._lifetime_processed,
                lifetime_failed=self._lifetime_failed,
                workers=workers,
                median_duration_ms=median_ms,
                p95_duration_ms=p95_ms,
                avg_duration_ms=avg_ms,
                health=health,
                failures_last_hour=failures_last_hour,
                recent_errors=recent_errors,
            )


def _describe_job(job: Any) -> str:
    """Cheap repr used in the WorkerSlot UI. Falls back to type name."""

    clip_id = getattr(job, "clip_id", None)
    use_case = getattr(job, "use_case", None)
    if clip_id is not None and use_case is not None:
        return f"clip #{clip_id} · {str(use_case).upper()}"
    return type(job).__name__
