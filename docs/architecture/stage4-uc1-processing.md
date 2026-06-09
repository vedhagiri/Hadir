# Stage 4 — UC1 Processing: architecture (CPU-only)

> Scope: **model loading, workers, decode/detect/crop flow, duplicate work,
> and CPU-only scaling** for UC1 (face extraction) in the clip pipeline.
> Companion to `live-feed-options.md`, `stage2-detection-models.md`,
> `stage3-clip-recording.md`. Grounded in
> `backend/maugood/clip_pipeline/pipeline.py` and
> `backend/maugood/person_clips/reprocess.py` (v1.1.x).
>
> Target box: one site, 21+ cameras, 24 vCPU / 16 GB, **CPU-only (no GPU)**.

```
Saved Clip → Decrypt → Frame Sampling (~2 fps, ≤200) → YOLO@960 Face Detection
  → Face Crop Extraction → Save Face Crops (employee_id=NULL) → UC1 Output
```

---

## Which models are loaded in UC1

**The same two global singletons as Stage 2 — not separate copies.** UC1's
cropping handler calls `_run_detection(mode="yolo+face")` →
`maugood.detection.detect()`, which uses the module-level `_yolo_model` +
`_face_app` under the module-level `_detect_lock`.

| Question | Answer |
| --- | --- |
| Models in UC1 | **YOLOv8n** (person) + **InsightFace buffalo_l** (face inside each box). |
| YOLO loaded once or per worker | **Once globally** — shared `_yolo_model`. Not per worker/camera. |
| Detector config | `yolo+face`, **`yolo_imgsz=960`**, face-pad 40, `min_face 30²`, `min_det 0.35` (recall-first — catches small/distant faces the live 480px path drops). |
| Shared lock | Yes — UC1 detection serializes on the **same global `_detect_lock`** as live, UC2, UC3. |

UC1 adds **zero model memory** (reuses globals) but **competes with live +
UC2 + UC3 for the one detection lock**.

## Workers: dedicated or shared?

**One shared UC1 cropping thread for the entire process** —
`clip-pipeline-crop-uc1`, `worker_count=1` (default), shared across **all
cameras and tenants**. Plus the single shared matching worker downstream.

## How a clip is read and processed (per UC1 job)

```
encrypted clip → decrypt whole file to RAM → temp .mp4
  → cv2.VideoCapture → sample ~2 fps (cap 200 frames) into a Python list
  → per frame: YOLO@960 person boxes → InsightFace face per box   [under _detect_lock]
  → crop face bbox (full-res) → JPEG → Fernet encrypt → write + INSERT face_crops (employee_id=NULL)
  → hand frames + detections to the matching stage
```

- **Frame sampling** (`_sample_frames`): keep every Nth frame where
  `N = native_fps / 2` (~**2 fps**), capped at **`_MAX_FRAMES_PER_CLIP = 200`**.
- **Face crop extraction:** YOLO finds person boxes (960), InsightFace finds
  the face inside, the face bbox is cropped from the **full-res** frame,
  JPEG-encoded, Fernet-encrypted, written.
- **Detection results stored:** `face_crops` rows (UC1 writes them **first with
  `employee_id=NULL`**, max 30/clip; matching backfills IDs) + a
  `clip_processing_results` row (status/timings).

## Duplicate decode / duplicate detection — both yes

- **Duplicated from Live:** live already ran YOLO person detection on this
  footage (480px, ~3 fps) and **discarded it**; UC1 **re-decodes the saved clip
  and re-runs YOLO+face at 960**. Second full detection pass over the same
  footage.
- **Same clip decoded multiple times:** UC1, UC2, UC3 each **independently
  decrypt + decode the same clip** and run their own detection. UC1+UC2 =
  **2 decrypts + 2 decodes + 2 detection passes** over identical frames.

## CPU & memory per step

| Step | CPU | Memory |
| --- | --- | --- |
| Decrypt whole clip → RAM | ⚠️ AES on full file | ⚠️ clip size + plaintext in RAM |
| Decode + sample (~2 fps, ≤200) | ⚠️ cv2 decode | ❌ **up to 200 × full-res frames in a list** — ~6.2 MB/frame at 1080p → **~0.7–1.2 GB/job** |
| **YOLO@960 + InsightFace per frame** | ❌ **dominant cost** (960 ≈ ~2× a 640 pass), lock-serialized | shared model RAM (0 extra) |
| Crop → JPEG → Fernet → write/INSERT | ✅ cheap | ✅ small |
| Hand frames to matching stage | — | ❌ **frames held until matching completes** |

Two big costs: **YOLO@960 detection (CPU, lock-bound)** and the **full-res
frame list (memory)**, held longer because it's passed to the matching stage.

---

## With 21 cameras generating clips simultaneously

- Workload funnels into **one shared UC1 worker**, serialized on `_detect_lock`
  (shared with live + UC2 + UC3).
- **Queue buildup: yes.** `StageQueue` bounded (`max_depth=4096`); arrival rate
  > UC1 throughput → queue grows; overflow **drops** jobs (logged).
  `skip_existing=True` prevents re-processing, not backlog.
- **Shared globally:** YOLO + InsightFace models, `_detect_lock`, the single
  UC1 worker, the matching worker.
- **Scales with clip volume:** decode CPU, detection CPU, **frame-list memory**,
  crop storage, queue depth.
- **Bottlenecks:** (1) single worker + global lock = ceiling (same as Stage 2);
  (2) YOLO@960 cost; (3) full-res frame memory under concurrent jobs.

---

## Five approaches compared

### Approach 1 — Current Shared UC1 Worker
- Workflow: 1 worker drains UC1 queue; decrypt→decode→detect@960→crop.
- Loading: shared global singletons.
- Worker/Thread: 1 thread, process-wide; serialized on `_detect_lock`.
- CPU ❌ one-at-a-time ceiling. Memory ✅ low model / ❌ frame spike per job.
- Scale 21+: ❌ queue builds.
- +Simple; minimal model RAM; per-UC visibility. −Throughput ceiling;
  backlog/drops; duplicate decode+detect.

### Approach 2 — Multiple UC1 Workers (raise `CROPPING_WORKERS`)
- Workflow: N UC1 threads drain the queue.
- Loading: still the **one shared model** under the **one lock**.
- Worker/Thread: N threads — all serialize on `_detect_lock`.
- CPU ⚠️ **little real gain** (lock forbids concurrent detection). Per-worker
  models would remove the lock but cause oversubscription + N× memory.
- Memory ⚠️ N× frame spikes.
- Scale 21+: ⚠️ marginal.
- +Trivial to set; overlaps decode/encode a little. −Mostly futile vs the lock
  on CPU; more memory.

### Approach 3 — CPU Multiprocess UC1
- Workflow: N processes, each owns a model + own lock, each drains a shard.
- Loading: N × full bundle.
- Worker/Thread: processes — **true parallel detection, no GIL, no shared lock.**
- CPU ✅✅ uses N cores. Memory ⚠️ N × ~0.8 GB + N× frame spikes (fits at
  N=3–4 on 16 GB).
- Scale 21+: ✅ best raw CPU throughput for UC1.
- +Real parallelism; isolation. −N× memory; sharding + IPC.

### Approach 4 — Reuse Live Detection Results
- Workflow: persist live's boxes/crops and feed them to UC1 instead of
  re-decoding + re-detecting the saved clip.
- Loading: none extra (live already paid).
- Worker/Thread: UC1 becomes mostly **crop-save + bookkeeping**.
- CPU ✅✅ **eliminates UC1 decode + detection**. Memory ✅✅ no frame
  materialization.
- Scale 21+: ✅✅ massive.
- +Removes duplicate decode + detection. −Live runs at 480px/~3 fps/body-first,
  so reused crops are sparser/lower-quality than UC1's recall-first 960 pass —
  accuracy/cost trade. Mitigation: use live timestamps to run a higher-res face
  pass **only on flagged frames**.

### Approach 5 — Centralized Detection Service
- Workflow: one shared detection service (CPU pool or GPU) that live, UC1, UC2
  all call; **decode-once, detect-once, fan results** to consumers.
- Loading: once in the service (or N replicas).
- Worker/Thread: service-managed pool; app sends frames/requests.
- CPU ✅ eliminates all cross-stage duplicate decode/detect; enables batching.
  Memory ✅ centralized.
- Scale 21+: ✅✅✅ clean end-state; GPU-ready.
- +Dedups live/UC1/UC2/UC3; central batching; GPU drop-in. −Biggest refactor;
  IPC + latency; new service to operate.

### Side-by-side

| | Loading | Workers | CPU | Memory | Scale 21+ | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Shared UC1 worker (current) | once | 1 thread | ❌ ceiling | ✅ model / ❌ frames | ❌ | correct base, capped |
| 2 Multiple UC1 workers | once | N threads | ⚠️ lock-bound | ⚠️ N× frames | ⚠️ | mostly futile on CPU |
| 3 Multiprocess UC1 | N× | N procs | ✅✅ parallel | ⚠️ N× | ✅ | best raw CPU throughput |
| 4 Reuse live detections | none extra | crop-save only | ✅✅ no detect | ✅✅ no frames | ✅✅ | biggest immediate win |
| 5 Centralized detection service | once (service) | pool | ✅ dedup+batch | ✅ | ✅✅✅ | best end-state |

---

## Best approach for CPU-only

1. **Now — decode-once + detect-once across UC1/UC2** (focused Approach 4/5).
   Decrypt + decode the clip **once** and run **one** detection pass shared by
   UC1 + UC2 (they differ in crop-selection, not in needing faces). Roughly
   **halves** clip-pipeline detection + decode + frame memory; no new infra.
2. **Now — bound frame memory.** Don't materialize 200 full-res frames;
   downscale for detection / process incrementally / stream. Removes the
   ~0.7–1.2 GB/job spike.
3. **Medium — Approach 3 (multiprocess UC1)** to use multiple cores once
   decode/detect is de-duplicated.
4. **Long — Approach 5 (centralized detection service)**, ideally GPU, as the
   clean end-state that dedups live + UC1 + UC2 + UC3.

**Avoid Approach 2** (more in-process UC1 workers) — they serialize on the same
lock, mostly futile on CPU, only adds memory.

## Unnecessary processing / duplicate work / optimization opportunities

1. **Duplicate decode across UCs** — UC1/UC2/UC3 each decrypt+decode the **same
   clip** separately. **Decode once, share frames.** (Biggest single waste.)
2. **Duplicate detection vs Live** — live already found persons; UC1 re-detects.
   **Reuse live boxes/timestamps**, or run the heavy pass only on flagged
   frames.
3. **Full-res frame list in RAM** (≤200 × ~6 MB ≈ up to ~1.2 GB/job), held
   until matching completes, ×per UC. **Downscale / stream / cap harder.**
4. **YOLO@960 recall-first is expensive** — tune `yolo_imgsz` down if recall
   allows, or reserve 960 for live-flagged distant persons.
5. **Single shared worker + global lock = ceiling** — escape via multiprocess
   (3) or a detection service (5).
6. **Whole-clip decrypt into RAM** — same spike as Stage-3 encryption, reversed;
   chunked decrypt would bound it.

**Net:** UC1 model loading is already optimal (shared singletons, zero extra
model RAM). The waste is entirely in **redundant decode + redundant detection**
(UC1 vs live, and UC1 vs UC2 on the same clip) and the **full-res frame-list
memory**. **Decode-once / detect-once across UC1+UC2** is the highest-impact
CPU-only change in this stage.

---

## Cross-references

- Live feed / RTSP: `docs/architecture/live-feed-options.md`.
- Detection models + lock: `docs/architecture/stage2-detection-models.md`.
- Clip recording / saving: `docs/architecture/stage3-clip-recording.md`.
- UC pipeline orchestrator: `backend/maugood/clip_pipeline/pipeline.py`.
- Crop/sample/detect helpers: `backend/maugood/person_clips/reprocess.py`.
- Face extraction + reprocess: `face-extraction-pipeline` skill.
