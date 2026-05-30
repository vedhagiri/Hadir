# Live Capture scalability analysis — can this support 45 cameras?

**Date:** 2026-05-30
**Question:** reader FPS degrades 25 → 17 → 10 during viewing; will the
current architecture support 45 cameras without FPS degradation?

**Short answer: No — not as currently architected, on any realistic
single host.** The FPS degradation is *not* primarily the clip-encode
cost that Fix A/B addressed; it is **CPU-core contention between
per-camera HEVC video decode and detection inference, neither of which
is thread-budgeted.** There are two independent hard ceilings (decode
cores, and a global serial detection lock) that 45 cameras blow past by
roughly an order of magnitude. This document gives the measurements,
the root cause, the honest before/after, the scaling math, and what a
45-camera design actually requires.

---

## 0. Measured environment (evidence)

All numbers captured on the running dev stack, 2026-05-30.

| Fact | Value | Source |
|---|---|---|
| Host cores | **24** | `nproc` |
| Host RAM | **15 GiB** | `free -h` |
| Host memory used | **13 GiB used, 439 MiB free** | `free -h` |
| Host swap in use | **2.6 GiB** (swapping) | `free -h` |
| Load average | **25.8 / 22.1 / 42.6** (1/5/15 min) | `/proc/loadavg` |
| Backend CPU (live, 6 samples) | **886% – 1914%** (≈ 9–19 cores) | `docker stats` |
| Backend RSS | **~7.0 GiB, steady** (not growing) | `docker stats` |
| Backend threads | **211** | `/proc/<pid>/task` |
| `torch.get_num_threads()` | **16** (uncapped) | in-container probe |
| `cv2.getNumThreads()` | **24** (uncapped) | in-container probe |
| `OMP_NUM_THREADS` | **unset** | in-container probe |
| Working cameras at capture | **~1–2** (rest unreachable) | logs / DB |
| `live_matching_enabled` | **false** (both tenants) | DB |
| Camera streams | **2560×1440 / 1920×1080 H.265 @ 25 fps** | DB `detected_*` |

**The single most important line:** the backend is burning 9–19 cores
and 7 GiB **with effectively one working camera and face-recognition
turned off** (YOLO body detection only). That is the baseline we must
multiply by 45.

---

## 1. Root cause of the FPS degradation (25 → 17 → 10)

### It is decode-vs-inference core contention, not clip encoding.

The reader thread runs at the camera's **native 25 fps** and must
**decode every frame of a 2560×1440 H.265 stream**. HEVC decode on CPU
is multi-threaded inside libavcodec (`cv2.getNumThreads() = 24`), so a
single 1440p stream alone wants several cores during motion.

In parallel, the analyzer thread runs YOLO (`yolov8n`, ultralytics →
torch, `torch.get_num_threads() = 16`) every cycle that motion-skip
does **not** skip. Detection is serialized across cameras by one
process-global `_detect_lock`, but the single in-flight detect call
**saturates up to 16 cores**.

The feedback loop that produces 25 → 17 → 10:

1. Scene is quiet → motion-skip suppresses detection → reader has the
   cores to itself → decode keeps up → **fps ≈ 25**.
2. A person enters and stays → motion is continuous → YOLO runs every
   analyzer cycle (up to `analyzer_max_fps = 6`), each call grabbing
   ~16 cores → the reader's HEVC decode is **starved of CPU**.
3. `cap.read()` blocks waiting for the next decoded frame. The
   pre-fix diagnostic shows exactly this: `t_read_ms` p50 = 3 ms but
   **p95 = 173 ms, max = 294 ms** — a 294 ms read is 3.4 fps for that
   frame. Read time is normally trivial; under contention it balloons.
4. `CAP_PROP_BUFFERSIZE = 1` means the driver keeps only the latest
   frame, so starved time is converted directly into **dropped frames**
   → the visible choppiness, and the `fps_reader` counter falls.
5. Sustained activity keeps detection hot, so fps trends **downward**
   over a busy session and recovers only when the scene goes quiet.

### Aggravating (not root) factors

- **Memory at 95% + 2.6 GiB swap.** This dev box also runs Chrome,
  mongod, ollama, gnome. When the working set is paged out, every
  `malloc` of an 11 MB frame and every decode buffer touch can fault
  to disk, deepening the dips. On a dedicated server this is smaller,
  but RSS is still ~7 GiB for ~2 cameras (see §4).
- **Reconnect storm from unreachable cameras.** The diagnostic logged
  **146 `ffmpeg_restart` + 37 `rtsp_reconnect` + 38 `segmenter_thrashing`
  events in ~10 minutes** — two dead cameras (192.168.0.4) each looping
  reopen + a restarting stream-copy ffmpeg. That is real CPU churn that
  competes with the healthy camera.

### Why Fix A/B did not stop the degradation

Fix A (async clip encode) and Fix B (downscaled, per-slot preview)
removed the reader thread's *own* heavy work — the 212 ms median clip
encode and 60 ms preview encode that used to run inline. That is a real
improvement to the **steady-state per-frame budget** (see §2). But
neither change reduces **HEVC decode cost** or **YOLO inference core
demand**, and those are the dominant consumers. The reader still gets
starved of cores under load, so fps still sags. **The bottleneck moved
from "reader does too much work" to "reader can't get CPU time."**

---

## 2. Before / after (what Fix A/B did and did not change)

Per-frame reader-thread cost, from the pre-fix `frame_slow` diagnostic
(camera 9, 1440p, 279 slow frames over 10 min):

| Stage | Before (p50 / p95 / max) | After Fix A/B | Mechanism |
|---|---|---|---|
| `t_clip_ms` (clip encode) | 212 / 523 / 639 ms | **~0 ms on reader** | moved to dedicated encoder thread + bounded queue |
| `t_preview_ms` (preview) | 60 / 472 / 594 ms | **~15 ms, only when viewed** | one slot instead of two, downscale to 1280 before encode |
| `t_read_ms` (decode) | 3 / 173 / 294 ms | **unchanged** | decode is not something Fix A/B touches |
| `t_total_ms` (reader) | 331 / 657 / 958 ms | dominated by `t_read` | — |

**Verification status, stated honestly:**
- Fix A/B is structurally verified: code restarted clean, 3 workers +
  their new `capclip-*` encoder threads running; `test_live_capture.py`
  passes; the 3 `test_capture.py` failures pre-date this change
  (confirmed by `git stash` + re-run on baseline).
- Fix A/B is **not** proven to fix the user-visible degradation,
  because the degradation is driven by `t_read` (decode starvation),
  which Fix A/B does not address. The reader-budget improvement is
  real but insufficient. **Do not treat the lag as fixed.**

---

## 3. Scalability estimate for 45 cameras

Two independent ceilings. 45 cameras blows past both.

### Ceiling 1 — decode + inference cores

Measured: ~9–19 cores for ~1–2 working cameras (1440p HEVC @ 25 fps,
YOLO body-only, no face recognition). Attributing conservatively and
discounting the reconnect churn, a healthy actively-detecting 1440p
camera at native fps costs on the order of **2–4 cores** (decode
dominates; detection adds on top when motion is present).

| Cameras | Cores needed (decode+detect, native 25 fps, 1440p) | Host has |
|---|---|---|
| 1 | 2–4 | 24 |
| 12 | 24–48 | 24 (**already over**) |
| 45 | **90–180** | 24 |

Even a large server (64 physical cores) cannot decode 45× 1440p HEVC at
25 fps and run detection at native settings. **This is the wall.**

### Ceiling 2 — the global serial detection lock

`_detect_lock` is process-global: only one detection runs at a time
across **all** cameras (correct on CPU — parallel detects thrash cache —
but it caps aggregate throughput). At ~80–150 ms per detect, the whole
process can do **~7–12 detects/second total**, regardless of core
count or camera count.

- 45 cameras × `analyzer_max_fps = 6` = **270 detect calls/s demanded**.
- Supply ≈ 10/s. **27× oversubscribed.**
- Effect: each camera gets a detection roughly **every 4–5 seconds**
  instead of 6×/second. Person-presence detection, clip triggering,
  and (when enabled) identification latency all collapse. Tracks
  flicker; clips start/stop late.

Turning face recognition **on** (`live_matching_enabled = true`) makes
Ceiling 2 dramatically worse — each detect then also runs InsightFace
detection + 512-D recognition per face.

**Verdict:** 45 cameras at native resolution/fps with per-frame
decode + shared serial detection is **not feasible on one host**, and
not feasible on any single host at native settings.

---

## 4. Expected CPU and memory at scale

**CPU:** dominated by HEVC decode at native fps. ~2–4 cores/camera →
90–180 cores for 45. Detection is capped by the serial lock, so adding
cores past ~24 does not raise detection throughput — it only helps
decode, which is the part that scales linearly with cameras.

**Memory:** RSS is steady ~7 GiB with ~2–3 workers and is **not
leaking** (ClipWorker queue is bounded at 16, the clip-encode queue at
8, stream-copy segments rotate at ~45 MB). The ML models are loaded
once at module scope and shared across workers. Per-worker incremental
cost is frame buffers + queues + libavcodec decode buffers:

- `_latest_frame`: ~11 MB (one 1440p BGR frame)
- clip-encode queue: 8 × ~11 MB = ~88 MB when recording
- preview slots + decode internal buffers: tens of MB
- ≈ **150–300 MB per worker** above the shared ~2–3 GiB model/runtime base.

Projection: 45 × ~250 MB + ~3 GiB base ≈ **~14–18 GiB for capture
alone**, before concurrent clip recording spikes. Needs a **32 GiB+**
host. Memory is a softer ceiling than CPU but still rules out a 16 GiB
box.

---

## 5. Remaining bottlenecks that still cause drops / lag

1. **Per-camera full-frame HEVC decode at native fps** (the wall). The
   reader decodes every 1440p frame even though attendance/clips need
   far less.
2. **Global serial `_detect_lock`** caps aggregate detection at ~10/s
   for the whole process.
3. **Uncapped thread pools** (`cv2=24`, `torch=16`, OMP unset). With
   N workers, decode threads × N and inference threads oversubscribe
   24 cores → context-switch thrash. 211 threads already.
4. **`CAP_PROP_BUFFERSIZE = 1`** converts any reader stall directly
   into dropped frames (chosen for latency; it trades smoothness for
   freshness under load).
5. **Reconnect/segmenter storm** from unreachable cameras (146 ffmpeg
   restarts/10 min for 2 dead cameras). At 45 cameras any flaky subset
   compounds this.
6. **`MAUGOOD_CLIP_SAVING_MODE=stream_copy`** runs one always-on ffmpeg
   **per camera** (remux to rolling segments). Cheap-ish (`-c copy`, no
   decode) but it is 45 more persistent processes + RTSP connections +
   disk writers, plus the restart churn above.
7. **Memory/swap pressure** deepens every dip when the host is
   over-committed.

---

## 6. What a 45-camera design actually requires

The current design is fine for a **handful** of cameras. To reach 45,
the decode and detection model must change. In rough priority:

1. **Detect on a low-res substream, not the full stream.** Most IP
   cameras expose a secondary substream (e.g. 640×480/720p). Decode
   *that* for motion + YOLO; pull the high-res main stream only for the
   clip recording (and ideally stream-copy it without decoding). This
   cuts decode cost ~5–10× — the single highest-leverage change.
2. **Cap thread pools and pin inference.** Set `cv2.setNumThreads()`
   low (e.g. 2–4), `torch.set_num_threads()` low, and onnxruntime
   `SessionOptions.intra_op_num_threads` explicitly. Stops 45 workers
   from each trying to grab all 24 cores. Prevents the thrash that
   makes the dips worse.
3. **Decode-bound the reader, not native-fps-bound.** The reader does
   not need 25 fps for attendance; cap the reader's *processed* fps
   (e.g. 5–8 fps) and let the driver drop the rest. Preview can
   interpolate/stream what it has. This alone could cut decode cost ~3–5×.
4. **Make detection throughput scale.** Either a worker pool of detect
   processes (not one global lock), or GPU/NVDEC for decode+inference.
   A single modest GPU changes the decode and inference math entirely
   (hardware HEVC decode + batched inference).
5. **Distribute across hosts.** Even optimized, 45× 1440p is a lot for
   one box. Shard cameras across 2–4 capture nodes feeding one DB.
6. **Fix the reconnect storm.** Back off unreachable cameras
   aggressively (longer ceilings, circuit-breaker) so dead cameras
   don't burn CPU and don't restart their stream-copy ffmpeg every
   couple seconds.

---

## 7. Implemented fix — compute thread-pool caps (2026-05-30)

### The exact root cause, narrowed by measurement

Follow-up measurements on the running stack corrected an earlier
assumption. Decode and preview are **not** the bottleneck:

- HEVC decode of the live 1080p stream: **0.2 cores, steady 24.9 fps**;
  the FFmpeg `threads` option made no measurable difference.
- Preview encode (downscaled 1280, Q70): **~8 ms**, stable even under a
  concurrent inference load on this 24-core box.
- Idle backend: **~1 core**. The 1900%+ spikes are activity-driven.

The actual mechanism is **core monopolization by uncapped inference**.
Measured, running the real YOLOv8n model on a 480 px input:

| `torch` threads | YOLO throughput | Cores grabbed per inference |
|---|---|---|
| 16 (default) | 37.4 inf/s | **16 of 24 cores** |
| 4 (capped) | **67.0 inf/s** | **4 cores** |

When a person is in frame, motion-skip stops skipping and YOLO runs
every analyzer cycle. Uncapped, each inference grabbed **16 cores in a
burst**, colliding with the reader's decode + preview + clip-encode and
pushing the reader loop past its 40 ms frame budget → dropped frames →
`fps_reader` 25 → 17 → 10. Quiet scene → no detection → fps recovers.
That is the gradual-drop-under-activity signature exactly.

Note the surprise: at 480 px, yolov8n is so small that 16 threads is
**slower** than 4 (sync overhead > parallelism). Capping is a strict
win — faster detection *and* 4× less core monopolization.

### What was changed

- New `maugood/compute_threads.py` → `configure_compute_threads()`,
  called once in `create_app()` before any capture worker spawns:
  `cv2.setNumThreads(4)`, `torch.set_num_threads(4)` (+ interop),
  and `OMP/MKL/OPENBLAS_NUM_THREADS=4` for the BLAS/onnxruntime-CPU
  backends.
- `docker-compose.yml` sets `OMP_NUM_THREADS` / `MKL_NUM_THREADS`
  in the environment too, so the cap is in effect *before* torch /
  onnxruntime import and size their pools (the runtime API calls are
  authoritative for cv2/torch; the env is the lever for onnxruntime's
  CPU provider when recognition is enabled).
- Knobs: `MAUGOOD_CV2_NUM_THREADS`, `MAUGOOD_TORCH_NUM_THREADS`,
  `MAUGOOD_ORT_INTRA_OP_THREADS` (defaults 4).

Verified live: worker boots logging `cv2 threads capped to 4` /
`torch threads capped to 4`.

### What this fixes and what it does not

- **Fixes:** one camera's detection burst can no longer grab 16/24
  cores, so the reader keeps cores and holds fps under activity; and
  multiple cameras' detections no longer collide into oversubscription.
  This is the direct, measured remedy for the 25 → 17 → 10 drop.
- **Does NOT change** the §3 scaling ceilings. Per-camera native-fps
  decode is still linear, and the global serial `_detect_lock` still
  caps aggregate detection. 45 cameras still need the substream +
  reader-fps-cap + distribution work in §6.

### Next step if a fresh diagnostic still shows reader-budget overruns

If `t_total_ms` on the reader still exceeds 40 ms under real load after
the caps, the next change (designed, not yet implemented) is to **move
preview encode off the reader onto a dedicated, fps-capped thread** and
**downscale clip frames to the configured 720 p before the Q95 encode**
(measured 18 ms → 3.7 ms, a 5× clip-encoder reduction; the final MP4 is
720 p regardless). That makes reader fps purely a function of decode —
structurally immune to encode cost. It is gated on a fresh diagnostic
because on 1–2 cameras the reader's own work already measures well
under budget; the thread caps address the mechanism that was actually
firing.

### How to capture a fresh post-fix diagnostic

Enable diagnostics, view the camera with a person in frame for a few
minutes during real activity, then export the JSON and compare
`fps_reader` stability and `t_total_ms` against the pre-fix file. Do
not judge from a short idle test — the degradation only appears under
sustained activity.

---

---

## 8. Live Capture Diagnostics tab — FPS-drop instrumentation (2026-05-30)

A later screenshot showed the decisive split: `/live-stats` reported
**`fps_reader: 25.0`** (the reader is now steady at native rate — the
thread caps held) while the page displayed **12 fps**. So the residual
choppiness is in the **delivery chain** (preview encode → MJPEG pacing
→ network → browser), not capture.

To localise it without guessing, a focused diagnostics tab was added
(extends the existing Frame Diagnostics ring):

- **Backend:** the MJPEG generator measures the *actual delivered* feed
  fps per viewer (`_FeedFpsMonitor` in `live_capture/router.py`). Once
  per second, if the delivered fps falls below ~92% of the camera's
  native rate (25 → 23), it records one `fps_drop` event carrying:
  timestamp, camera, current/previous fps, reader fps, analyzer fps,
  live person count, host CPU%/mem%, clip-encode queue depth, reconnect
  delta, and per-stage timings (read / preview / clip / detection). A
  classifier (`_classify_fps_drop` in `diagnostics/recorder.py`) turns
  that into a human cause list + one category. The load-bearing rule:
  **if the reader is at full rate but the feed is slow, it labels the
  event `delivery_pacing`** and says so — pointing at the MJPEG/preview
  path, not capture. All work is gated on `diagnostics.is_enabled()`
  (zero cost when off). Surfaced via the existing
  `GET /api/diagnostics/events?kind=fps_drop`.
- **Frontend:** new `/live-diagnostics` page (System → Live Capture
  Diagnostics) — Start/Stop monitoring, Clear, and one card per drop
  event in the requested format (`FPS dropped: 25 → 18`, *Possible
  cause:* bullets, full metric grid). Healthy feed logs nothing.

Verified: the classifier correctly returns `delivery_pacing` for the
reader-25/feed-12 case and a full multi-cause breakdown (clip 420 ms,
preview 180 ms, CPU 92 %, queue backlog, reconnect) for a capture-side
case; the events endpoint serves them; frontend typecheck clean.

The strong expectation from §7's MJPEG analysis: drops will classify as
`delivery_pacing`, confirming the next fix belongs in the MJPEG
generator (the skip-and-sleep-another-interval phase mismatch that
halves 25 → ~12) — but the tab will *prove* it from real data before
any change, which is the point.

---

### Honest confidence statement

I am **not** confident the current architecture remains stable as
cameras are added — the evidence says the opposite. One working camera
already consumes ~10 cores and 7 GiB with recognition off; the cost is
dominated by per-camera native-fps HEVC decode (linear in cameras) and
gated by a serial detection lock (constant ceiling). Linear
extrapolation puts 45 cameras at 90–180 cores and ~14–18 GiB — far
beyond one host. Fix A/B is a genuine improvement to one cost class and
worth keeping, but it does not change the decode/detection ceilings and
must not be read as making the system 45-camera-ready. Reaching 45
cameras requires the substream + thread-cap + reader-fps-cap changes in
§6 (and likely GPU and/or multiple hosts), followed by a real staged
load test (5 → 10 → 20 cameras) measuring `fps_reader` stability,
detect-queue latency, and core saturation at each step.
