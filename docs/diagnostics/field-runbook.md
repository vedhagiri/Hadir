# Field runbook — 21-camera diagnostics on the client server

A self-contained, copy-paste procedure for running the capture
diagnostics on the client's production box (running `maugood-v1.1.17`).
Designed so you can prepare everything in advance and execute quickly
on site. Read top to bottom; every command is safe and read-only
(nothing changes a camera, the DB, or the running config).

---

## 0. Files to copy to the client + dependencies

**Three files** (everything else is already on the box):

| File (from this repo) | Goes to | Why |
| --- | --- | --- |
| `backend/scripts/camera_diagnostics.py` | **into the backend container** `/app/scripts/` | Collector (per-camera + system metrics) |
| `backend/scripts/camera_diagnostics_report.py` | **into the backend container** `/app/scripts/` | Report generator (worst-camera ranking + verdict) |
| `backend/scripts/os_watch.sh` | **the host** (e.g. `~/maugood-diag/`) | Can't-fail OS-level logger; runs outside the container |

**Dependencies:**
- Inside the container: **none** — `psutil` and `httpx` already ship in
  the `v1.1.17` image.
- On the host: only `bash` + coreutils (already present). **Optional**
  Layer-3 stack dumps need `py-spy` (`pip install py-spy` or
  `pipx install py-spy`) — nice to have, not required.

**No configuration files are required.** You only need the **Admin login
email + password** for the tenant. (Single-tenant install → no tenant
slug. If it's multi-tenant, you also need the tenant **slug**.)

**Recommended directory layout on the host:**

```
~/maugood-diag/
├── camera_diagnostics.py          # staged here, then docker cp'd into the container
├── camera_diagnostics_report.py   # staged here, then docker cp'd into the container
├── os_watch.sh                    # runs here, on the host
├── oswatch.log                    # Layer-1 output (created at runtime)
├── before/                        # pre-test snapshots (created in step 1)
├── after/                         # post-test snapshots + collected run folder
└── pyspy/                         # optional stack dumps
```

Get the three files onto the host (pick one):
```sh
# from your machine:
scp backend/scripts/camera_diagnostics.py \
    backend/scripts/camera_diagnostics_report.py \
    backend/scripts/os_watch.sh \
    user@client-server:~/maugood-diag/
```
…or paste them into `~/maugood-diag/` with an editor if SCP isn't available.

---

## 1. Pre-flight: capture baseline system info (BEFORE the test)

```sh
mkdir -p ~/maugood-diag/before ~/maugood-diag/after ~/maugood-diag/pyspy
cd ~/maugood-diag

# Resolve the backend container id ONCE (works regardless of compose flags):
BACKEND=$(docker ps --filter name=backend --format '{{.ID}}' | head -1)
echo "backend container = $BACKEND"   # must be non-empty

# --- host baseline ---
{ uname -a; echo; nproc; echo; free -h; echo; df -h; echo;
  docker --version; docker compose version 2>/dev/null; } > before/host.txt 2>&1

# --- is /tmp RAM-backed? (the memory-growth trap) ---
{ echo "== host mounts =="; mount | grep -E '[[:space:]]/tmp[[:space:]]|/data';
  echo "== container /tmp =="; docker exec "$BACKEND" sh -c 'grep -E " /tmp | /data " /proc/mounts || echo "(no separate /tmp mount)"'; } > before/mounts.txt 2>&1

# --- GPU present? (expected: none on a CPU-only box) ---
(nvidia-smi || echo "no NVIDIA GPU") > before/gpu.txt 2>&1

# --- the live capture-relevant config ---
docker exec "$BACKEND" printenv | grep -E \
  'MAUGOOD_CLIP_SAVING_MODE|MAUGOOD_TENANT_MODE|OMP_NUM_THREADS|MALLOC_ARENA' \
  > before/maugood-env.txt 2>&1
# (Confirm here whether it is still MAUGOOD_CLIP_SAVING_MODE=encode.)

# --- container resource snapshot + process list ---
docker stats --no-stream > before/docker-stats.txt 2>&1
docker compose ps > before/compose-ps.txt 2>&1 || docker ps > before/docker-ps.txt 2>&1

# --- backend log tail before we start (for correlation) ---
docker logs --since 30m "$BACKEND" > before/backend-log-30m.txt 2>&1

# --- verify the output dir inside the container is writable + persistent ---
docker exec "$BACKEND" sh -c 'mkdir -p /data/diag && touch /data/diag/.w && echo "/data writable OK" && rm -f /data/diag/.w'
```

If `/data/diag` is **not** writable, use `/app/diag` instead in step 3
(`--out /app/diag`) and `docker cp` it out before any container restart.

---

## 2. Deploy the scripts into the container

```sh
cd ~/maugood-diag
# Copy the collector + reporter INTO the running backend container:
docker cp camera_diagnostics.py        "$BACKEND":/app/scripts/camera_diagnostics.py
docker cp camera_diagnostics_report.py "$BACKEND":/app/scripts/camera_diagnostics_report.py

# Sanity check they import (prints the help):
docker exec "$BACKEND" python -m scripts.camera_diagnostics --help | head -5

# Make the host logger executable:
chmod +x os_watch.sh
```

---

## 3. Start all three layers (survives SSH disconnect)

**Layer 1 — OS-level logger on the HOST** (the can't-fail layer; survives
even a container OOM-kill). `nohup … &` keeps it running after you log out:

```sh
cd ~/maugood-diag
nohup ./os_watch.sh 2 ~/maugood-diag/oswatch.log uvicorn > /dev/null 2>&1 &
echo "os_watch PID = $!"        # note this PID for stopping later
```

**Layer 2 — per-camera collector INSIDE the container, detached.**
`docker exec -d` detaches it from your SSH session, and it writes to files
(not stdout), so disconnecting is safe. Set a duration so it self-stops and
flushes cleanly:

```sh
docker exec -d \
  -e DIAG_ADMIN_EMAIL='admin@CLIENT_TENANT' \
  -e DIAG_ADMIN_PASSWORD='THE_ADMIN_PASSWORD' \
  "$BACKEND" python -m scripts.camera_diagnostics \
    --interval 5 \
    --duration-min 360 \
    --api-timeout 4 \
    --out /data/diag
#  Multi-tenant install? add:  -e DIAG_TENANT_SLUG='theslug'

# Confirm it's running + writing (no pgrep needed — check the files grow):
sleep 8
docker exec "$BACKEND" sh -c 'ls -la /data/diag/run-*/; echo "--- cameras.csv lines:"; wc -l /data/diag/run-*/cameras.csv'
# run it again after ~15s; the line count should increase.
```

> Why `docker exec -d` and not `tmux`: a detached container exec is owned by
> the container, not your shell — it cannot be killed by an SSH drop. The
> collector also `fsync`s every tick, so even a hard crash keeps everything
> up to the last sample.

**(Optional) tmux for an interactive view** — if you prefer to watch live,
run inside `tmux`/`screen` instead of `-d`, then detach with `Ctrl-b d`.

---

## 4. How long to run

- **Minimum useful: ~30–60 minutes** with all 21 cameras active.
- **Recommended: run through a full degradation/freeze cycle** — start in
  the morning and leave it (the `--duration-min 360` = 6 h covers a work
  day; raise it or use `0` for unlimited).
- The transition *into* the slowdown is the most valuable data, which is
  why Layer 1 samples every 2 s. **Don't stop early just because the box is
  healthy** — wait for it to get slow at least once.

---

## 5. If the box hangs during the test — grab a stack dump (Layer 3)

The single most useful "what was it doing when it froze" artifact. Run from
the host the moment it goes unresponsive (best-effort; needs `py-spy` +
ptrace permission):

```sh
PID=$(docker exec "$BACKEND" pgrep -f 'uvicorn|maugood.main' | head -1)   # PID inside container
# If py-spy is installed on the host and can attach to the container PID namespace:
HOSTPID=$(docker inspect --format '{{.State.Pid}}' "$BACKEND")
sudo py-spy dump   --pid "$HOSTPID"                                   > ~/maugood-diag/pyspy/dump-$(date +%H%M%S).txt 2>&1
sudo py-spy record --pid "$HOSTPID" --duration 30 -o ~/maugood-diag/pyspy/flame.svg 2>&1 || true
```
If `py-spy` isn't available, skip it — Layers 1 & 2 still capture the cause.

---

## 6. Stop the diagnostics safely

```sh
BACKEND=$(docker ps --filter name=backend --format '{{.ID}}' | head -1)

# Layer 2 (collector): graceful stop via the PID file → it flushes +
# closes files. Works without pgrep/pkill (often absent in slim images):
docker exec "$BACKEND" sh -c 'kill -TERM $(cat /data/diag/run-*/diag.pid)'
# (or just let --duration-min expire; it stops itself and flushes)

# Layer 1 (os_watch): graceful stop → it appends the kernel OOM tail on exit.
kill -TERM <the os_watch PID from step 3>      # or:  pkill -TERM -f os_watch.sh
```

Both handle SIGTERM cleanly; never `kill -9` first (you'd lose the final
flush + the OOM tail).

---

## 7. Collect the output files

```sh
BACKEND=$(docker ps --filter name=backend --format '{{.ID}}' | head -1)
cd ~/maugood-diag

# Pull the collector run folder OUT of the container:
docker cp "$BACKEND":/data/diag ~/maugood-diag/after/diag
#   → after/diag/run-YYYYMMDD-HHMMSS/{cameras.csv, system.csv, events.jsonl, meta.json, report.md}
```

**The complete evidence bundle to send back:**

| File | From | Contents |
| --- | --- | --- |
| `after/diag/run-*/cameras.csv` | container | per-camera metrics over time |
| `after/diag/run-*/system.csv` | container | host CPU/mem/swap/disk/net + `backend_up`/`api_ok` |
| `after/diag/run-*/events.jsonl` | container | raw anomaly events (decode/preview/clip/detect timings) |
| `after/diag/run-*/meta.json` | container | run params + tmpfs flag |
| `oswatch.log` | host | can't-fail OS trace + kernel OOM tail |
| `pyspy/*` | host | stack dumps if it hung (optional) |
| `before/*` + `after/*` | host | baseline + post-test snapshots |

---

## 8. Post-test commands + generate the report

```sh
BACKEND=$(docker ps --filter name=backend --format '{{.ID}}' | head -1)
cd ~/maugood-diag

# --- after snapshots ---
docker stats --no-stream > after/docker-stats.txt 2>&1
free -h > after/free.txt; df -h > after/df.txt
docker logs --since 6h "$BACKEND" > after/backend-log.txt 2>&1
# kernel OOM-killer verdict (the freeze's cause of death, if any):
( journalctl -k --since "6 hours ago" 2>/dev/null || dmesg ) | \
  grep -iE 'killed process|oom|out of memory' > after/oom.txt 2>&1 || true

# --- generate the verdict report (runs in-container, stdlib only) ---
RUN=$(docker exec "$BACKEND" sh -c 'ls -d /data/diag/run-* | tail -1')
docker exec "$BACKEND" python -m scripts.camera_diagnostics_report "$RUN"
# The console prints the verdict; the full report.md is inside the run folder
# (already pulled out in step 7). You can also re-run the reporter on your
# laptop over the copied folder — it needs only python3 stdlib.
```

---

## 9. Why the capture is trustworthy even if the box freezes

- **Layer 1 (`os_watch.sh`) runs on the host**, reads only `/proc`, at high
  priority — it keeps recording when the app and the container are wedged,
  and survives a container OOM-kill.
- **Layer 2 (collector)** uses a short 4 s API timeout (a frozen backend
  can't stall it for long), **`fsync`s every tick** (a hard crash keeps all
  but the last sample), writes the **OS-level system row regardless of API
  health** (marking `api_ok=0` / `backend_up=0`), and writes to **persistent
  `/data`, not tmpfs**.
- The **gap in per-camera rows** during a freeze, lined up against the CPU /
  memory / swap spike in `system.csv` and `oswatch.log`, is itself the
  evidence.
- The only unavoidable loss is the final ~1 sample before a hard
  power-cycle, and the kernel OOM tail (step 8 / captured on `os_watch.sh`
  exit) tells you what the kernel killed and why.

---

## Quick reference — the whole flow

```sh
# prepare
BACKEND=$(docker ps --filter name=backend --format '{{.ID}}' | head -1)
docker cp camera_diagnostics.py        "$BACKEND":/app/scripts/
docker cp camera_diagnostics_report.py "$BACKEND":/app/scripts/
chmod +x os_watch.sh

# start (both survive SSH disconnect)
nohup ./os_watch.sh 2 ~/maugood-diag/oswatch.log uvicorn >/dev/null 2>&1 &  echo $!
docker exec -d -e DIAG_ADMIN_EMAIL='…' -e DIAG_ADMIN_PASSWORD='…' \
  "$BACKEND" python -m scripts.camera_diagnostics --interval 5 --duration-min 360 --out /data/diag

# … let it run through the slowdown …

# stop
docker exec "$BACKEND" sh -c 'kill -TERM $(cat /data/diag/run-*/diag.pid)'
pkill -TERM -f os_watch.sh

# collect + report
docker cp "$BACKEND":/data/diag ~/maugood-diag/after/diag
RUN=$(docker exec "$BACKEND" sh -c 'ls -d /data/diag/run-* | tail -1')
docker exec "$BACKEND" python -m scripts.camera_diagnostics_report "$RUN"
```
