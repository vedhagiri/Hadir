# Maugood — Hardware Sizing & Optimization for a 25-Camera Site

**Purpose:** recommend, justify, and optimize the hardware for a Maugood
face-attendance deployment serving **25 IP cameras** at a single client office.
Every number below is derived from Maugood's actual pipeline architecture and
from field measurements taken on the client's current 21-camera box.

**Audience:** solution/pre-sales, client IT, and whoever signs the purchase
order. Sections 1–3 are the recommendation and the "why"; Section 4 is the
math; Sections 5–7 are optimization and the fallback envelope.

---

## 0. Executive summary

| Item | Recommendation | Why (one line) |
|------|----------------|----------------|
| **Detection accelerator** | **NVIDIA GPU** (RTX A2000 12 GB / RTX 4000 Ada, or 3060 12 GB min) | Detection is the bottleneck; a GPU shrinks per-detect cost ~10× and is the difference between fitting 25 cameras and not |
| **CPU** | Modern 12–16 core (Zen 4 / recent Xeon/Core, ≥3.5 GHz base) | Runs the reader threads, clip stream-copy, DB, API; single-thread speed matters |
| **RAM** | **64 GB** | 25 reader/analyzer thread pairs + clip pipeline + Postgres + model residency, with headroom |
| **OS / DB / model disk** | 500 GB **NVMe SSD** | Postgres, models, OS — random-IO sensitive |
| **Clip / crop disk** | 2–4 TB SSD (or SSD + HDD tier) | Recorded clips + face crops are the storage hog |
| **Network** | Managed **PoE+ switch(es)**, dedicated camera VLAN, gigabit uplink to server | 25 PoE cameras need power + isolated bandwidth |
| **Power protection** | UPS covering server + switches (≥1500 VA) | A dirty shutdown corrupts in-flight clips and risks the DB |

**The single most important sentence in this document:** Maugood runs face
detection **on the CPU by default and serializes it through one global lock**
(`_detect_lock`). That lock is a single lane with a budget of ~1000 ms of
detect-time per second **for the entire box, no matter how many CPU cores you
add.** Throwing more cores at it does *not* add detection lanes. The only two
ways to serve 25 cameras are (a) make each detection **cheaper** (a GPU), or
(b) run detection **less often** (fewer FPS). This is why the client's current
24-vCPU CPU-only VM struggles at 21 cameras, and why our primary recommendation
is a GPU.

---

## 1. Recommended hardware specification

### 1.1 Primary build — GPU-accelerated (recommended)

| Component | Spec | Notes |
|-----------|------|-------|
| GPU | NVIDIA RTX A2000 12 GB **or** RTX 4000 Ada 20 GB (min: RTX 3060 12 GB) | CUDA for InsightFace/YOLO; ≥12 GB VRAM holds the models + batch headroom |
| CPU | AMD Ryzen 9 / EPYC or Intel Xeon/Core, **12–16 physical cores, ≥3.5 GHz** | Reader threads + clip stream-copy + API + Postgres |
| RAM | **64 GB** DDR4/DDR5 ECC preferred | See §4.3 memory math |
| System disk | 500 GB **NVMe SSD** | OS + Postgres + `/data/models` |
| Clip storage | **2–4 TB SSD** (or 1 TB SSD hot + 4 TB HDD cold) | See §4.4 storage math |
| NIC | 1 GbE (2.5/10 GbE if cameras > 30 or 4K) | Aggregate RTSP pull |
| Chassis | Tower or 2U rack with proper GPU cooling + airflow | The GPU runs hot under continuous inference |

### 1.2 Why *not* a Sangfor/KVM VM without GPU (the current setup)

The client's box today is a **Sangfor aCloud KVM VM, 24 vCPU Intel Haswell
(~2014), no GPU, "Software Rendering"**. Measured on that box:

- **UC1 reprocess ≈ 415 s per clip** (~7 s **per analyzed frame**) — roughly
  **45× slower** than modern hardware would be for the same work.
- **CPU 1366–1690%** (13–17 cores pinned) under normal load at 21 cameras.
- **~2 GB RAM free**, **disk 84% full**.

A GPU is not a "nice to have" here — on CPU-only Haswell the detect-lock ceiling
(§4.2) sits **below** what 25 cameras demand, so the box saturates and lags no
matter how it's tuned. If the client's virtualization policy forbids a GPU, see
the CPU-only fallback envelope in **§6** — it requires cutting FPS hard and
splitting the load across two hosts.

---

## 2. Why each component is required

### 2.1 GPU — the detection accelerator
Detection (finding faces in each frame) is the heaviest, most frequent
operation and it is **CPU-only unless a CUDA GPU is present**. A GPU drops the
per-detection cost from ~80–250 ms (CPU) to ~10–20 ms, which (a) multiplies the
detect-lock throughput ceiling ~10× and (b) frees the CPU cores to keep the
RTSP readers draining at native FPS (no live-view lag, no frame drops). It is
the highest-leverage single component in the whole bill of materials.

### 2.2 CPU — everything that isn't detection
Even with a GPU doing detection, the CPU still runs: **25 RTSP reader threads**
(one per camera, pulling frames at native FPS), **clip recording** (ffmpeg
stream-copy per camera — cheap, but 25 of them), the **FastAPI** app, the
**attendance scheduler**, and **Postgres**. High single-thread speed keeps each
reader from starving. 12–16 modern cores comfortably absorb this; the ancient
Haswell cores do not.

### 2.3 RAM — thread stacks, model residency, clip pipeline
Each camera runs a reader + analyzer thread pair holding recent frames; the
clip-matching pipeline briefly holds sampled frames in memory; Postgres wants
cache; the detection models sit resident. 64 GB gives working room and absorbs
spikes. (A prior memory leak that queued full-frame numpy arrays per clip — up
to ~6.5 GB resident at 21 cameras — has been fixed, but sizing with headroom
protects against the next surprise.)

### 2.4 Two-tier storage — random IO vs. bulk clips
Postgres and model loading are **random-IO sensitive** → NVMe SSD. Recorded
clips and face crops are **large and sequential** but numerous → a big SSD (or
SSD-hot + HDD-cold). Mixing them on one slow disk makes the DB stutter under
clip write load. Disk pressure is a real, observed risk (client box was 84%
full) — undersized storage causes silent clip-write failures and DB bloat.

### 2.5 PoE switching + VLAN — power and clean bandwidth
The 25 cameras are **PoE**: the switch both powers them and carries their RTSP
streams. A managed switch lets us put cameras on a **dedicated VLAN**, isolating
~150–225 Mbps of continuous video from office traffic and containing any camera
misbehavior. PoE **power budget** is a hard limit — see §4.5.

### 2.6 UPS — clip and DB integrity
A power blip mid-clip leaves an abandoned/partial file; mid-transaction it
risks DB corruption. A UPS gives a clean shutdown window and rides out short
outages. Cheap insurance for an always-on capture system.

---

## 3. The performance model (how Maugood actually spends CPU/GPU)

```
 RTSP camera ──► Reader thread (native FPS)          one per camera
                    │  keeps only the latest frame (skip-to-latest, buffer=1)
                    ▼
                 Analyzer thread (≤ analyzer_max_fps = 3.0 fps default)
                    │  motion-skip: cheap grayscale diff skips still frames
                    ▼
                 detect()  ── acquires the GLOBAL _detect_lock ──┐
                    │        ~1000 ms/s budget, ONE lane box-wide │  ← the ceiling
                    ▼                                             │
                 matcher (cosine vs enrolled faces) ─────────────┘
                    ▼
                 attendance / clip / crop writes
```

Key architectural facts that drive the sizing:

- **`analyzer_max_fps = 3.0`** — the analyzer attempts up to 3 detections/sec
  per camera (not the camera's full frame rate).
- **`force_detect_every_s = 3.0`** — even a perfectly still scene forces one
  detection every 3 s, so idle cameras still cost lock time.
- **`det_size = 320`** — the detector input size; smaller = cheaper but lower
  recall on small/distant faces.
- **One global `_detect_lock`** — all cameras' detections run **one at a time**.
  This is the load-bearing constraint. Detection throughput box-wide is
  `1000 ms/s ÷ per-detect-ms`, **independent of core count**.
- **Reader ≠ detection** — readers run in parallel and are cheap per camera, but
  25 of them plus clip encode can still starve the CPU if detection is also
  fighting for cores (the CPU-only failure mode).

---

## 4. Performance calculations for 25 cameras

All figures use **realistic per-detection cost `D`** for each hardware class.
`D` for CPU is a modern-CPU starting point; the client's Haswell is worse.

| Hardware class | Per-detect `D` | Detect-lock ceiling = 1000/`D` |
|----------------|---------------|--------------------------------|
| **GPU** (RTX A2000/4000, CUDA, det_size 320) | ~15 ms | **~66 detections/sec** box-wide |
| **Modern CPU** (Zen4/recent Xeon, det_size 320) | ~80 ms | **~12 detections/sec** box-wide |
| **Client's Haswell CPU** (measured behaviour) | ~250 ms+ | **~4 detections/sec** box-wide |

### 4.1 What 25 cameras *demand*

Demand = `Σ (per-camera analyzer FPS × D)`. Two operating points:

- **At the default 3 FPS/camera:** 25 × 3 = **75 detections/sec demanded**.
- **At a tuned 1 FPS/camera** (plenty for someone walking past a door — they're
  in frame 2–5 s): 25 × 1 = **25 detections/sec demanded**.

> Note: motion-skip reduces demand in genuinely quiet scenes, but a busy office
> lobby defeats it — we size for the busy case, not the average.

### 4.2 Demand vs. ceiling — does it fit?

| | Demand @3 FPS | Demand @1 FPS | GPU ceiling (66/s) | CPU ceiling (12/s) | Haswell ceiling (4/s) |
|---|---|---|---|---|---|
| **75/s** | ✗ 6× over even on GPU | | | | |
| **25/s** | | ✓ **fits on GPU (38% of lane)** | ✓ | ✗ 2× over | ✗ 6× over |

**Reading the table:**

- **GPU @ ~1 FPS/camera → 25/s demand vs 66/s ceiling = ~38% lane usage.**
  Comfortable, with headroom for bursts and for det_size 480 if recall needs it.
  **This is the recommended operating point.**
- **Modern CPU, no GPU:** even at 1 FPS the 25/s demand is ~2× the 12/s ceiling.
  You must drop to ~0.5 FPS/camera *and* lean on motion-skip — workable for
  low-traffic sites, fragile for a busy 25-camera office.
- **Haswell CPU (today):** 4/s ceiling vs 25/s demand = **6× over budget**. This
  is precisely why the current box lags, drops frames, and misses faces. No
  amount of tuning closes a 6× gap; only cheaper detections (GPU) or far fewer
  cameras per box does.

### 4.3 Memory calculation (target 64 GB)

| Consumer | Estimate |
|----------|----------|
| 25 × reader+analyzer frame buffers (latest frame, ~2–8 MB each) | ~0.5 GB |
| Clip pipeline in-flight frames (bounded after leak fix) | ~1–2 GB |
| Detection models resident (InsightFace + YOLO) | ~1–2 GB (VRAM if GPU) |
| Postgres shared buffers + cache | ~8–16 GB |
| FastAPI / workers / OS | ~2–4 GB |
| **Headroom for spikes & fragmentation** | remainder |

32 GB *works* but leaves little margin (the client box sat at ~2 GB free).
**64 GB** is the safe target for 25 cameras and removes memory as a variable.

### 4.4 Clip storage calculation

Recorded clips dominate disk. Using **stream-copy** (no re-encode) at 4 MP:

- A 4 MP main stream ≈ **4–8 Mbps** → a 30 s clip ≈ **15–30 MB**.
- Field reference: the client accumulated **~20,000 clips**; at ~15–20 MB each
  that is **~300–400 GB** before crops.
- Face crops are small (tens of KB each) but numerous — budget another
  ~50–100 GB.

**Recommendation: 2 TB usable minimum, 4 TB comfortable**, with a retention
policy (auto-delete clips older than N days) so growth is bounded. Size the
disk from *retention window × daily clip volume*, not "forever."

### 4.5 Network / PoE calculation

- **Bandwidth:** 25 × (main ~4–8 Mbps + sub ~1 Mbps) ≈ **125–225 Mbps**
  aggregate. Gigabit LAN handles this, but the **server uplink** must carry the
  full sum (Maugood pulls every stream directly — there is no NVR aggregating).
- **PoE power:** 25 × ~8–12 W ≈ **200–300 W of PoE budget**. A single 24-port
  PoE+ switch typically offers ~370 W — enough for 25 cameras, but verify the
  switch's **total PoE budget**, not just its port count. Two 24-port switches
  give room to grow and split failure domains.
- **Segmentation:** put all cameras on a dedicated **camera VLAN**; the server
  gets a leg on that VLAN. Isolates video load and shrinks the attack surface.

---

## 5. Optimization recommendations (stable performance)

Apply these regardless of hardware; on a GPU box they buy headroom, on CPU they
are survival.

### 5.1 Detection tuning (the biggest levers)
- **Use the GPU** (CUDA execution provider) — collapses `D`, the whole game.
- **`analyzer_max_fps`**: set to **1–2** for attendance. 3 is rarely needed; a
  person is in frame for seconds. Lower FPS = proportionally less lock demand.
- **`det_size`**: 320 is the balanced default. Drop to 256 to fit more cameras
  on CPU (costs small-face recall); raise to 480 only on a GPU with lane
  headroom when distant faces are being missed.
- **Detection mode**: InsightFace (`insightface`) is ~2× cheaper per detect than
  `yolo+face`; prefer it for the live attendance path unless YOLO's recall is
  specifically needed.

### 5.2 Motion-skip — tune, don't over-skip
Motion-skip saves huge CPU on still scenes, but **over-aggressive settings drop
real faces** (field data showed motion-skip 5.0 skipping 29/30 frames and
finding **zero faces**). Keep it moderate (~1.5–2.0) so distant/small faces
still trigger detection. Recall first, then CPU.

### 5.3 Clip recording — stream-copy, not encode
Use **`stream_copy`** (ffmpeg `-c copy`): it writes the camera's existing H.264
bytes with near-zero CPU. **`encode`** re-compresses every frame and was a prime
CPU/RAM sink on the client box. (Caveat: some cameras' ffmpeg builds rejected a
timeout flag and produced zero clips — verify clips are actually landing after
enabling stream-copy.)

### 5.4 Viewer-gated preview
The annotated live-preview JPEG should only be encoded when someone is actually
watching that camera. Encoding previews for all 25 cameras continuously (when
nobody is on the Live Capture page) wastes cores — ensure the build in
production gates preview encode on active viewers.

### 5.5 Thread caps
Pin inference to a bounded thread count (`MAUGOOD_INFERENCE_THREADS`, OMP/MKL
env caps) so a single detection can't fan out across all cores and starve the
readers. Without caps, one detect() call can grab far more CPU than intended.

### 5.6 Storage hygiene
- Enforce a **clip retention policy** (auto-purge > N days) — never let disk hit
  ~85%+ (observed on the client box); a full disk breaks clip writes silently.
- Keep Postgres on the NVMe, clips on the bulk tier.

### 5.7 Observability — prove it's healthy
Maugood exposes per-worker stage stats and host metrics:

```sh
curl -s localhost:8000/api/super-admin/system/metrics | python3 -m json.tool  # CPU/RAM/detector-lock contention
curl -s localhost:8000/api/operations/workers        | python3 -m json.tool  # per-worker detect timing, FPS, stage colours
```

Watch **`_detect_lock` contention %**, **detect_ms**, per-camera reader vs
native FPS, and host CPU/RAM/disk. Wire the Prometheus/Grafana stack (already
shipped) so the client sees green/amber/red before users complain.

---

## 6. CPU-only fallback envelope (if a GPU is truly impossible)

If the client's virtualization policy forbids GPU passthrough/vGPU, 25 cameras
on CPU-only requires **both** cutting settings **and** splitting hosts:

1. **Split 25 cameras across two hosts** (~12–13 cameras each) so each host's
   detect demand fits its ~12/s modern-CPU ceiling.
2. **`analyzer_max_fps = 1`**, **`det_size = 256`**, **InsightFace mode**,
   **motion-skip ~2.0**, **stream-copy clips**, **viewer-gated preview**,
   **thread caps on**.
3. Modern CPU per host (not Haswell) — ≥12 fast cores, 32–64 GB, NVMe + bulk
   disk each.
4. Accept reduced per-camera detection frequency: at 1 FPS a fast walker is
   still caught, but this is a tighter recall margin than the GPU path.

This is a workaround, not a match for the GPU build. The recommended answer for
a **single-box, 25-camera** office remains **one GPU-accelerated server**.

---

## 7. Bill of materials (recommended build)

| # | Item | Qty | Purpose |
|---|------|-----|---------|
| 1 | GPU server: 12–16 core modern CPU, 64 GB ECC, 500 GB NVMe + 2–4 TB SSD, **NVIDIA RTX A2000 12 GB / RTX 4000 Ada** | 1 | Maugood host — detection + capture + DB + API |
| 2 | 24-port managed PoE+ switch (≥370 W budget) | 1–2 | Power + network for 25 cameras (2 for headroom/redundancy) |
| 3 | 4 MP PoE IP cameras (Hikvision / Dahua, 2.8–3.6 mm) | 25 | Face capture at entry/attendance points |
| 4 | UPS ≥1500 VA (server + switches) | 1 | Clean shutdown, ride-through |
| 5 | Cat6 cabling, patch panel, camera VLAN config | — | Structured, isolated camera network |
| 6 | (Optional) NAS / off-box backup target | 1 | DB + clip backups per DR policy |

---

## 8. Assumptions & how to firm up the numbers

This document sizes from the pipeline architecture + field measurements on the
client's current box. Before final sign-off, **measure `D` on the exact target
hardware** so the ceiling math is exact, not extrapolated:

```sh
# On the target host, at realistic activity and camera count:
curl -s localhost:8000/api/super-admin/system/metrics | python3 -m json.tool
curl -s localhost:8000/api/operations/workers        | python3 -m json.tool
# Read: detect_ms (that is D), _detect_lock contention_pct_60s, host CPU/RAM/disk.
```

- Capacity is stated **with assumptions**: FPS/camera, det_size, detection mode,
  and activity level. Change any of those and the supported camera count moves.
- The GPU recommendation holds across a wide range of `D`; the CPU-only path is
  sensitive to the measured `D` and should be validated on the actual CPU before
  committing to a single-box design.

---

*Prepared for the 25-camera client deployment. Figures grounded in Maugood's
`_detect_lock` serialization model, the shipped capture defaults
(`analyzer_max_fps=3.0`, `det_size=320`, `force_detect_every_s=3.0`), and
measured field data from the client's 21-camera Haswell VM.*
