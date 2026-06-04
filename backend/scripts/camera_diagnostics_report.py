"""Summary report generator for ``camera_diagnostics`` runs.

Reads a run folder (``cameras.csv`` + ``system.csv`` + ``meta.json``)
produced by ``scripts.camera_diagnostics`` and emits:

* A console summary highlighting the worst-performing cameras.
* A Markdown report (``report.md``) in the same folder.
* An evidence-based bottleneck verdict — CPU / memory / disk / network /
  RTSP decode / preview encode / detection — derived from the data, not
  guessed.

Run:

    python -m scripts.camera_diagnostics_report /data/diag/run-YYYYMMDD-HHMMSS

It has no dependencies beyond the stdlib so it can also run on a laptop
after copying the run folder off the server.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from pathlib import Path
from typing import Any, Optional


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def _to_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _load_csv(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _mean(vals: list[float]) -> float:
    return round(statistics.fmean(vals), 1) if vals else 0.0


def _peak(vals: list[float]) -> float:
    return round(max(vals), 1) if vals else 0.0


def _p95(vals: list[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    return round(s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))], 1)


def _slope_per_hour(samples: list[tuple[float, float]]) -> float:
    """Least-squares slope of value vs elapsed_s, scaled to per-hour."""
    pts = [(t, v) for (t, v) in samples if t is not None and v is not None]
    n = len(pts)
    if n < 3:
        return 0.0
    mean_t = statistics.fmean(t for t, _ in pts)
    mean_v = statistics.fmean(v for _, v in pts)
    num = sum((t - mean_t) * (v - mean_v) for t, v in pts)
    den = sum((t - mean_t) ** 2 for t, _ in pts)
    if den == 0:
        return 0.0
    return round(num / den * 3600.0, 1)  # per second → per hour


# --------------------------------------------------------------------------
# Per-camera aggregation
# --------------------------------------------------------------------------


def _aggregate_cameras(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    by_cam: dict[int, dict[str, list]] = {}
    names: dict[int, str] = {}
    for r in rows:
        try:
            cid = int(r["camera_id"])
        except (KeyError, ValueError):
            continue
        names[cid] = r.get("camera_name") or names.get(cid, "")
        b = by_cam.setdefault(cid, {k: [] for k in (
            "camera_cpu_pct", "reader_cpu_pct", "analyzer_cpu_pct",
            "fps_reader", "fps_analyzer", "native_fps", "reader_drop_pct",
            "read_ms_p95", "preview_ms_p95", "clip_ms_p95", "detect_ms_p95",
            "frame_slow_n", "reconnect_n", "read_failed_n", "read_timeout_n",
            "ffmpeg_restart_n", "starved_n", "matches_60s", "faces_saved_60s",
        )})
        for k in b:
            v = _to_float(r.get(k))
            if v is not None:
                b[k].append(v)
        b.setdefault("status", []).append(r.get("status") or "")

    out: dict[int, dict[str, Any]] = {}
    for cid, b in by_cam.items():
        out[cid] = {
            "camera_id": cid,
            "camera_name": names.get(cid, ""),
            "cpu_mean": _mean(b["camera_cpu_pct"]),
            "cpu_peak": _peak(b["camera_cpu_pct"]),
            "reader_cpu_mean": _mean(b["reader_cpu_pct"]),
            "analyzer_cpu_mean": _mean(b["analyzer_cpu_pct"]),
            "fps_reader_mean": _mean(b["fps_reader"]),
            "fps_analyzer_mean": _mean(b["fps_analyzer"]),
            "native_fps": _peak(b["native_fps"]),
            "drop_mean": _mean(b["reader_drop_pct"]),
            "drop_peak": _peak(b["reader_drop_pct"]),
            "read_ms": _p95(b["read_ms_p95"]),
            "preview_ms": _p95(b["preview_ms_p95"]),
            "clip_ms": _p95(b["clip_ms_p95"]),
            "detect_ms": _p95(b["detect_ms_p95"]),
            "frame_slow": int(sum(b["frame_slow_n"])),
            "reconnects": int(sum(b["reconnect_n"]) + sum(b["read_failed_n"])
                              + sum(b["read_timeout_n"]) + sum(b["ffmpeg_restart_n"])),
            "starved": int(sum(b["starved_n"])),
            "matches": int(sum(b["matches_60s"])),
        }
    return out


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    line = "| " + " | ".join(headers) + " |"
    sep = "| " + " | ".join("---" for _ in headers) + " |"
    body = "\n".join("| " + " | ".join(str(c) for c in r) + " |" for r in rows)
    return "\n".join([line, sep, body]) if rows else line + "\n" + sep + "\n| _(none)_ |"


def _rank(cams: dict[int, dict[str, Any]], key: str, n: int = 8) -> list[dict[str, Any]]:
    return sorted(cams.values(), key=lambda c: c.get(key, 0) or 0, reverse=True)[:n]


# --------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------


def _verdict(cams: dict[int, dict[str, Any]], sys_rows: list[dict[str, Any]],
             meta: dict[str, Any]) -> list[str]:
    out: list[str] = []
    cpu_overall = [_to_float(r.get("cpu_overall_pct")) for r in sys_rows]
    cpu_overall = [c for c in cpu_overall if c is not None]
    mem_pct = [_to_float(r.get("mem_pct")) for r in sys_rows]
    mem_pct = [m for m in mem_pct if m is not None]
    swap_pct = [_to_float(r.get("swap_pct")) for r in sys_rows]
    swap_pct = [s for s in swap_pct if s is not None]
    cores = next((int(_to_float(r.get("cpu_cores")) or 0) for r in sys_rows
                  if _to_float(r.get("cpu_cores"))), 0)

    mem_series = [(_to_float(r.get("elapsed_s")), _to_float(r.get("backend_rss_mb")))
                  for r in sys_rows]
    rss_slope = _slope_per_hour([(t, v) for t, v in mem_series if t is not None and v is not None])
    seg_series = [(_to_float(r.get("elapsed_s")), _to_float(r.get("segments_total_mb")))
                  for r in sys_rows]
    seg_slope = _slope_per_hour([(t, v) for t, v in seg_series if t is not None and v is not None])

    detects = [_to_float(r.get("detects_per_sec_total")) for r in sys_rows]
    detects = [d for d in detects if d is not None]
    sum_native = [_to_float(r.get("sum_native_fps")) for r in sys_rows]
    sum_native = [s for s in sum_native if s is not None]
    sum_reader = [_to_float(r.get("sum_reader_fps")) for r in sys_rows]
    sum_reader = [s for s in sum_reader if s is not None]

    disk_w = [_to_float(r.get("disk_write_mb_s")) for r in sys_rows]
    disk_w = [d for d in disk_w if d is not None]
    net_r = [_to_float(r.get("net_recv_mb_s")) for r in sys_rows]
    net_r = [n for n in net_r if n is not None]

    cpu_peak = _peak(cpu_overall)
    cpu_mean = _mean(cpu_overall)

    # --- CPU saturation -----------------------------------------------------
    if cpu_mean >= 85 or cpu_peak >= 95:
        out.append(
            f"**CPU-bound.** Overall CPU mean {cpu_mean}% / peak {cpu_peak}% "
            f"across {cores} cores. The box is saturated."
        )
        # Attribute the CPU: preview vs clip vs detect.
        total_preview = sum(c["preview_ms"] for c in cams.values())
        total_clip = sum(c["clip_ms"] for c in cams.values())
        total_detect = sum(c["detect_ms"] for c in cams.values())
        total_read = sum(c["read_ms"] for c in cams.values())
        biggest = max(
            (("preview encoding", total_preview), ("clip recording", total_clip),
             ("detection", total_detect), ("RTSP decode", total_read)),
            key=lambda kv: kv[1],
        )
        out.append(
            f"Slow-frame time is dominated by **{biggest[0]}** "
            f"(aggregate p95: read={total_read:.0f} / preview={total_preview:.0f} / "
            f"clip={total_clip:.0f} / detect={total_detect:.0f} ms). "
            f"Target that component first."
        )
    else:
        out.append(
            f"CPU is not saturated (mean {cpu_mean}% / peak {cpu_peak}% of "
            f"{cores} cores) — look at memory/disk/per-camera below before "
            f"assuming a CPU ceiling."
        )

    # --- Detection lane -----------------------------------------------------
    if detects:
        dps = _mean(detects)
        out.append(
            f"Detection throughput ≈ **{dps} detect/s box-wide** "
            f"(single ``_detect_lock`` ceiling ≈ 6–7/s on CPU). "
            + ("At/over the ceiling — detection is a bottleneck; lower "
               "analyzer_max_fps / raise force_detect_every_s / move to GPU."
               if dps >= 5 else
               "Below the ceiling — detection is not the limiter right now.")
        )

    # --- Throughput vs incoming --------------------------------------------
    if sum_native and sum_reader:
        sn, sr = _mean(sum_native), _mean(sum_reader)
        if sn > 0 and sr < 0.8 * sn:
            out.append(
                f"**Reader is behind the cameras.** Cameras deliver ≈{sn} fps "
                f"total but the readers only pull ≈{sr} fps — frames are being "
                f"dropped at the reader (CPU starvation), which is the live-view "
                f"lag you see."
            )

    # --- Memory growth ------------------------------------------------------
    if rss_slope > 50:
        out.append(
            f"**Memory is growing ~{rss_slope} MB/hour** (backend RSS trend). "
            f"That will eventually OOM/freeze the box."
        )
        if meta.get("tmp_is_tmpfs") and seg_slope > 20:
            out.append(
                f"Clip segments under tmpfs ``/tmp`` are growing ~{seg_slope} MB/h — "
                f"**this is RAM**. Switch clips to stream_copy and/or move the "
                f"segment temp dir off tmpfs."
            )
    elif mem_pct and _peak(mem_pct) >= 90:
        out.append(f"Memory high (peak {_peak(mem_pct)}%) but not clearly trending — "
                   f"check baseline footprint (model + 21 decoders).")

    if swap_pct and _peak(swap_pct) >= 10:
        out.append(f"**Swap in use (peak {_peak(swap_pct)}%)** — swap thrash alone "
                   f"can cause the freeze. Add RAM or cut memory load.")

    # --- Disk / network -----------------------------------------------------
    if disk_w and _peak(disk_w) >= 80:
        out.append(f"Disk writes peak {_peak(disk_w)} MB/s — clip writes may be "
                   f"I/O-bound; confirm with iowait.")
    if net_r and _peak(net_r) >= 200:
        out.append(f"Network RX peak {_peak(net_r)} MB/s — close to a 1–2.5 Gbps "
                   f"link for 21 streams; check for retransmits.")

    if len(out) <= 1:
        out.append("No single resource is clearly saturated in this window — "
                   "run longer or during peak foot-traffic to capture the freeze.")
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python -m scripts.camera_diagnostics_report <run-dir>",
              file=sys.stderr)
        return 2
    run_dir = Path(argv[1])
    cam_rows = _load_csv(run_dir / "cameras.csv")
    sys_rows = _load_csv(run_dir / "system.csv")
    meta_path = run_dir / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}

    if not cam_rows or not sys_rows:
        print(f"error: no data in {run_dir} (cameras.csv / system.csv empty)",
              file=sys.stderr)
        return 1

    cams = _aggregate_cameras(cam_rows)
    samples = len({r.get("ts_iso") for r in sys_rows})
    duration_min = round((_to_float(sys_rows[-1].get("elapsed_s")) or 0) / 60.0, 1)

    lines: list[str] = []
    lines.append(f"# Camera diagnostics report — {meta.get('run_id', run_dir.name)}\n")
    lines.append(f"- Window: **{duration_min} min**, {samples} samples, "
                 f"{len(cams)} cameras")
    lines.append(f"- Started: {meta.get('started_at', '?')}")
    lines.append(f"- /tmp is tmpfs (RAM-backed): **{meta.get('tmp_is_tmpfs')}**\n")

    # --- Verdict (top of report) -------------------------------------------
    lines.append("## Verdict — primary bottleneck\n")
    for v in _verdict(cams, sys_rows, meta):
        lines.append(f"- {v}")
    lines.append("")

    # --- System summary -----------------------------------------------------
    def col(name: str) -> list[float]:
        return [x for x in (_to_float(r.get(name)) for r in sys_rows) if x is not None]

    lines.append("## System summary\n")
    lines.append(_table(
        ["metric", "mean", "peak"],
        [
            ["CPU overall %", _mean(col("cpu_overall_pct")), _peak(col("cpu_overall_pct"))],
            ["CPU busiest core %", _mean(col("cpu_max_core_pct")), _peak(col("cpu_max_core_pct"))],
            ["Load 1m", _mean(col("load_1m")), _peak(col("load_1m"))],
            ["Memory %", _mean(col("mem_pct")), _peak(col("mem_pct"))],
            ["Backend RSS MB", _mean(col("backend_rss_mb")), _peak(col("backend_rss_mb"))],
            ["Swap %", _mean(col("swap_pct")), _peak(col("swap_pct"))],
            ["Disk write MB/s", _mean(col("disk_write_mb_s")), _peak(col("disk_write_mb_s"))],
            ["Net RX MB/s", _mean(col("net_recv_mb_s")), _peak(col("net_recv_mb_s"))],
            ["Segments MB", _mean(col("segments_total_mb")), _peak(col("segments_total_mb"))],
            ["Σ reader fps", _mean(col("sum_reader_fps")), _peak(col("sum_reader_fps"))],
            ["Detect/s box-wide", _mean(col("detects_per_sec_total")), _peak(col("detects_per_sec_total"))],
        ],
    ))
    lines.append("")

    # --- Worst cameras ------------------------------------------------------
    lines.append("## Worst cameras by CPU (reader + analyzer)\n")
    lines.append(_table(
        ["cam", "name", "cpu mean%", "cpu peak%", "reader%", "analyzer%", "matches"],
        [[c["camera_id"], c["camera_name"], c["cpu_mean"], c["cpu_peak"],
          c["reader_cpu_mean"], c["analyzer_cpu_mean"], c["matches"]]
         for c in _rank(cams, "cpu_peak")],
    ))
    lines.append("")

    lines.append("## Worst cameras by frame-drop (reader behind the camera)\n")
    lines.append(_table(
        ["cam", "name", "native fps", "reader fps", "drop mean%", "drop peak%"],
        [[c["camera_id"], c["camera_name"], c["native_fps"], c["fps_reader_mean"],
          c["drop_mean"], c["drop_peak"]]
         for c in _rank(cams, "drop_peak")],
    ))
    lines.append("")

    lines.append("## Where slow frames spend their time (p95 ms)\n")
    lines.append("_If preview ≫ detect, the live-view lag is preview encoding, "
                 "not detection. If clip ≫ others, clip recording is the cost._\n")
    lines.append(_table(
        ["cam", "name", "read ms", "preview ms", "clip ms", "detect ms", "slow frames"],
        [[c["camera_id"], c["camera_name"], c["read_ms"], c["preview_ms"],
          c["clip_ms"], c["detect_ms"], c["frame_slow"]]
         for c in _rank(cams, "frame_slow")],
    ))
    lines.append("")

    lines.append("## Cameras with the most reconnects / instability\n")
    lines.append(_table(
        ["cam", "name", "reconnects", "analyzer starved"],
        [[c["camera_id"], c["camera_name"], c["reconnects"], c["starved"]]
         for c in _rank(cams, "reconnects")],
    ))
    lines.append("")

    report_md = "\n".join(lines)
    (run_dir / "report.md").write_text(report_md, encoding="utf-8")

    # Console: verdict + top offenders only.
    print("=" * 72)
    print(f"CAMERA DIAGNOSTICS — {meta.get('run_id', run_dir.name)} "
          f"({duration_min} min, {len(cams)} cameras)")
    print("=" * 72)
    print("\nVERDICT:")
    for v in _verdict(cams, sys_rows, meta):
        # strip markdown bold for console
        print("  • " + v.replace("**", ""))
    print("\nTop 5 cameras by peak CPU:")
    for c in _rank(cams, "cpu_peak", 5):
        print(f"  cam {c['camera_id']:>3} {c['camera_name'][:22]:<22} "
              f"cpu {c['cpu_peak']:>5}% (rdr {c['reader_cpu_mean']}/ana {c['analyzer_cpu_mean']})")
    print(f"\nFull report written to: {run_dir / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
