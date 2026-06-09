# Stage 2 — Analyzer / Detection / Tracking: model architecture (CPU-only)

> Scope: **model loading, sharing, the detection lock, and CPU-only
> scaling** for the Analyzer/Detection/Tracking stage. Companion to
> `docs/architecture/live-feed-options.md`. Grounded in
> `backend/maugood/detection/detectors.py` and
> `backend/maugood/capture/analyzer.py` (v1.1.x).
>
> Target box: one site, 21+ cameras, 24 vCPU / 16 GB, **CPU-only (no GPU)**.

```
Frame (latest slot)
 ↓
Motion Detection      (downscale 160px gray, abs-diff, threshold 25 — ~3 ms)
 ↓
YOLO Detection        (person boxes; or YOLO+InsightFace face pass)
 ↓
Person Tracking       (pure IoU tracker — no model)
 ↓
Person-Present Decision (hysteresis → drives clip trigger)
```

---

## What models exist and how they're shared

In `detectors.py` the models are **module-level globals — one set for the
entire backend process**:

```python
_detect_lock       = TimedLock()   # line 153 — global serialization lock
_face_app          = None          # line 155 — InsightFace buffalo_l (lazy, once)
_face_app_det_size = None          # line 156 — current det_size of the shared instance
_yolo_model        = None          # line 157 — Ultralytics YOLOv8n (lazy, once)
```

- `_load_face_app()` / `_load_yolo()` lazily populate those globals **once**,
  guarded by `_detect_lock`. Re-`prepare()` only fires if `det_size` changed.
- The per-camera **`InsightFaceAnalyzer`** (`analyzer.py`) holds **no model** —
  only a `DetectorConfig` + a small config lock. Every detect call delegates
  to the module-level functions, which use the shared globals under the lock.

| Question | Answer |
| --- | --- |
| Models loaded here | **YOLOv8n** (person) + **InsightFace buffalo_l** bundle (det + recognition + landmark + gender/age). Tracker = **pure math, no model.** |
| Loaded once or per camera | **Once globally** (module-level singletons). |
| Instances with 21 cameras | **One** YOLO + **one** InsightFace bundle. Not 21. |
| Per-camera instance? | **No.** Per-camera `Analyzer` is a thin config-holder calling shared globals. |
| How sharing works | All analyzer threads import the same module → same global `_face_app` / `_yolo_model`. |
| Thread-safe access | Via **`_detect_lock`** — every `detect*` call wraps the model call in `with _detect_lock:`. |
| Global detection lock & why | **Yes** (`TimedLock`, also records held-time for contention metrics). Detection is CPU-bound and each inference already fans across cores via intra-op threads; running two concurrently **thrashes L1/L2 cache + oversubscribes**, making both slower. Serial-with-full-cores beats parallel-fighting-for-cores. |
| Multi-camera coordination | First-come-first-served on the lock; busy cameras wait behind others. |
| Sequential or parallel | **Sequential** — exactly one detection at any instant, process-wide. |

## CPU & memory impact (current)

- **Memory:** ~**0.7–1.0 GB total, flat regardless of camera count** (one
  buffalo_l bundle + one YOLO/torch incl. onnxruntime arenas). Adding cameras
  adds only small per-frame buffers. ✅ biggest strength of the design.
- **CPU:** the ceiling. One detection at a time × ~80 ms (InsightFace) /
  ~150 ms (YOLO+face) at det_size 320 → ~**12 / ~7 detections per second
  total, shared across all 21 cameras.** Motion-skip keeps idle cameras out
  of contention, but active cameras are capped at one core's serial
  throughput even on 24 vCPU (GIL + lock).

---

## Four approaches compared

### Approach 1 — Shared Global Model Instance (current)
- **Workflow:** every camera's analyzer thread → `_detect_lock` → the one
  shared model → release.
- **Loading:** once, lazily, into module globals.
- **Threads:** 21 analyzers, 1 detector, serialized by the lock.
- **CPU:** one detection at a time; each can use intra-op threads. Ceiling ≈
  one core's serial throughput.
- **Memory:** ✅✅ ~1 GB flat for any camera count.
- **Scale 21+:** ❌ throughput flat; latency grows under contention.
- **Pros:** tiny memory; trivially correct; no IPC; cache-friendly.
- **Cons:** can't use multiple cores for detection; unfair under load;
  det_size re-prep churn between callers.

### Approach 2 — One Model Per Camera
- **Workflow:** each camera owns its own YOLO + InsightFace.
- **Loading:** 21 × full bundle at startup.
- **Threads:** 21 analyzers, 21 models, no shared lock.
- **CPU:** theoretical parallelism (onnxruntime releases the GIL) but 21
  concurrent inferences each wanting all cores → catastrophic oversubscription.
- **Memory:** ❌❌ 21 × ~0.8 GB ≈ **12–18 GB** — won't fit 16 GB; swaps/dies.
- **Scale 21+:** ❌ worst option.
- **Pros:** conceptually simple; no lock.
- **Cons:** memory explosion; cache thrash. **Do not do this.**

### Approach 3 — Shared Detection Worker Pool
- **Workflow:** analyzers enqueue "latest frame for camera X"; a small pool of
  **N detection workers** pulls and runs inference.
- **Loading:** either (a) **share one model** across the pool (memory = 1 set
  but back to serial), or (b) **one model per worker** (memory = N sets, real
  concurrency — each worker its own onnxruntime session).
- **Threads:** N worker threads (e.g. 3–4), fair bounded queue.
- **CPU:** variant (b) + **capped intra-op threads per worker** (e.g. 4 × ~6
  threads) often beats 1 × 24 threads — small models don't scale to 24
  intra-op threads.
- **Memory:** ⚠️ N × ~0.8 GB ≈ 2.5–3.5 GB (variant b). Fits.
- **Scale 21+:** ✅ fairer scheduling + better core use; bounded.
- **Pros:** fairness; tunable; bounded queue; better utilization than current.
- **Cons:** still one process; N× memory (variant b); more code.

### Approach 4 — Multiple Detection Processes (CPU-only), camera-sharded
- **Workflow:** M processes, each owning a disjoint subset of cameras
  end-to-end (e.g. 4 × ~5 cams), each with its own model + own `_detect_lock`.
- **Loading:** M × full bundle, once per process.
- **Threads:** within a process = Approach 1 for its ~5 cams; across processes
  = **true parallelism, no GIL, no shared lock.**
- **CPU:** ✅✅ genuinely uses M cores in parallel — the honest way to use 24
  vCPU for detection.
- **Memory:** ⚠️ M × ~0.8 GB ≈ 3–4 GB (M=4). Fits.
- **Scale 21+:** ✅✅ best CPU-only option; near-linear up to core/RAM limits.
- **Pros:** real multi-core detection; process isolation; simplest true
  parallelism on CPU.
- **Cons:** M× model memory; needs sharding + supervisor; cross-process
  aggregation for dashboards.

### Side-by-side

| | Loading | Threads | CPU | Memory (21 cams) | Scale 21+ | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Shared global (current) | once | 21 + 1 lock | serial, 1-core ceiling | ✅ ~1 GB flat | ❌ | correct, but capped |
| 2 Per camera | 21× | 21, no lock | oversubscribed | ❌ 12–18 GB | ❌ | never |
| 3 Worker pool | 1 or N× | N pool | ✅ better utilization | ⚠️ 2.5–3.5 GB | ✅ | good single-process step |
| 4 Multi-process | M× | M procs | ✅✅ true parallel | ⚠️ 3–4 GB | ✅✅ | best for CPU |

---

## Best approach for CPU-only

**Approach 4 (multiple detection processes, camera-sharded)** is the correct
CPU-only scaler — the only one that genuinely uses the 24 vCPUs for detection
while keeping memory affordable (~3–4 GB for 4 processes). **Approach 3
(worker pool, capped intra-op threads)** is the lighter single-process
stepping stone that improves fairness + core utilization without multi-process
plumbing.

Keep **Approach 1's sharing model *inside* each process** — the right end
state is "M processes, each sharing one model across its ~5 cameras":
flat per-process memory + real cross-process parallelism.

## Optimizations WITHOUT changing the architecture (apply today)

1. **Cap intra-op threads** — `OMP_NUM_THREADS` / onnxruntime
   `SessionOptions(intra_op_num_threads=2–4)` + `cv2.setNumThreads(1)`.
   Stops the one locked detection (and 21 cv2 calls) each grabbing 24 cores.
   Biggest immediate CPU win.
2. **Trim the InsightFace bundle** — load with
   `allowed_modules=['detection','recognition']` (drop landmark + gender/age)
   → less RAM, faster prepare.
3. **Sub-stream / smaller `det_size`** — 4–9× cheaper per detection → far more
   cameras fit under the serial lock.
4. **Per-camera motion/fps tuning** — quiet cameras at lower analyzer fps +
   higher motion threshold.
5. **Pin one system-wide `det_size`** to stop re-prep churn.

---

## Unnecessary loads / duplicate processing / reuse opportunities

The model *loading* is already optimal (shared singletons). The waste is in
**duplicate detection work across Live → UC1 → UC2** and **bundle/det_size
overhead**:

1. **Live detection is thrown away, then re-done in UC1.** Live runs YOLO
   person detection at ~3 fps but no longer emits events/crops — and UC1
   **re-decodes the saved clip and re-runs YOLO+face from scratch.** The live
   boxes are discarded. **Opportunity:** persist live detections (timestamps +
   boxes) and feed them forward so UC1 doesn't re-detect bodies.
2. **UC1 and UC2 each decode the same clip and each run a detection pass.**
   UC1 (`yolo+face`) and UC2 (`insightface`) process the **same saved clip
   independently** — two decodes + two detection passes over identical frames.
   **Opportunity:** decode once + one detection pass, share frames +
   detections between UC1/UC2. **Largest duplicate-processing finding** —
   fixing it roughly halves clip-pipeline detection cost.
3. **det_size / mode re-prep churn on the shared `_face_app`.** Live + UC1 +
   UC2 share the one global InsightFace instance but may want different
   det_size/mode → repeated `prepare()` under the lock. **Opportunity:** pin
   det_size, or (Approach 4) give the UC pipeline its own detector separate
   from live.
4. **Full buffalo_l loaded though live is body-only by default.** Recognition/
   landmark/gender models sit resident but unused by live detection.
   **Opportunity:** the `allowed_modules` trim (#2 above).
5. **YOLO is loaded once and reused — good, no duplication.**

**Net:** loading is optimal; reclaim CPU by (a) capping native threads,
(b) de-duplicating UC1/UC2 decode+detect, and (c) feeding live detections
forward instead of re-detecting saved clips.

---

## Cross-references

- Live feed / RTSP options: `docs/architecture/live-feed-options.md`.
- Detector code + lock: `backend/maugood/detection/detectors.py`.
- Per-camera analyzer: `backend/maugood/capture/analyzer.py`.
- Tracker: `backend/maugood/capture/tracker.py`.
- Capacity sizing + lock contention: `multi-camera-capacity-planning` skill.
- Tuning levers: `capture-performance-optimization` skill.
