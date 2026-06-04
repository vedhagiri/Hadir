"""Camera-wise capture diagnostics collector.

Runs *inside the backend container* and continuously records per-camera
and system-level metrics so the operator can pinpoint — with evidence —
where a 21-camera deployment is spending CPU/memory and where frames are
being dropped.

It does NOT invent a parallel pipeline. It harvests the telemetry the
running backend already produces:

* ``GET /api/operations/workers``  (P28.8) — per-camera fps_reader,
  fps_analyzer, native fps, motion-skip, faces/matches, pipeline stage
  colours, recent errors.
* ``GET /api/diagnostics/events``  (the in-memory anomaly ring) — the
  per-frame ``t_read_ms`` / ``t_preview_ms`` / ``t_clip_ms`` breakdown,
  ``detect_ms``, reconnects, read-failures, ffmpeg restarts, analyzer
  starvation.
* ``psutil`` — host CPU (overall + per-core), memory, swap, disk I/O,
  network throughput, load average.
* ``/proc/<pid>/task/<tid>/{comm,stat}`` — per-thread CPU. The capture
  worker threads are named ``capread-<camera_id>`` and
  ``capana-<camera_id>`` (see ``maugood/capture/reader.py``), so reader
  and analyzer CPU is attributable to a specific camera.

Why it must run through the HTTP API (not import ``capture_manager``):
the ``CaptureManager`` singleton + the diagnostics ring live in the
uvicorn worker's memory. A separate ``python -m scripts.…`` process has
its own empty singletons. The HTTP API is the only window into the
*running* workers.

Red lines honoured:
* Never logs an RTSP URL or credentials — only the stage colour /
  worker status (the API never returns the URL anyway).
* Read-only. No DB writes, no mutation of any camera.
* No new dependencies (psutil + httpx ship in the backend image).

Usage (inside the container):

    docker compose exec -T \
      -e DIAG_ADMIN_EMAIL='admin@…' \
      -e DIAG_ADMIN_PASSWORD='…' \
      backend python -m scripts.camera_diagnostics \
        --interval 5 --duration-min 180 --out /data/diag

Then copy ``/data/diag/<run>/`` out and run
``scripts.camera_diagnostics_report`` over it.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import psutil  # type: ignore
except Exception as exc:  # pragma: no cover - psutil ships in the image
    print(f"psutil is required (it ships in the backend image): {exc}", file=sys.stderr)
    raise

try:
    import httpx  # type: ignore
except Exception as exc:  # pragma: no cover - httpx ships in the image
    print(f"httpx is required (it ships in the backend image): {exc}", file=sys.stderr)
    raise


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Camera-wise capture diagnostics collector")
    p.add_argument(
        "--base-url",
        default=os.environ.get("DIAG_BASE_URL", "http://localhost:8000"),
        help="Backend base URL (default http://localhost:8000)",
    )
    p.add_argument(
        "--email",
        default=os.environ.get("DIAG_ADMIN_EMAIL"),
        help="Admin email (or env DIAG_ADMIN_EMAIL)",
    )
    p.add_argument(
        "--password",
        default=os.environ.get("DIAG_ADMIN_PASSWORD"),
        help="Admin password (or env DIAG_ADMIN_PASSWORD). Never logged.",
    )
    p.add_argument(
        "--tenant-slug",
        default=os.environ.get("DIAG_TENANT_SLUG"),
        help="Tenant slug (required only in multi-tenant mode)",
    )
    p.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("DIAG_INTERVAL", "5")),
        help="Seconds between samples (default 5)",
    )
    p.add_argument(
        "--duration-min",
        type=float,
        default=float(os.environ.get("DIAG_DURATION_MIN", "0")),
        help="Stop after N minutes (0 = run until Ctrl-C)",
    )
    p.add_argument(
        "--out",
        default=os.environ.get("DIAG_OUT", "./diag"),
        help="Output directory; a timestamped run subfolder is created",
    )
    p.add_argument(
        "--segments-dir",
        default=os.environ.get(
            "DIAG_SEGMENTS_DIR", "/tmp/maugood-rtsp-segments"
        ),
        help="RTSP segment temp dir to measure on disk",
    )
    p.add_argument(
        "--clips-dir",
        default=os.environ.get("DIAG_CLIPS_DIR", "/clips"),
        help="Final clip storage dir to measure on disk",
    )
    p.add_argument(
        "--keep-ring-on-exit",
        action="store_true",
        help="Leave the diagnostics ring enabled when the script exits",
    )
    p.add_argument(
        "--api-timeout",
        type=float,
        default=float(os.environ.get("DIAG_API_TIMEOUT", "4")),
        help="Per-request HTTP timeout in seconds (keep SHORT — a frozen "
        "backend must not stall the durable OS-level trace; default 4)",
    )
    p.add_argument(
        "--disk-sample-every",
        type=int,
        default=int(os.environ.get("DIAG_DISK_SAMPLE_EVERY", "6")),
        help="Re-walk the segment/clip dirs only every Nth sample (the "
        "walk can stall under load; default 6)",
    )
    return p.parse_args()


# --------------------------------------------------------------------------
# /proc per-thread CPU — maps capread-<id> / capana-<id> threads to cameras
# --------------------------------------------------------------------------


_CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def _read_thread_cpu_ticks(pid: int, tid: int) -> Optional[float]:
    """Return cumulative (utime+stime) in clock ticks for a thread, or None."""
    try:
        with open(f"/proc/{pid}/task/{tid}/stat", "rb") as fh:
            data = fh.read().decode("utf-8", "replace")
        # comm (field 2) is wrapped in parens and may contain spaces/parens;
        # everything after the last ')' is space-delimited and stable.
        rparen = data.rfind(")")
        rest = data[rparen + 2 :].split()
        # After comm, fields are 1-indexed from 'state'; utime=14, stime=15
        # in the full /proc stat layout → here index 11 and 12 (0-based).
        utime = float(rest[11])
        stime = float(rest[12])
        return utime + stime
    except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
        return None


def _scan_capture_threads() -> dict[int, dict[str, list[tuple[int, int]]]]:
    """Find every capread-/capana- thread across all processes.

    Returns ``{camera_id: {"reader": [(pid, tid), …], "analyzer": [...]}}``.
    Robust to a uvicorn restart (pids change) and to >1 worker process.
    """
    out: dict[int, dict[str, list[tuple[int, int]]]] = {}
    for proc in psutil.process_iter(["pid"]):
        pid = proc.info.get("pid")
        if pid is None:
            continue
        task_dir = f"/proc/{pid}/task"
        try:
            tids = os.listdir(task_dir)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for tid_s in tids:
            try:
                with open(f"{task_dir}/{tid_s}/comm", "rb") as fh:
                    comm = fh.read().decode("utf-8", "replace").strip()
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            role: Optional[str] = None
            if comm.startswith("capread-"):
                role = "reader"
            elif comm.startswith("capana-"):
                role = "analyzer"
            else:
                continue
            suffix = comm.split("-", 1)[1]
            try:
                cam_id = int(suffix)
            except ValueError:
                continue
            try:
                tid = int(tid_s)
            except ValueError:
                continue
            slot = out.setdefault(cam_id, {"reader": [], "analyzer": []})
            slot[role].append((pid, tid))
    return out


class ThreadCpuSampler:
    """Computes per-camera reader/analyzer CPU% between successive samples."""

    def __init__(self) -> None:
        self._prev_ticks: dict[tuple[int, int], float] = {}
        self._prev_ts: Optional[float] = None

    def sample(self) -> dict[int, dict[str, float]]:
        """Return ``{camera_id: {"reader_cpu": %, "analyzer_cpu": %}}``."""
        now = time.time()
        threads = _scan_capture_threads()
        new_ticks: dict[tuple[int, int], float] = {}
        per_cam: dict[int, dict[str, float]] = {}

        dt = (now - self._prev_ts) if self._prev_ts else None
        for cam_id, roles in threads.items():
            cam_slot = per_cam.setdefault(
                cam_id, {"reader_cpu": 0.0, "analyzer_cpu": 0.0}
            )
            for role, key_name in (("reader", "reader_cpu"), ("analyzer", "analyzer_cpu")):
                for (pid, tid) in roles[role]:
                    ticks = _read_thread_cpu_ticks(pid, tid)
                    if ticks is None:
                        continue
                    new_ticks[(pid, tid)] = ticks
                    prev = self._prev_ticks.get((pid, tid))
                    if prev is not None and dt and dt > 0:
                        cpu_pct = (ticks - prev) / _CLK_TCK / dt * 100.0
                        cam_slot[key_name] += max(0.0, cpu_pct)
        self._prev_ticks = new_ticks
        self._prev_ts = now
        return per_cam


# --------------------------------------------------------------------------
# Host metrics (psutil)
# --------------------------------------------------------------------------


def _dir_size_mb(path: str, max_entries: int = 200_000) -> float:
    total = 0
    seen = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
                seen += 1
                if seen >= max_entries:
                    return total / (1024 * 1024)
    except OSError:
        return 0.0
    return total / (1024 * 1024)


def _tmp_is_tmpfs(path: str = "/tmp") -> bool:
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3 and parts[1] == path and parts[2] == "tmpfs":
                    return True
    except OSError:
        pass
    return False


class HostSampler:
    def __init__(self) -> None:
        psutil.cpu_percent(interval=None, percpu=True)  # prime
        self._prev_disk = psutil.disk_io_counters()
        self._prev_net = psutil.net_io_counters()
        self._prev_ts = time.time()

    def sample(self) -> dict[str, Any]:
        now = time.time()
        dt = max(1e-6, now - self._prev_ts)
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        overall = sum(per_core) / max(1, len(per_core))
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()

        disk = psutil.disk_io_counters()
        net = psutil.net_io_counters()
        disk_r = (disk.read_bytes - self._prev_disk.read_bytes) / dt / 1e6 if disk else 0.0
        disk_w = (disk.write_bytes - self._prev_disk.write_bytes) / dt / 1e6 if disk else 0.0
        net_r = (net.bytes_recv - self._prev_net.bytes_recv) / dt / 1e6 if net else 0.0
        net_s = (net.bytes_sent - self._prev_net.bytes_sent) / dt / 1e6 if net else 0.0
        self._prev_disk = disk
        self._prev_net = net
        self._prev_ts = now

        try:
            load1, load5, load15 = os.getloadavg()
        except (OSError, AttributeError):
            load1 = load5 = load15 = 0.0

        return {
            "cpu_overall_pct": round(overall, 1),
            "cpu_per_core": [round(c, 1) for c in per_core],
            "cpu_cores": len(per_core),
            "load_1m": round(load1, 2),
            "load_5m": round(load5, 2),
            "load_15m": round(load15, 2),
            "mem_used_gb": round(mem.used / 1024**3, 3),
            "mem_total_gb": round(mem.total / 1024**3, 3),
            "mem_pct": round(mem.percent, 1),
            "swap_used_gb": round(swap.used / 1024**3, 3),
            "swap_pct": round(swap.percent, 1),
            "disk_read_mb_s": round(disk_r, 2),
            "disk_write_mb_s": round(disk_w, 2),
            "net_recv_mb_s": round(net_r, 2),
            "net_sent_mb_s": round(net_s, 2),
        }


# --------------------------------------------------------------------------
# API client
# --------------------------------------------------------------------------


class BackendClient:
    def __init__(self, base_url: str, email: str, password: str,
                 tenant_slug: Optional[str], timeout: float = 4.0):
        self._base = base_url.rstrip("/")
        # Short read timeout so a wedged backend bounds the stall to a few
        # seconds — the durable OS-level system row is written first anyway.
        self._client = httpx.Client(
            base_url=self._base,
            timeout=httpx.Timeout(timeout, connect=min(2.0, timeout)),
        )
        self._email = email
        self._password = password
        self._tenant_slug = tenant_slug
        self.last_api_ok = False

    def login(self) -> None:
        body: dict[str, Any] = {"email": self._email, "password": self._password}
        if self._tenant_slug:
            body["tenant_slug"] = self._tenant_slug
        r = self._client.post("/api/auth/login", json=body)
        if r.status_code != 200:
            raise SystemExit(
                f"login failed ({r.status_code}): {r.text[:200]} — check "
                "DIAG_ADMIN_EMAIL/PASSWORD (and --tenant-slug in multi mode)"
            )

    def start_ring(self) -> None:
        try:
            self._client.post("/api/diagnostics/start")
        except httpx.HTTPError as exc:
            print(f"warning: could not enable diagnostics ring: {exc}", file=sys.stderr)

    def stop_ring(self) -> None:
        try:
            self._client.post("/api/diagnostics/stop")
        except httpx.HTTPError:
            pass

    def workers(self) -> list[dict[str, Any]]:
        try:
            r = self._client.get("/api/operations/workers")
            if r.status_code == 200:
                self.last_api_ok = True
                return r.json().get("workers", []) or []
            print(f"warning: workers HTTP {r.status_code}", file=sys.stderr)
        except httpx.HTTPError as exc:
            # A timeout here is itself a signal — the backend is wedged.
            print(f"warning: workers fetch failed (backend may be frozen): {exc}",
                  file=sys.stderr)
        self.last_api_ok = False
        return []

    def events_since(self, since_ts: Optional[float]) -> list[dict[str, Any]]:
        try:
            params: dict[str, Any] = {"limit": 2000}
            if since_ts is not None:
                params["since_ts"] = since_ts
            r = self._client.get("/api/diagnostics/events", params=params)
            if r.status_code == 200:
                return r.json().get("events", []) or []
        except httpx.HTTPError as exc:
            print(f"warning: events fetch failed: {exc}", file=sys.stderr)
        return []

    def backend_rss_mb_and_threads(self) -> tuple[float, int]:
        """Sum RSS + thread count across processes that own capture threads."""
        rss = 0
        threads = 0
        counted: set[int] = set()
        scan = _scan_capture_threads()
        pids: set[int] = set()
        for roles in scan.values():
            for role in ("reader", "analyzer"):
                for (pid, _tid) in roles[role]:
                    pids.add(pid)
        for pid in pids:
            if pid in counted:
                continue
            counted.add(pid)
            try:
                p = psutil.Process(pid)
                rss += p.memory_info().rss
                threads += p.num_threads()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return rss / (1024 * 1024), threads


# --------------------------------------------------------------------------
# Event aggregation per window
# --------------------------------------------------------------------------


def _pctl(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, int(round(q * (len(s) - 1))))
    return round(s[idx], 2)


def _aggregate_events(events: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Fold this window's anomaly events into per-camera aggregates."""
    agg: dict[int, dict[str, Any]] = {}

    def slot(cam_id: int) -> dict[str, Any]:
        return agg.setdefault(
            cam_id,
            {
                "read_ms": [],
                "preview_ms": [],
                "clip_ms": [],
                "total_ms": [],
                "detect_ms": [],
                "frame_slow": 0,
                "detection_slow": 0,
                "rtsp_reconnect": 0,
                "reader_read_failed": 0,
                "camera_read_timeout": 0,
                "ffmpeg_restart": 0,
                "segmenter_thrashing": 0,
                "analyzer_starved": 0,
            },
        )

    for e in events:
        cam_id = e.get("camera_id")
        if cam_id is None:
            continue
        cam_id = int(cam_id)
        kind = e.get("kind")
        m = e.get("metrics", {}) or {}
        s = slot(cam_id)
        if kind == "frame_slow":
            s["frame_slow"] += 1
            for k_src, k_dst in (
                ("t_read_ms", "read_ms"),
                ("t_preview_ms", "preview_ms"),
                ("t_clip_ms", "clip_ms"),
                ("t_total_ms", "total_ms"),
            ):
                v = m.get(k_src)
                if isinstance(v, (int, float)):
                    s[k_dst].append(float(v))
        elif kind == "detection_slow":
            s["detection_slow"] += 1
            v = m.get("detect_ms")
            if isinstance(v, (int, float)):
                s["detect_ms"].append(float(v))
        elif kind in s:
            s[kind] += 1
    return agg


# --------------------------------------------------------------------------
# CSV writers
# --------------------------------------------------------------------------


CAMERA_FIELDS = [
    "ts_iso", "elapsed_s", "camera_id", "camera_name", "status",
    "rtsp_stage", "detection_stage", "matching_stage", "attendance_stage",
    "native_fps", "fps_reader", "fps_analyzer", "reader_drop_pct",
    "frames_analyzed_60s", "motion_skipped_60s", "faces_saved_60s", "matches_60s",
    "read_ms_p95", "preview_ms_p95", "clip_ms_p95", "total_ms_p95", "detect_ms_p95",
    "frame_slow_n", "detection_slow_n", "reconnect_n", "read_failed_n",
    "read_timeout_n", "ffmpeg_restart_n", "starved_n",
    "reader_cpu_pct", "analyzer_cpu_pct", "camera_cpu_pct",
    "errors_5min", "recent_error",
]

SYSTEM_FIELDS = [
    "ts_iso", "elapsed_s", "cpu_overall_pct", "cpu_cores", "cpu_per_core_json",
    "cpu_max_core_pct", "load_1m", "load_5m", "load_15m",
    "mem_used_gb", "mem_total_gb", "mem_pct", "swap_used_gb", "swap_pct",
    "disk_read_mb_s", "disk_write_mb_s", "net_recv_mb_s", "net_sent_mb_s",
    "backend_rss_mb", "backend_threads",
    "tmp_is_tmpfs", "segments_total_mb", "clips_total_mb",
    "sum_native_fps", "sum_reader_fps", "sum_analyzer_fps",
    "detects_per_sec_total", "backend_up", "api_ok",
]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------


_STOP = False


def _handle_sigint(_sig: int, _frame: Any) -> None:
    global _STOP
    _STOP = True
    print("\nstopping (received signal) — flushing files…", file=sys.stderr)


def main() -> int:
    args = _parse_args()
    if not args.email or not args.password:
        print(
            "error: admin credentials required — set DIAG_ADMIN_EMAIL + "
            "DIAG_ADMIN_PASSWORD (or pass --email/--password)",
            file=sys.stderr,
        )
        return 2

    run_id = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out) / f"run-{run_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    cam_csv_path = out_dir / "cameras.csv"
    sys_csv_path = out_dir / "system.csv"
    events_path = out_dir / "events.jsonl"
    meta_path = out_dir / "meta.json"
    pid_path = out_dir / "diag.pid"
    # Write a PID file so the process can be stopped without procps
    # (pgrep/pkill are often absent in slim images):
    #   docker exec <c> sh -c 'kill -TERM $(cat /data/diag/run-*/diag.pid)'
    try:
        pid_path.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass

    client = BackendClient(args.base_url, args.email, args.password,
                           args.tenant_slug, timeout=args.api_timeout)
    client.login()
    client.start_ring()

    host = HostSampler()
    cpu_threads = ThreadCpuSampler()
    cpu_threads.sample()  # prime

    signal.signal(signal.SIGINT, _handle_sigint)
    signal.signal(signal.SIGTERM, _handle_sigint)

    t0 = time.time()
    deadline = t0 + args.duration_min * 60 if args.duration_min > 0 else None
    last_event_ts: Optional[float] = None
    sample_n = 0

    meta_path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "started_at": _iso(t0),
                "base_url": args.base_url,
                "interval_s": args.interval,
                "duration_min": args.duration_min,
                "tmp_is_tmpfs": _tmp_is_tmpfs("/tmp"),
                "segments_dir": args.segments_dir,
                "clips_dir": args.clips_dir,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    cam_fh = cam_csv_path.open("w", newline="", encoding="utf-8")
    sys_fh = sys_csv_path.open("w", newline="", encoding="utf-8")
    ev_fh = events_path.open("w", encoding="utf-8")
    cam_writer = csv.DictWriter(cam_fh, fieldnames=CAMERA_FIELDS)
    sys_writer = csv.DictWriter(sys_fh, fieldnames=SYSTEM_FIELDS)
    cam_writer.writeheader()
    sys_writer.writeheader()

    print(f"diag: writing to {out_dir} — interval={args.interval}s, "
          f"duration={'∞' if not deadline else f'{args.duration_min}min'}")
    if _tmp_is_tmpfs("/tmp"):
        print("diag: NOTE /tmp is tmpfs (RAM-backed) — clip segments here "
              "count against memory, not disk.")

    # The dir-size walk can stall under load, so we throttle it and reuse
    # the last value between full walks. First sample walks immediately.
    seg_mb_cache = 0.0
    clips_mb_cache = 0.0

    def _fsync(fh: Any) -> None:
        try:
            fh.flush()
            os.fsync(fh.fileno())
        except OSError:
            pass

    try:
        while not _STOP:
            loop_start = time.time()
            elapsed = round(loop_start - t0, 1)

            host_metrics = host.sample()
            cam_cpu = cpu_threads.sample()
            workers = client.workers()
            events = client.events_since(last_event_ts)
            if events:
                for e in events:
                    ev_fh.write(json.dumps(e) + "\n")
                last_event_ts = max(
                    (e.get("ts") for e in events if e.get("ts") is not None),
                    default=last_event_ts,
                )
            ev_agg = _aggregate_events(events)
            rss_mb, backend_threads = client.backend_rss_mb_and_threads()
            # backend_up: are the capture threads still present? (If the
            # backend was OOM-killed, no capread-* threads remain.)
            backend_up = 1 if cam_cpu else 0

            # Throttled disk-size walk (can stall under heavy load).
            if sample_n % max(1, args.disk_sample_every) == 0:
                seg_mb_cache = round(_dir_size_mb(args.segments_dir), 1)
                clips_mb_cache = round(_dir_size_mb(args.clips_dir), 1)

            sum_native = sum_reader = sum_analyzer = 0.0
            detects_per_sec = 0.0
            ts_iso = _iso(loop_start)

            for w in workers:
                cam_id = int(w.get("camera_id") or 0)
                meta = w.get("metadata", {}) or {}
                stages = w.get("stages", {}) or {}
                native = meta.get("fps")
                fps_reader = float(w.get("fps_reader") or 0.0)
                fps_analyzer = float(w.get("fps_analyzer") or 0.0)
                analyzed_60s = int(w.get("frames_analyzed_60s") or 0)

                drop_pct = ""
                if isinstance(native, (int, float)) and 0 < native <= 120:
                    drop_pct = round(max(0.0, (native - fps_reader) / native * 100.0), 1)
                    sum_native += float(native)
                sum_reader += fps_reader
                sum_analyzer += fps_analyzer
                detects_per_sec += analyzed_60s / 60.0

                agg = ev_agg.get(cam_id, {})
                ccpu = cam_cpu.get(cam_id, {})
                reader_cpu = round(ccpu.get("reader_cpu", 0.0), 1)
                analyzer_cpu = round(ccpu.get("analyzer_cpu", 0.0), 1)
                recent = w.get("recent_errors") or []

                cam_writer.writerow({
                    "ts_iso": ts_iso,
                    "elapsed_s": elapsed,
                    "camera_id": cam_id,
                    "camera_name": w.get("camera_name") or "",
                    "status": w.get("status") or "",
                    "rtsp_stage": (stages.get("rtsp") or {}).get("state") or "",
                    "detection_stage": (stages.get("detection") or {}).get("state") or "",
                    "matching_stage": (stages.get("matching") or {}).get("state") or "",
                    "attendance_stage": (stages.get("attendance") or {}).get("state") or "",
                    "native_fps": native if native is not None else "",
                    "fps_reader": fps_reader,
                    "fps_analyzer": fps_analyzer,
                    "reader_drop_pct": drop_pct,
                    "frames_analyzed_60s": analyzed_60s,
                    "motion_skipped_60s": int(w.get("frames_motion_skipped_60s") or 0),
                    "faces_saved_60s": int(w.get("faces_saved_60s") or 0),
                    "matches_60s": int(w.get("matches_60s") or 0),
                    "read_ms_p95": _pctl(agg.get("read_ms", []), 0.95),
                    "preview_ms_p95": _pctl(agg.get("preview_ms", []), 0.95),
                    "clip_ms_p95": _pctl(agg.get("clip_ms", []), 0.95),
                    "total_ms_p95": _pctl(agg.get("total_ms", []), 0.95),
                    "detect_ms_p95": _pctl(agg.get("detect_ms", []), 0.95),
                    "frame_slow_n": agg.get("frame_slow", 0),
                    "detection_slow_n": agg.get("detection_slow", 0),
                    "reconnect_n": agg.get("rtsp_reconnect", 0),
                    "read_failed_n": agg.get("reader_read_failed", 0),
                    "read_timeout_n": agg.get("camera_read_timeout", 0),
                    "ffmpeg_restart_n": agg.get("ffmpeg_restart", 0),
                    "starved_n": agg.get("analyzer_starved", 0),
                    "reader_cpu_pct": reader_cpu,
                    "analyzer_cpu_pct": analyzer_cpu,
                    "camera_cpu_pct": round(reader_cpu + analyzer_cpu, 1),
                    "errors_5min": int(w.get("errors_5min") or 0),
                    "recent_error": (recent[-1] if recent else "")[:160],
                })

            per_core = host_metrics["cpu_per_core"]
            sys_writer.writerow({
                "ts_iso": ts_iso,
                "elapsed_s": elapsed,
                "cpu_overall_pct": host_metrics["cpu_overall_pct"],
                "cpu_cores": host_metrics["cpu_cores"],
                "cpu_per_core_json": json.dumps(per_core),
                "cpu_max_core_pct": round(max(per_core), 1) if per_core else 0.0,
                "load_1m": host_metrics["load_1m"],
                "load_5m": host_metrics["load_5m"],
                "load_15m": host_metrics["load_15m"],
                "mem_used_gb": host_metrics["mem_used_gb"],
                "mem_total_gb": host_metrics["mem_total_gb"],
                "mem_pct": host_metrics["mem_pct"],
                "swap_used_gb": host_metrics["swap_used_gb"],
                "swap_pct": host_metrics["swap_pct"],
                "disk_read_mb_s": host_metrics["disk_read_mb_s"],
                "disk_write_mb_s": host_metrics["disk_write_mb_s"],
                "net_recv_mb_s": host_metrics["net_recv_mb_s"],
                "net_sent_mb_s": host_metrics["net_sent_mb_s"],
                "backend_rss_mb": round(rss_mb, 1),
                "backend_threads": backend_threads,
                "tmp_is_tmpfs": _tmp_is_tmpfs("/tmp"),
                "segments_total_mb": seg_mb_cache,
                "clips_total_mb": clips_mb_cache,
                "sum_native_fps": round(sum_native, 1),
                "sum_reader_fps": round(sum_reader, 1),
                "sum_analyzer_fps": round(sum_analyzer, 1),
                "detects_per_sec_total": round(detects_per_sec, 2),
                "backend_up": backend_up,
                "api_ok": 1 if client.last_api_ok else 0,
            })

            # fsync every tick: the durable OS-level trace must survive a
            # hard freeze / OOM-reboot even if the last seconds are lost.
            _fsync(cam_fh)
            _fsync(sys_fh)
            _fsync(ev_fh)
            sample_n += 1
            if not client.last_api_ok:
                print(f"diag: sample {sample_n} — API unreachable "
                      f"(backend_up={backend_up}); OS metrics still recorded.",
                      file=sys.stderr)
            if sample_n % 12 == 0:
                print(f"diag: sample {sample_n} @ {elapsed:.0f}s — "
                      f"CPU {host_metrics['cpu_overall_pct']}% "
                      f"mem {host_metrics['mem_pct']}% "
                      f"cameras {len(workers)}")

            if deadline and time.time() >= deadline:
                print("diag: duration reached — stopping.")
                break

            sleep_for = args.interval - (time.time() - loop_start)
            if sleep_for > 0:
                # Interruptible sleep so Ctrl-C is responsive.
                end = time.time() + sleep_for
                while time.time() < end and not _STOP:
                    time.sleep(min(0.25, end - time.time()))
    finally:
        cam_fh.close()
        sys_fh.close()
        ev_fh.close()
        if not args.keep_ring_on_exit:
            client.stop_ring()
        print(f"diag: done. {sample_n} samples written to {out_dir}")
        print(f"diag: generate the report with:\n"
              f"  python -m scripts.camera_diagnostics_report {out_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
