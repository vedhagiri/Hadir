# Camera-wise capture diagnostics

A per-camera diagnostic harness for finding **exactly** where a
multi-camera deployment (21+ streams) spends CPU/memory and where frames
are dropped — from evidence, not guesswork.

It has two parts:

| Script | Role |
| --- | --- |
| `scripts/camera_diagnostics.py` | **Collector.** Runs for hours, logs per-camera + system metrics to CSV/JSONL. |
| `scripts/camera_diagnostics_report.py` | **Reporter.** Reads a run folder, ranks the worst cameras, prints a bottleneck verdict. |

It harvests telemetry the backend **already** produces — the P28.8
operations endpoint, the in-memory diagnostics ring, `psutil`, and
`/proc` per-thread CPU. It does **not** add a parallel pipeline, change
any camera, or write to the DB. It never logs an RTSP URL or credential
— only the pipeline stage colour and worker status.

---

## 1. Run the collector

Run it **inside the backend container** (the capture workers and the
diagnostics ring live in the uvicorn process; the script reaches them
over the local API and reads `/proc` for per-thread CPU):

```sh
docker compose exec -T \
  -e DIAG_ADMIN_EMAIL='admin@yourtenant' \
  -e DIAG_ADMIN_PASSWORD='••••••••' \
  backend python -m scripts.camera_diagnostics \
    --interval 5 \
    --duration-min 180 \
    --out /data/diag
```

- `--interval 5` — sample every 5 s (good default; 2–10 s is sane).
- `--duration-min 180` — run 3 hours (use `0` to run until `Ctrl-C`).
- `--out /data/diag` — writes to a timestamped `run-YYYYMMDD-HHMMSS/`
  subfolder under a **mounted** volume so the files survive.
- Multi-tenant mode: add `--tenant-slug yourslug` (single-tenant `main`
  installs don't need it).

**Run it during the freeze window.** The whole point is to capture the
period when the box is struggling — start it before peak foot-traffic
and let it run through the degradation.

Output in the run folder:

| File | Contents |
| --- | --- |
| `cameras.csv` | One row **per camera per sample** — the per-camera metrics below. |
| `system.csv` | One row **per sample** — host CPU/mem/swap/disk/net + totals. |
| `events.jsonl` | Raw anomaly-ring events (frame_slow breakdown, reconnects, …) for deep dives. |
| `meta.json` | Run parameters + whether `/tmp` is tmpfs. |

## 2. Generate the report

```sh
docker compose exec -T backend \
  python -m scripts.camera_diagnostics_report /data/diag/run-YYYYMMDD-HHMMSS
```

It prints the **verdict + top offenders** to the console and writes a
full `report.md` into the run folder. The reporter is stdlib-only, so
you can also copy the run folder to a laptop and run it there.

---

## 2b. Capturing reliably when the box freezes (read this first)

A fair worry: *if the server hangs from high CPU/memory, can these tools
still record?* The honest answer is that the metrics split into a
**durable** layer and a **fragile** layer, and the strategy is to never
let the fragile one take down the durable one.

| Data | Survives a frozen box? |
| --- | --- |
| Host CPU/mem/swap/disk/net (kernel `/proc`) | **Yes** — the kernel keeps accounting |
| Per-camera fps/stage/timings (HTTP to the frozen backend) | **No** — lost exactly when you need it |
| Anything not yet `fsync`'d before an OOM-reboot | **No** |

Run **all three layers together** through the freeze window:

**Layer 1 — `os_watch.sh` (can't-fail, run on the HOST).** Dependency-free
`/proc` sampler. Survives a container OOM-kill because it doesn't live in
the container, and captures the kernel OOM verdict on exit:

```sh
# on the host, to a REAL disk (not tmpfs), high resolution:
nohup ./backend/scripts/os_watch.sh 2 /var/log/maugood-oswatch.log uvicorn &
```

**Layer 2 — the hardened Python collector** (per-camera richness). It now:
- uses a **short HTTP timeout** (`--api-timeout 4`) so a wedged backend
  bounds the stall to a few seconds instead of dragging the whole sample;
- **`fsync`s every tick**, so a hard freeze/OOM-reboot keeps everything up
  to the last sample;
- writes the **OS-level system row regardless of API health** — when the
  backend is unreachable it records `api_ok=0` and `backend_up=0` and keeps
  going (the *gap* in the per-camera rows, lined up against the CPU/mem
  spike in `system.csv`, is itself the evidence of the freeze);
- **throttles the disk-size walk** (`--disk-sample-every`) so the walk
  can't stall the loop.

**Layer 3 — `py-spy` stack dump at the moment of hang** (the gold standard
for "what was it doing when it froze"). `py-spy` reads the backend's memory
*from outside* the process, so it works on a fully unresponsive Python app:

```sh
pip install py-spy        # one-time, on the host
# find the backend PID (host side):
PID=$(pgrep -f 'uvicorn|maugood.main' | head -1)
py-spy dump --pid "$PID"                       # every thread's stack, now
py-spy record -o /var/log/maugood-spy.svg --pid "$PID" --duration 30  # flame graph
```

**Rules that make the capture trustworthy:**
- Write every log to **persistent disk, never tmpfs** (if `/tmp` or `/data`
  is RAM-backed, an OOM-reboot erases your evidence).
- Run Layer 1 on the **host**, not in the container.
- Start logging **before** the degradation and let it run through the
  freeze — the transition *into* the freeze is the most valuable data, which
  is why Layer 1 samples at 2 s.
- If the box may OOM-reboot, set the collectors to auto-start (a `systemd`
  unit or `@reboot` cron) so logging resumes and you capture the *next*
  cycle even if you miss the first.

**What you can still lose:** if the **kernel itself** locks up (a true hard
freeze, not just app slowness) or the machine power-cycles, only what was
already `fsync`'d to persistent disk survives — that's what Layer 1 + the
`fsync` in Layer 2 protect, and the kernel OOM tail (captured on
`os_watch.sh` exit, or via `journalctl -k -b -1` after a reboot) tells you
what the kernel killed and why.

## 3. What each metric means

### Per-camera (`cameras.csv`)

| Column | Meaning | What it tells you |
| --- | --- | --- |
| `camera_id` / `camera_name` | Identity | — |
| `status` | `running` / `reconnecting` / `failed` / … | A camera stuck `reconnecting` is offline or flapping. |
| `rtsp_stage` … `attendance_stage` | Pipeline stage colour (green/amber/red) | Where the per-camera pipeline is unhealthy. |
| `native_fps` | Camera's advertised FPS (probed) | The **incoming** rate. May be blank if the probe failed. |
| `fps_reader` | Frames/s the reader actually pulls | The **processed** read rate. |
| `fps_analyzer` | Analyzer cycles/s | Detection cadence (capped by `analyzer_max_fps`; skip-to-latest). |
| `reader_drop_pct` | `(native − reader) / native` | **Frame drop at the reader stage.** High = reader can't keep up. |
| `frames_analyzed_60s` | Detect cycles in last 60 s | Detection volume for this camera. |
| `motion_skipped_60s` | Cheap-skip cycles (no motion) | High = camera is quiet (good — near-zero detect cost). |
| `faces_saved_60s` / `matches_60s` | Crops saved / identities matched | Detection is producing useful output. |
| `read_ms_p95` | p95 of `cap.read()`/decode time (slow frames) | **RTSP decode cost.** |
| `preview_ms_p95` | p95 preview JPEG-encode time (slow frames) | **Preview-encode cost** (runs every frame). |
| `clip_ms_p95` | p95 clip-frame write time (slow frames) | **Clip-recording cost.** |
| `detect_ms_p95` | p95 detection time (slow detects) | **Inference cost.** |
| `frame_slow_n` | # frames over budget this window | How often this camera blows the per-frame budget. |
| `reconnect_n` / `read_failed_n` / `read_timeout_n` / `ffmpeg_restart_n` | Instability counters | Network/camera flapping. |
| `starved_n` | Analyzer saw no new frame (reader stalled) | Reader is starved → live view freezes. |
| `reader_cpu_pct` / `analyzer_cpu_pct` / `camera_cpu_pct` | Per-thread CPU% (from `/proc`) | **Which camera burns the most CPU.** |

> The `*_ms_p95` timings come from the anomaly ring, which only records
> frames that **exceed** the per-frame budget (`1000/native_fps`, or
> 40 ms). That's deliberate — these are the slow frames that matter. A
> camera with `frame_slow_n = 0` simply never blew its budget.

### System (`system.csv`)

`cpu_overall_pct`, `cpu_per_core_json`, `cpu_max_core_pct`, `load_1m/5m/15m`,
`mem_pct`, `backend_rss_mb`, `swap_pct`, `disk_read/write_mb_s`,
`net_recv/sent_mb_s`, `segments_total_mb` (clip temp dir size — watch this
if `/tmp` is tmpfs), `sum_reader_fps`, `detects_per_sec_total`,
`backend_up` (1 = capture threads present; 0 = backend gone/OOM-killed),
`api_ok` (1 = the per-camera API answered this tick; 0 = backend wedged —
the OS metrics on this row are still valid).

---

## 4. How to read it — the decision tree

The report's **Verdict** block automates this, but here's the logic so
you can confirm:

1. **Is CPU saturated?** `cpu_overall_pct` mean ≥ 85% or peak ≥ 95% →
   CPU-bound. Then look at the **"Where slow frames spend their time"**
   table:
   - `preview ms` ≫ others → **preview encoding** is the cost (it runs on
     every native frame even when nobody is watching Live Capture). Gate
     preview on viewers / throttle it.
   - `clip ms` ≫ others → **clip recording** (especially in `encode`
     mode). Switch to `stream_copy`, disable clips where not needed.
   - `detect ms` ≫ others **and** `detects_per_sec_total` ≈ 6–7 →
     **detection** is the ceiling (single `_detect_lock`). Lower
     `analyzer_max_fps`, raise `force_detect_every_s`, or move to GPU.
   - `read ms` ≫ others → **RTSP decode**; reduce stream count/resolution.

2. **Is the reader behind the cameras?** `sum_reader_fps` < 80% of
   `sum_native_fps`, or high `reader_drop_pct` → frames dropped at the
   reader (CPU starvation). This is the live-view lag. Fix #1's CPU cost.

3. **Is memory growing?** Watch `backend_rss_mb` trend (the report
   computes MB/hour). If it climbs continuously:
   - Check `meta.tmp_is_tmpfs`. If `/tmp` is **tmpfs** and
     `segments_total_mb` grows → clip segments are filling **RAM**.
     Switch to `stream_copy` or move the segment dir off tmpfs.
   - If `swap_pct` > 0 and rising → swap thrash, a direct freeze cause.

4. **Disk or network?** `disk_write_mb_s` sustained high → clip I/O bound.
   `net_recv_mb_s` near the NIC limit (21×1080p ≈ 80–170 Mbps typical) →
   network. High `load` with low CPU% → I/O wait.

5. **Which camera is the problem?** The **"Worst cameras by CPU"** and
   **"by frame-drop"** tables name them. A single high-traffic or
   high-resolution camera often dominates — fix or down-tune that one
   first.

---

## 5. From evidence to action

| Verdict | Targeted action |
| --- | --- |
| Preview encoding dominates | Gate preview JPEG on active viewers + throttle to ~6 fps (code change); meanwhile reduce active cameras. |
| Clip recording dominates | `MAUGOOD_CLIP_SAVING_MODE=stream_copy`; `clip_recording_enabled=false` on cameras that don't need clips. |
| Detection at the lane ceiling | `analyzer_max_fps=1`, `force_detect_every_s≈10`, `det_size 320→256`, `OMP_NUM_THREADS=2`; GPU for real scale. |
| Reader behind cameras | All of the above (free reader CPU); lower per-camera resolution if possible. |
| Memory growth via tmpfs | `stream_copy`, move segment temp dir off tmpfs, `MALLOC_ARENA_MAX=2`. |
| One camera dominates | Down-tune or relocate that camera; check its resolution/fps. |
| Network/disk | Add NIC/disk headroom or shard cameras across hosts. |

The goal: run for a few hours with all 21 cameras through a freeze
window, read the verdict, apply the one targeted change the evidence
points to, then re-run to confirm the bottleneck moved.
