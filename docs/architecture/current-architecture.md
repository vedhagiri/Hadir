# Maugood — Current (As-Built) Architecture, End to End

> Scope: the **complete capture → attendance pipeline as it runs today**
> (v1.1.25), documented in the same grounded format as the per-stage companion
> docs. This is the **as-built reference** — what actually runs, which threads
> and processes exist, what is shared, and where the current bottlenecks are.
> For the *alternative* architectures and the "best CPU-only approach" per
> stage, see each stage's companion doc (cross-referenced at the end).
>
> Target box this reasons about: **one site, 21+ cameras, 24 vCPU / ~16–32 GB,
> CPU-only (no GPU)** — the Sangfor KVM box from the performance incident.

---

## The pipeline at a glance

```
                         ┌──────────────────────── per camera ────────────────────────┐
 RTSP camera ──┬────────▶│ Reader thread (native fps) ──▶ latest-frame slot            │
   (2 pulls)   │         │        │                              │                     │
               │         │        ▼                              ▼                     │
               │         │  Preview JPEG (MJPEG)          Analyzer thread (≤3 fps)     │
               │         │  → browser Live Capture           │  motion-skip (~3 ms)    │
               │         │                                   ▼                         │
               │         │                          detect()  ── _detect_lock ──┐      │
               │         │                             (YOLO / InsightFace)      │      │
               │         │                                   │                   │      │
               │         │                          person tracker (IoU)  ◀──────┘      │
               │         │                                   │ presence → clip trigger  │
               │         └───────────────────────────────────┼──────────────────────────┘
               │                                              ▼
               └──▶ Segmenter ffmpeg (-c copy, 10 s segments) ─▶ ClipWorker: concat-copy
                    (2nd RTSP pull)                               ─▶ Fernet encrypt ─▶ save
                                                                        │
                                                                        ▼
                                             ┌───────── Clip Pipeline (shared workers) ─────────┐
                                             │ UC1 crop (yolo+face@960)  ─┐                      │
                                             │ UC2 crop (insightface@640)─┼─▶ Match (cosine vs   │
                                             │ UC3 …                      ┘   MatcherCache)      │
                                             └───────────────────────────────────┬──────────────┘
                                                                                  ▼
                                          detection_events ─▶ Attendance batch (every 15 min)
                                                                    ─▶ attendance_records ─▶ Reports
```

**The one sentence that explains the whole system's performance:** every
detection — live, UC1, UC2, UC3 — runs through **one global `_detect_lock`, one
at a time, process-wide**. Detection is the ceiling; every other stage (clip
saving, matching, attendance) is cheap by comparison.

---

## Stage 1 — Live feed / RTSP (`capture/reader.py`)

**Current design.** Each camera runs a **two-thread** worker: a **reader**
thread pulls the RTSP stream at native fps (OpenCV, `CAP_PROP_BUFFERSIZE=1`,
skip-to-latest into a single `_latest_frame` slot), and an **analyzer** thread
consumes the latest frame at **≤ `analyzer_max_fps` = 3.0 fps**. The reader also
produces the annotated **MJPEG preview** for the browser Live Capture page.

- Preview is produced by decode → **2× full-res JPEG re-encode per native
  frame** (`_update_preview`).
- Reader → analyzer handoff is a **single latest-frame slot** — a slow analyzer
  does **not** backlog frames; it just samples fewer of them.

**Resource behavior.** ❌ CPU-heavy: full decode at native fps **plus**
always-on preview re-encode. Preview cost scales with `cameras × native fps`,
not with how many people are watching.

**Current bottleneck.** Preview re-encode competing with `cap.read()` for CPU →
frame drops + live-view lag under load. *(Alternatives — viewer-gating,
sub-stream, WebRTC relay — in `live-feed-options.md`.)*

---

## Stage 2 — Detection / tracking (`detection/detectors.py`, `capture/analyzer.py`)

**Current design.** Models are **module-level singletons — one set for the whole
process**: one **YOLOv8n** (person) and one **InsightFace buffalo_l** bundle
(detect + recognition + landmark + gender/age), lazily loaded once. The tracker
is **pure IoU math, no model**. The per-camera `Analyzer` holds **no model** —
it's a thin config-holder that calls the shared globals under **`_detect_lock`**.

Before each detection, a cheap **motion-skip** (160px grayscale abs-diff, ~3 ms)
drops still frames; `force_detect_every_s = 3.0` guarantees at least one
detection every 3 s even on a still scene. `det_size = 320` default.

**Resource behavior.**
- **Memory: ✅ ~0.7–1.0 GB flat, regardless of camera count** (one bundle, not
  one per camera) — the design's biggest strength.
- **CPU: ❌ the ceiling.** One detection at a time × ~80 ms (InsightFace) /
  ~150 ms (YOLO+face) at det_size 320 → **~7–12 detections/sec total, shared
  across all cameras, independent of core count.**

**Why the lock exists.** Each inference already fans across cores via intra-op
threads; running two concurrently thrashes L1/L2 cache and oversubscribes — so
**serial-with-full-cores beats parallel-fighting-for-cores** on CPU.

**Current bottleneck.** The single lock is *the* system ceiling. *(Escapes —
multiprocess sharding, worker pool — in `stage2-detection-models.md`.)*

---

## Stage 3 — Clip recording (`capture/segmenter.py`, `capture/clip_worker.py`)

**Current design.** **No ML — pure I/O + ffmpeg.** Per camera a **`RtspSegmenter`
ffmpeg subprocess** continuously writes **10 s MP4 segments with `-c copy`**
(`SEGMENT_SECONDS=10`, no decode/encode), a **watchdog** restarts ffmpeg on
crash, and a **janitor** purges segments older than `RETENTION_SECONDS=600`
(10-min rolling on-disk buffer). When presence triggers a clip, a per-camera
**`ClipWorker`** (bounded queue `maxsize=16`) concat-copies the covering
segments into one MP4, reads it whole into RAM, **Fernet-encrypts** it, and
writes it to `/clips`, then submits it to the clip pipeline.

**Resource behavior.** ✅✅ CPU low (stream-copy is a byte mux, not a transcode).
⚠️ The only non-trivial cost is **whole-file Fernet encryption** (~2.3× clip
size RAM spike during finalize). The dominant sustained cost is **continuous
segment disk-write bandwidth** (≈ Σ camera bitrates, 24/7).

**Current bottleneck.** Not CPU. It's **disk write bandwidth/IOPS**, the
**encryption RAM spike** under concurrent finalize, and a structural
**double RTSP pull per camera** (the reader decodes the stream *and* the
segmenter copies it — two independent pulls). *(Alternatives —
centralized finalize queue, shared recording service — in
`stage3-clip-recording.md`.)*

---

## Stage 4 — UC1 processing (`clip_pipeline/pipeline.py`, `person_clips/reprocess.py`)

**Current design.** On-demand / auto-submitted face-crop **extraction** over
saved clips using **the same global YOLO + InsightFace singletons** (mode
`yolo+face`, **`yolo_imgsz=960`**, recall-first). **One shared UC1 cropping
worker for the whole process** (`worker_count=1`), serialized on the same
`_detect_lock`. Per job: decrypt whole clip → temp mp4 → `cv2.VideoCapture`
sample ~2 fps (cap **200 frames**) → per frame YOLO@960 + InsightFace →
crop faces from full-res → JPEG → Fernet → INSERT `face_crops`
(`employee_id=NULL`, ≤30/clip) → hand frames to matching.

**Resource behavior.** ❌ Two big costs: **YOLO@960 detection** (lock-bound,
~2× a 640 pass) and the **full-res frame list in RAM** (up to 200 × ~6 MB ≈
**0.7–1.2 GB/job**, held until matching completes).

**Current bottleneck.** Single worker + global lock = throughput ceiling; at 21
cameras the bounded `StageQueue` (`max_depth=4096`) builds and overflow **drops
jobs**. Plus heavy duplicate work (below). *(Alternatives — multiprocess,
reuse-live-detections — in `stage4-uc1-processing.md`.)*

---

## Stage 5 — UC2 processing (`…/reprocess.py`, `identification/matcher.py`)

**Current design.** Identify over saved clips using **InsightFace only** (mode
`insightface`, **`det_size=640`**, quality-first + best-per-track). **One shared
UC2 cropping worker** + **one shared matching worker** (across all UCs), cropping
on the same `_detect_lock`. Probe embeddings are computed **fresh per clip**
inside the detection pass; matching reuses them and calls
`MatcherCache.match()`. The **`MatcherCache`** holds
`{tenant → {employee → (N,512) ndarray}}` in memory (Fernet-decrypted,
L2-normalized); per probe it does `stacked @ probe` (cosine), mean-of-top-k,
assign only if ≥ `match_threshold` (default **0.45, hard**).

**Resource behavior.** Cost = **InsightFace@640 detect+embed** (lock-bound). The
**matcher is negligible** — microsecond cosine math on a **~6 MB** cache that
scales with *enrollment* (employees × angles), **not cameras**.

**Current bottleneck.** UC2 cropping detection on the global lock, plus the
biggest duplicate in the system: **UC1 and UC2 each decode the same clip and run
InsightFace separately** — the expensive recognition pass runs **twice on
identical footage**. *(Alternatives — unify UC1+UC2 pass; do NOT adopt FAISS at
this scale — in `stage5-uc2-processing.md`.)*

---

## Stage 6 — Attendance / events (`attendance/scheduler.py`, `engine.py`)

**Current design.** Attendance is **decoupled from capture**. The **match step**
emits one `detection_events` row per matched `(clip, employee)`; **live capture
no longer writes events directly**. A **batch APScheduler job every 15 min**
(`MAUGOOD_ATTENDANCE_RECOMPUTE_MINUTES`) iterates tenants → active employees →
resolves each shift policy → runs the **pure `engine.compute()`**
(in/out/late/early-out/short-hours/overtime/absent) → `upsert_attendance`
(`ON CONFLICT`). The engine is pure (no DB/IO), deterministic, unit-tested.

**Resource behavior.** ✅✅ The cheapest stage — SQL aggregation + arithmetic,
once per 15 min. No models, no frames.

**Current bottleneck.** Essentially none, and **indifferent to camera count**
(scales with *employee count*). The only inefficiency: it recomputes **every
active employee every tick**, even unchanged ones. *(Alternatives — hybrid
event-driven + dirty-set sweep — in `stage6-attendance-events.md`.)*

---

## What actually runs on the box (thread / process census)

**Per camera (scales linearly):**

| Component | Count/camera | Kind |
|-----------|-------------|------|
| Reader thread (`capread-<id>`) | 1 | thread |
| Analyzer thread (`capana-<id>`) | 1 | thread |
| Segmenter ffmpeg (`-c copy`) | 1 | **process** |
| Segmenter watchdog + janitor | 2 | threads |
| ClipWorker (queue 16) | 1 | thread |
| **RTSP connections** | **2** | reader decode + segmenter copy |

**Shared once, process-wide (not per camera):**

| Component | Count | Notes |
|-----------|-------|-------|
| `_detect_lock` | 1 | global detection serialization |
| YOLOv8n + InsightFace buffalo_l | 1 each | module singletons, ~1 GB flat |
| UC1 / UC2 / (UC3) cropping workers | 1 each | shared across all cameras + tenants |
| Matching worker | 1 | cosine vs MatcherCache |
| Clip-pipeline StageQueues | bounded | `max_depth=4096`, overflow drops |
| MatcherCache | per tenant | ~6 MB, enrollment-sized |
| CaptureManager + reconcile scheduler | 1 | 2 s `BackgroundScheduler` diff loop |
| Attendance scheduler | 1 | 15-min batch job |

**At 21 cameras ≈ 21 ffmpeg processes + ~84 per-camera threads + 42 RTSP
connections**, funneling all detection through **one** lock and all clip
processing through **one** worker per UC. (25 cameras: ~25 ffmpeg + ~100 threads
+ 50 RTSP pulls.)

---

## Current-state resource summary

| Stage | CPU | Memory | Bottleneck today | Camera-count sensitive? |
|-------|-----|--------|------------------|-------------------------|
| 1 Live feed | ❌ High (always-on preview re-encode) | ⚠️ Med | preview encode starves reader → drops/lag | ✅ yes |
| 2 Detection | ❌ **Ceiling** (serial lock) | ✅ ~1 GB flat | one detection at a time, box-wide | ✅ yes (contention) |
| 3 Clip recording | ✅✅ Low (stream-copy) | ⚠️ encrypt spike | disk write BW + encrypt RAM + double RTSP pull | ✅ yes (disk/conn) |
| 4 UC1 | ❌ High (YOLO@960, lock) | ❌ frame list/job | single worker + lock; queue builds/drops | ✅ yes (clip volume) |
| 5 UC2 | ❌ High (InsightFace@640, lock) | ❌ frame list/job | duplicate decode+embed vs UC1 | ✅ yes (clip volume) |
| 6 Attendance | ✅✅ V.Low | ✅✅ Low | none (recomputes unchanged emps) | ❌ **no** (employee-scaled) |

**Where the CPU actually goes:** neural-net **detection** (Stages 2/4/5) and
the **always-on preview re-encode** (Stage 1). Clip saving (Stage 3, stream-copy)
and attendance (Stage 6) are cheap.

**The system's structural inefficiencies (all documented per-stage):**
1. **Duplicate detection** — live YOLO thrown away then re-run in UC1; UC1 and
   UC2 each decode the same clip and run InsightFace separately (the expensive
   pass runs 2–3× on identical footage). *The single biggest waste.*
2. **Always-on preview re-encode** regardless of viewers (Stage 1).
3. **Double RTSP pull per camera** (reader + segmenter) (Stage 3).
4. **Full-res frame lists in RAM** held through matching (Stages 4/5).
5. **Attendance recomputes unchanged employees** every tick (Stage 6).

**The two scaling paths (from the stage docs):** on CPU, **multiprocess,
camera-sharded detection** is the only way to genuinely use 24 vCPUs; the clean
end-state is a **centralized decode-once/detect-once service, GPU-ready**. No
CPU tuning removes the single-lock ceiling — it only softens it.

---

## Cross-references (per-stage alternatives & recommendations)

- Stage 1 — `docs/architecture/live-feed-options.md`
- Stage 2 — `docs/architecture/stage2-detection-models.md`
- Stage 3 — `docs/architecture/stage3-clip-recording.md`
- Stage 4 — `docs/architecture/stage4-uc1-processing.md`
- Stage 5 — `docs/architecture/stage5-uc2-processing.md`
- Stage 6 — `docs/architecture/stage6-attendance-events.md`
- Hardware sizing / GPU justification — `docs/hardware-sizing-25-cameras.md`,
  `docs/cpu-vs-gpu-clip-processing.md`
- Code: `backend/maugood/capture/{reader,analyzer,segmenter,clip_worker,manager}.py`,
  `backend/maugood/detection/detectors.py`,
  `backend/maugood/clip_pipeline/pipeline.py`,
  `backend/maugood/person_clips/reprocess.py`,
  `backend/maugood/attendance/{scheduler,engine,repository}.py`

---

*As-built against v1.1.25. Constants verified in code: `analyzer_max_fps=3.0`,
`det_size=320`, `force_detect_every_s=3.0`, `SEGMENT_SECONDS=10`,
`RETENTION_SECONDS=600`, ClipWorker queue `maxsize=16`, StageQueue
`max_depth=4096`, reconcile interval 2 s, attendance recompute 15 min. Detection
serialized process-wide by one global `_detect_lock`.*
