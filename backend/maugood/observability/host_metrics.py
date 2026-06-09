"""Shared psutil-backed host-metric helpers consumed by P29 endpoints.

The three existing endpoints that already read psutil
(``super_admin/system.py``, ``person_clips/router.py``,
``diagnostics/router.py``) intentionally keep their inline reads —
their response shapes are public API contracts and a behaviour-
preserving refactor isn't worth the regression risk here. This
module is consumed *only* by the new ``/api/operations/resources/*``
endpoints.

Every reader degrades gracefully: a single psutil failure returns
zero / None for that field rather than raising. Operators must be
able to load the Resources tab even on a sandboxed Docker host that
hides load average etc.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from maugood.config import get_settings


# ---------------------------------------------------------------------------
# Output dataclasses (kept dataclass not Pydantic so they round-trip cheap
# into the router's BaseModel without an extra coercion pass).
# ---------------------------------------------------------------------------


@dataclass
class HostCpuMem:
    cpu_percent: float = 0.0
    cpu_per_core: list[float] = field(default_factory=list)
    cpu_count_logical: int = 0
    cpu_count_physical: int = 0
    load_avg_1m: Optional[float] = None
    load_avg_5m: Optional[float] = None
    load_avg_15m: Optional[float] = None
    mem_used_mb: int = 0
    mem_total_mb: int = 0
    mem_available_mb: int = 0
    mem_percent: float = 0.0
    swap_used_mb: int = 0
    swap_total_mb: int = 0
    swap_percent: float = 0.0
    uptime_sec: int = 0


@dataclass
class HostDisk:
    data_partition_path: str = "/"
    used_gb: float = 0.0
    total_gb: float = 0.0
    percent: float = 0.0
    read_mb_s: Optional[float] = None
    write_mb_s: Optional[float] = None


@dataclass
class HostNetwork:
    sent_mb_s: Optional[float] = None
    recv_mb_s: Optional[float] = None


@dataclass
class BackendProcess:
    cpu_percent: float = 0.0
    memory_mb: float = 0.0
    threads: int = 0
    open_files: int = 0


@dataclass
class ThreadInfo:
    name: str = ""
    daemon: bool = False
    alive: bool = True
    cpu_user_s: Optional[float] = None
    cpu_system_s: Optional[float] = None


@dataclass
class ThreadCategory:
    category: str = ""
    display: str = ""
    count: int = 0
    cpu_user_s: float = 0.0
    cpu_system_s: float = 0.0
    threads: list[ThreadInfo] = field(default_factory=list)


@dataclass
class ThreadBreakdown:
    total: int = 0
    categories: list[ThreadCategory] = field(default_factory=list)


@dataclass
class HostGpu:
    available: bool = False
    percent: Optional[float] = None
    memory_used_mb: Optional[float] = None
    memory_total_mb: Optional[float] = None


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


def read_host_cpu_mem() -> HostCpuMem:
    """CPU + memory + swap + load avg + uptime. Best-effort."""

    import psutil  # noqa: PLC0415

    out = HostCpuMem()

    try:
        out.cpu_percent = round(float(psutil.cpu_percent(interval=None)), 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        out.cpu_per_core = [
            round(float(v), 1)
            for v in psutil.cpu_percent(percpu=True, interval=None) or []
        ]
    except Exception:  # noqa: BLE001
        pass

    try:
        out.cpu_count_logical = int(psutil.cpu_count(logical=True) or 0)
    except Exception:  # noqa: BLE001
        pass
    try:
        out.cpu_count_physical = int(psutil.cpu_count(logical=False) or 0)
    except Exception:  # noqa: BLE001
        pass

    try:
        load = os.getloadavg()
        out.load_avg_1m = round(float(load[0]), 2)
        out.load_avg_5m = round(float(load[1]), 2)
        out.load_avg_15m = round(float(load[2]), 2)
    except (OSError, AttributeError):
        # Windows / sandboxed env without /proc.
        pass

    try:
        mem = psutil.virtual_memory()
        out.mem_total_mb = int(mem.total / (1024 * 1024))
        out.mem_used_mb = int((mem.total - mem.available) / (1024 * 1024))
        out.mem_available_mb = int(mem.available / (1024 * 1024))
        out.mem_percent = round(float(mem.percent), 1)
    except Exception:  # noqa: BLE001
        pass

    try:
        swap = psutil.swap_memory()
        out.swap_total_mb = int(swap.total / (1024 * 1024))
        out.swap_used_mb = int(swap.used / (1024 * 1024))
        out.swap_percent = round(float(swap.percent), 1)
    except Exception:  # noqa: BLE001
        pass

    try:
        boot = float(psutil.boot_time())
        out.uptime_sec = max(0, int(time.time() - boot))
    except Exception:  # noqa: BLE001
        pass

    return out


# Sample-on-call rate caches keyed on the calling function's identity.
# A first call returns 0 (no previous sample); the second call yields
# real bytes/sec rates from the delta.
_disk_rate_prev: dict[str, tuple[float, int, int]] = {}
_net_rate_prev: dict[str, tuple[float, int, int]] = {}


def read_host_disk(cache_key: str = "operations_resources") -> HostDisk:
    """Disk usage on the faces partition + sample-on-call I/O rates.

    ``cache_key`` lets concurrent consumers (Resources tab vs. tests)
    keep separate prev-sample state. The default key is fine for the
    request-path use case.
    """

    import psutil  # noqa: PLC0415

    settings = get_settings()
    base = settings.faces_storage_path or "/data"

    out = HostDisk(data_partition_path=str(base))

    try:
        du = psutil.disk_usage(str(base))
        out.used_gb = round(du.used / (1024**3), 2)
        out.total_gb = round(du.total / (1024**3), 2)
        out.percent = round(float(du.percent), 1)
    except Exception:  # noqa: BLE001
        try:
            du = psutil.disk_usage("/")
            out.used_gb = round(du.used / (1024**3), 2)
            out.total_gb = round(du.total / (1024**3), 2)
            out.percent = round(float(du.percent), 1)
            out.data_partition_path = "/"
        except Exception:  # noqa: BLE001
            pass

    # Sample-on-call I/O rate.
    try:
        io = psutil.disk_io_counters()
        if io is not None:
            now = time.time()
            prev = _disk_rate_prev.get(cache_key)
            if prev is not None:
                dt = max(0.001, now - prev[0])
                out.read_mb_s = round(
                    max(0.0, (io.read_bytes - prev[1]) / 1024 / 1024 / dt), 3
                )
                out.write_mb_s = round(
                    max(0.0, (io.write_bytes - prev[2]) / 1024 / 1024 / dt), 3
                )
            _disk_rate_prev[cache_key] = (
                now,
                int(io.read_bytes),
                int(io.write_bytes),
            )
    except Exception:  # noqa: BLE001
        pass

    return out


def read_host_network(cache_key: str = "operations_resources") -> HostNetwork:
    """Sample-on-call host-wide network throughput in MB/s."""

    import psutil  # noqa: PLC0415

    out = HostNetwork()
    try:
        net = psutil.net_io_counters()
        if net is not None:
            now = time.time()
            prev = _net_rate_prev.get(cache_key)
            if prev is not None:
                dt = max(0.001, now - prev[0])
                out.sent_mb_s = round(
                    max(0.0, (net.bytes_sent - prev[1]) / 1024 / 1024 / dt), 3
                )
                out.recv_mb_s = round(
                    max(0.0, (net.bytes_recv - prev[2]) / 1024 / 1024 / dt), 3
                )
            _net_rate_prev[cache_key] = (
                now,
                int(net.bytes_sent),
                int(net.bytes_recv),
            )
    except Exception:  # noqa: BLE001
        pass
    return out


def read_backend_process() -> BackendProcess:
    """psutil self-introspection on the backend uvicorn worker."""

    import psutil  # noqa: PLC0415

    out = BackendProcess()
    try:
        proc = psutil.Process(os.getpid())
        try:
            out.cpu_percent = round(float(proc.cpu_percent(interval=None)), 1)
        except Exception:  # noqa: BLE001
            pass
        try:
            out.memory_mb = round(proc.memory_info().rss / 1024 / 1024, 1)
        except Exception:  # noqa: BLE001
            pass
        try:
            out.threads = int(proc.num_threads())
        except Exception:  # noqa: BLE001
            pass
        try:
            out.open_files = int(len(proc.open_files()))
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass
    return out


def read_gpu_optional() -> HostGpu:
    """Optional NVIDIA GPU stats via pynvml. Silent no-op without it."""

    out = HostGpu()
    try:
        import pynvml  # type: ignore[import-untyped]  # noqa: PLC0415

        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        out.available = True
        out.percent = round(float(util.gpu), 1)
        out.memory_used_mb = round(mem_info.used / 1024 / 1024, 1)
        out.memory_total_mb = round(mem_info.total / 1024 / 1024, 1)
    except Exception:  # noqa: BLE001
        pass
    return out


# ---------------------------------------------------------------------------
# Thread breakdown — answers "what are these N threads doing?"
# ---------------------------------------------------------------------------


# Category code → (display label, ordered list of name-match predicates).
# Match order matters: more-specific matches first. The first hit wins.
# Display names are i18n keys — the frontend keys off ``category`` and
# falls back to ``display`` when a translation is missing.
def _classify_thread_name(name: str) -> str:
    """Bucket a Python thread name into one of the operational
    categories. Pure — no I/O. The names mirror the actual
    ``threading.Thread(name=…)`` literals grepped from the codebase.
    """

    n = name
    nl = n.lower()
    if n.startswith("capread-"):
        return "camera_readers"
    if n.startswith("capana-"):
        return "camera_analyzers"
    if n.startswith("clipwk-"):
        return "clip_writers"
    if n.startswith("rtsp-seg-"):
        return "rtsp_segmenters"
    if (
        n.startswith("facematch-")
        or n.startswith("face-match-")
        or "reprocess" in nl
    ):
        return "face_matching"
    if n.startswith("clip-pipeline") or n.startswith("reconcile-"):
        return "clip_pipeline"
    if n.startswith("face-crop"):
        return "face_crops"
    if n.startswith("attendance"):
        return "attendance"
    if n.startswith("enroll"):
        return "enrollment"
    if "notification" in nl:
        return "notifications"
    if "report" in nl and ("runner" in nl or "schedul" in nl):
        return "scheduled_reports"
    if "retention" in nl:
        return "retention"
    # APScheduler internals + plain "BackgroundScheduler" sub-threads.
    if "scheduler" in nl or "apsched" in nl:
        return "schedulers"
    if n == "MainThread":
        return "main"
    # uvicorn / starlette worker-pool threads.
    if (
        "anyio" in nl
        or "asyncworker" in nl
        or n.startswith("ThreadPoolExecutor")
    ):
        return "request_handlers"
    return "other"


_CATEGORY_DISPLAY: dict[str, str] = {
    "camera_readers": "Camera readers (RTSP read loop)",
    "camera_analyzers": "Camera analyzers (detect + match)",
    "clip_writers": "Clip writers (ffmpeg encode)",
    "rtsp_segmenters": "RTSP segmenters",
    "face_matching": "Face matching (UC1/UC2 reprocess)",
    "clip_pipeline": "Clip pipeline workers",
    "face_crops": "Face crop batch",
    "attendance": "Attendance scheduler",
    "enrollment": "Photo enrollment backfill",
    "notifications": "Notification worker",
    "scheduled_reports": "Scheduled reports runner",
    "retention": "Retention sweep",
    "schedulers": "Background schedulers",
    "main": "FastAPI main",
    "request_handlers": "Request handler pool",
    "other": "Other",
}


def read_thread_breakdown() -> ThreadBreakdown:
    """Snapshot every Python thread in this process + classify by
    name prefix into operational categories.

    Per-thread CPU time (user + system, in seconds since process
    start) is sourced from ``psutil.Process.threads()`` and linked to
    ``Thread.native_id`` (Python 3.8+); when the link doesn't resolve
    the CPU fields stay ``None`` and the UI shows ``—``.

    Categories are sorted by count desc so the busiest buckets appear
    first.
    """

    import threading  # noqa: PLC0415

    import psutil  # noqa: PLC0415

    psutil_threads: dict[int, Any] = {}
    try:
        proc = psutil.Process(os.getpid())
        for th in proc.threads():
            psutil_threads[int(th.id)] = th
    except Exception:  # noqa: BLE001
        psutil_threads = {}

    by_cat: dict[str, list[ThreadInfo]] = {}
    for t in threading.enumerate():
        tid = getattr(t, "native_id", None)
        ps_th = psutil_threads.get(int(tid)) if tid is not None else None
        info = ThreadInfo(
            name=str(t.name),
            daemon=bool(t.daemon),
            alive=bool(t.is_alive()),
            cpu_user_s=(
                round(float(ps_th.user_time), 2) if ps_th is not None else None
            ),
            cpu_system_s=(
                round(float(ps_th.system_time), 2)
                if ps_th is not None
                else None
            ),
        )
        cat = _classify_thread_name(info.name)
        by_cat.setdefault(cat, []).append(info)

    categories: list[ThreadCategory] = []
    total = 0
    for cat, items in by_cat.items():
        cpu_user = sum(
            (x.cpu_user_s or 0.0) for x in items if x.cpu_user_s is not None
        )
        cpu_sys = sum(
            (x.cpu_system_s or 0.0) for x in items if x.cpu_system_s is not None
        )
        categories.append(
            ThreadCategory(
                category=cat,
                display=_CATEGORY_DISPLAY.get(cat, cat),
                count=len(items),
                cpu_user_s=round(cpu_user, 2),
                cpu_system_s=round(cpu_sys, 2),
                # Stable per-category ordering so polling doesn't shuffle
                # the UI rows.
                threads=sorted(items, key=lambda x: x.name),
            )
        )
        total += len(items)

    categories.sort(key=lambda c: (-c.count, c.category))
    return ThreadBreakdown(total=total, categories=categories)


@dataclass
class ProcessRow:
    """One row in the top-processes table.

    ``cpu_percent`` is psutil's process-level reading at sample time;
    on a fresh-spawned process the first call returns 0 — by design.
    ``swap_mb`` is Linux-only (reads ``/proc/<pid>/status.VmSwap``);
    ``None`` on macOS / Windows / sandboxed Docker without /proc.
    """

    pid: int = 0
    name: str = ""
    cmdline_short: str = ""
    user: str = ""
    cpu_percent: float = 0.0
    memory_mb: float = 0.0
    memory_percent: float = 0.0
    swap_mb: Optional[float] = None
    threads: int = 0
    create_time: float = 0.0


def _read_proc_swap_mb(pid: int) -> Optional[float]:
    """Linux: read ``VmSwap:`` from ``/proc/<pid>/status``. Returns MB
    as float, or ``None`` when unavailable."""

    try:
        with open(f"/proc/{pid}/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("VmSwap:"):
                    # ``VmSwap:       123 kB``
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].isdigit():
                        return round(int(parts[1]) / 1024.0, 1)
                    return 0.0
    except (FileNotFoundError, PermissionError, OSError):
        return None
    # No VmSwap line — swap not used.
    return 0.0


def read_top_processes(limit: int = 10) -> list[ProcessRow]:
    """Return the top-``limit`` processes on the host by CPU%.

    The caller asks for one "most interesting" sort and we hand back
    a single list — frontend can re-sort client-side by CPU / memory
    / swap from the same payload (saves a round-trip per tab change).
    Each row is sampled twice 100 ms apart so psutil's
    ``cpu_percent`` reading is non-zero on first call.
    """

    import psutil  # noqa: PLC0415

    rows: list[ProcessRow] = []
    # First pass primes ``cpu_percent``.
    procs: list[Any] = []
    try:
        for proc in psutil.process_iter(
            ["pid", "name", "username", "create_time"]
        ):
            try:
                proc.cpu_percent(interval=None)
                procs.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception as exc:  # noqa: BLE001
        # If we can't iterate at all, return empty.
        return rows

    # Brief sleep so the next cpu_percent call has a delta to work with.
    time.sleep(0.1)

    n_cpu = max(1, psutil.cpu_count(logical=True) or 1)

    for proc in procs:
        try:
            info = proc.info
            cpu_pct = float(proc.cpu_percent(interval=None))
            try:
                mem = proc.memory_info()
                mem_mb = round(mem.rss / 1024 / 1024, 1)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                mem_mb = 0.0
            try:
                mem_pct = round(float(proc.memory_percent()), 2)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                mem_pct = 0.0
            try:
                threads = int(proc.num_threads())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                threads = 0
            try:
                cmd_parts = proc.cmdline() or []
                cmd_short = " ".join(cmd_parts)[:120]
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                cmd_short = ""
            swap_mb = _read_proc_swap_mb(int(info["pid"]))
            rows.append(
                ProcessRow(
                    pid=int(info["pid"]),
                    name=str(info.get("name") or ""),
                    cmdline_short=cmd_short,
                    user=str(info.get("username") or ""),
                    # Normalise: psutil reports cumulative across cores
                    # (>100% possible), normalise to single-core scale
                    # for display — matches the host CPU gauge.
                    cpu_percent=round(cpu_pct / n_cpu, 1),
                    memory_mb=mem_mb,
                    memory_percent=mem_pct,
                    swap_mb=swap_mb,
                    threads=threads,
                    create_time=float(info.get("create_time") or 0.0),
                )
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        except Exception:  # noqa: BLE001
            continue

    # Sort by combined cost — CPU + memory share gives "biggest
    # contributor to current pressure" without picking one or the
    # other; the frontend re-sorts per tab anyway.
    rows.sort(
        key=lambda r: (r.cpu_percent + r.memory_percent),
        reverse=True,
    )
    return rows[:limit]


def face_crops_size(base_path: Optional[str] = None) -> tuple[int, float]:
    """Return ``(file_count, total_gb)`` for the face-crops tree.

    Bounded by disk size — on a fresh box a few files; on a long-running
    pilot tens of thousands. Returns ``(0, 0.0)`` if the path is absent
    or unreadable.
    """

    settings = get_settings()
    base = Path(base_path or settings.faces_storage_path or "/data")
    captures = base / "captures"
    if not captures.exists():
        return 0, 0.0

    count = 0
    total_bytes = 0
    try:
        for p in captures.rglob("*.jpg"):
            try:
                total_bytes += p.stat().st_size
                count += 1
            except OSError:
                continue
    except Exception:  # noqa: BLE001
        return count, round(total_bytes / (1024**3), 3)
    return count, round(total_bytes / (1024**3), 3)
