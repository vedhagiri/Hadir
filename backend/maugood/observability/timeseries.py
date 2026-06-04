"""In-memory ring buffer for host-resource history.

A background thread samples CPU / memory / swap / disk I/O / network
every ``SAMPLE_INTERVAL_S`` seconds and appends one row to a
``collections.deque`` keyed by category. The Resources tab polls
``/api/operations/resources/timeseries`` every 10 s and renders
whichever slice the operator asked for.

Design choices documented inline so a future session can reason
about the trade-offs without re-deriving them:

* **In-memory, not a table.** Persisting per-tick rows in Postgres
  would balloon the row count (24h × 360 ticks/h = 8640 rows) for
  data that is operational, not auditable — the audit log already
  captures state-changing actions. On backend restart we lose the
  history; that's acceptable since the operator restarted the box
  themselves and the history before that point is no longer
  comparable.
* **Lock-protected deque.** ``deque`` is thread-safe for
  ``append`` + iteration, but we wrap reads in a lock so the
  router's snapshot is consistent across categories
  (CPU/memory/swap come from the same tick).
* **24h cap at 10 s intervals = 8640 rows.** ~80 B per row
  × 8640 = ~700 KB. Negligible.
* **Best-effort sampling.** Any psutil failure logs at WARN and
  skips that tick. A bad tick must not stop the sampler.

Started + stopped from ``main.create_app`` lifespan.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Optional

from maugood.observability import host_metrics

logger = logging.getLogger(__name__)


SAMPLE_INTERVAL_S = 10.0
MAX_SAMPLES = int((24 * 60 * 60) / SAMPLE_INTERVAL_S)  # 24h at 10s = 8640


@dataclass
class Sample:
    """One tick of host telemetry.

    Wall-clock seconds since the epoch in ``ts`` so the frontend can
    use it directly with ``new Date(ts*1000)``. All other fields are
    floats with sensible zero defaults so the JSON shape is stable
    even when psutil fails on one field.
    """

    ts: float = 0.0
    cpu_percent: float = 0.0
    mem_percent: float = 0.0
    mem_used_mb: int = 0
    swap_percent: float = 0.0
    swap_used_mb: int = 0
    disk_read_mb_s: float = 0.0
    disk_write_mb_s: float = 0.0
    net_recv_mb_s: float = 0.0
    net_sent_mb_s: float = 0.0
    backend_cpu_percent: float = 0.0
    backend_mem_mb: float = 0.0


@dataclass
class _State:
    samples: deque[Sample] = field(
        default_factory=lambda: deque(maxlen=MAX_SAMPLES)
    )
    lock: threading.Lock = field(default_factory=threading.Lock)


_state = _State()
_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()


def _sample_once() -> Optional[Sample]:
    """Take one telemetry snapshot. Returns ``None`` on total failure.

    A partial failure (one psutil reader raises) zeros that field but
    still records the row — operators care about gaps in the chart,
    not pristine data.
    """

    try:
        cpu = host_metrics.read_host_cpu_mem()
    except Exception as exc:  # noqa: BLE001
        logger.warning("timeseries cpu/mem read failed: %s", type(exc).__name__)
        return None

    # Independent cache key so the chart's 10 s rate doesn't fight
    # the /host endpoint's 5 s polling for the same prev-sample slot.
    try:
        disk = host_metrics.read_host_disk(cache_key="timeseries")
    except Exception:  # noqa: BLE001
        disk = host_metrics.HostDisk()

    try:
        net = host_metrics.read_host_network(cache_key="timeseries")
    except Exception:  # noqa: BLE001
        net = host_metrics.HostNetwork()

    try:
        backend = host_metrics.read_backend_process()
    except Exception:  # noqa: BLE001
        backend = host_metrics.BackendProcess()

    return Sample(
        ts=time.time(),
        cpu_percent=float(cpu.cpu_percent),
        mem_percent=float(cpu.mem_percent),
        mem_used_mb=int(cpu.mem_used_mb),
        swap_percent=float(cpu.swap_percent),
        swap_used_mb=int(cpu.swap_used_mb),
        disk_read_mb_s=float(disk.read_mb_s or 0.0),
        disk_write_mb_s=float(disk.write_mb_s or 0.0),
        net_recv_mb_s=float(net.recv_mb_s or 0.0),
        net_sent_mb_s=float(net.sent_mb_s or 0.0),
        backend_cpu_percent=float(backend.cpu_percent),
        backend_mem_mb=float(backend.memory_mb),
    )


def _run() -> None:
    """Sampling loop. Sleeps in small slices so shutdown is prompt."""

    logger.info(
        "timeseries sampler started (interval=%.1fs, max_samples=%d)",
        SAMPLE_INTERVAL_S,
        MAX_SAMPLES,
    )
    # Prime the disk + net rate caches so the first stored sample has
    # real numbers rather than zeros from a missing prev frame.
    _sample_once()
    while not _stop_event.is_set():
        # Sleep up front so the first sample after prime is one full
        # interval later — gives the rate caches time to differentiate.
        if _stop_event.wait(SAMPLE_INTERVAL_S):
            break
        s = _sample_once()
        if s is None:
            continue
        with _state.lock:
            _state.samples.append(s)
    logger.info("timeseries sampler stopped")


def start() -> None:
    """Spawn the sampling thread. Idempotent."""

    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(
        target=_run, name="resources-timeseries", daemon=True
    )
    _thread.start()


def stop() -> None:
    """Signal the sampling thread to stop and join briefly."""

    global _thread
    _stop_event.set()
    if _thread is not None:
        _thread.join(timeout=2.0)
        _thread = None


def snapshot(since_ts: float = 0.0) -> list[Sample]:
    """Return all samples with ``ts >= since_ts``, oldest first.

    ``since_ts=0`` returns the full ring buffer (up to 24 h).
    """

    with _state.lock:
        if since_ts <= 0:
            return list(_state.samples)
        return [s for s in _state.samples if s.ts >= since_ts]


def reset_for_test() -> None:
    """Test-only: clear the ring buffer.

    Lives here rather than in ``conftest.py`` so the sampler module
    owns its own test surface; the conftest just calls this when
    needed.
    """

    with _state.lock:
        _state.samples.clear()


def inject_for_test(samples: Iterable[Sample]) -> None:
    """Test-only: seed deterministic samples."""

    with _state.lock:
        _state.samples.clear()
        for s in samples:
            _state.samples.append(s)
