# Stage 5 — UC2 Processing: architecture (CPU-only)

> Scope: **model loading, embeddings, matcher cache, workers, duplicate work,
> and CPU-only scaling** for UC2 (identify) in the clip pipeline. Companion to
> `live-feed-options.md`, `stage2-detection-models.md`,
> `stage3-clip-recording.md`, `stage4-uc1-processing.md`. Grounded in
> `backend/maugood/clip_pipeline/pipeline.py`,
> `backend/maugood/person_clips/reprocess.py`,
> `backend/maugood/identification/matcher.py` (v1.1.x).
>
> Target box: one site, 21+ cameras, 24 vCPU / 16 GB, **CPU-only (no GPU)**.

```
Saved Clip → Decrypt → Frame Sampling → InsightFace Detection → Face Embedding
  → Face Matching → Save Results (best-per-track) → UC2 Output → Attendance fan-out
```

**Key insight:** UC2's *matching* is cheap — the expensive part is that UC2
runs InsightFace on the same clip frames UC1 just processed, computing face
embeddings a **second time**.

---

## Which models are loaded in UC2

**Only InsightFace — the same global singleton as Stage 2/UC1.** UC2 cropping
calls `_run_detection(mode="insightface")` → `detect()` → module-level
`_face_app` (buffalo_l, det + recognition) under the global `_detect_lock`.
**No YOLO in UC2** (insightface mode = SCRFD full-frame detection).

| Question | Answer |
| --- | --- |
| Models in UC2 | **InsightFace buffalo_l only** (SCRFD detection + recognition embedding). No YOLO. |
| Loaded once or per worker | **Once globally** — shared `_face_app`. |
| Detector config | `insightface`, **`det_size=640`**, `min_face 60²`, `min_det 0.45` (quality-first; composite scorer + best-per-track is the real gate). |
| Shared lock | Yes — UC2 cropping serializes on the **same global `_detect_lock`** as live, UC1, UC3. |

## Embeddings: generated per clip or reused?

**Generated per clip — during the UC2 cropping detection pass.** buffalo_l
loads recognition, so InsightFace `get()` returns `face.normed_embedding`;
`detect()` carries it as `det["embedding"]` in `frame_results`.

- **Probe embeddings (from the clip):** computed **fresh every clip** inside
  UC2's InsightFace detection.
- **`_match_detections` does NOT re-embed** — it reuses `det["embedding"]` and
  calls `matcher_cache.match(scope, probe)`. Matching is cheap vector math.
- **Enrolled employee embeddings:** the only *reused* vectors (MatcherCache).

## How face matching works

`MatcherCache` holds `{tenant_id → {employee_id → stacked (N,512) ndarray}}` in
memory, lazily loaded from enrolled `employee_photos` embeddings
(Fernet-decrypted, L2-normalized). Per probe:
- `sims = stacked @ probe` (dot = cosine, both L2-normalized),
- per-employee score = **mean of top-k** (k=1 → best angle wins),
- assign highest scorer **only if ≥ `match_threshold` (default 0.45, hard)**,
- per-employee / per-tenant **invalidation** on enrollment changes.

The cache **scales with enrollment (employees × angles), not cameras** — tiny:
1,000 employees × 3 angles × 512 × 4 B ≈ **~6 MB**.

## Duplicate work — yes, heavily

- **Duplicated from UC1:** UC1 (`yolo+face`) and UC2 (`insightface`) **both
  decrypt + decode the same clip and both run InsightFace** to produce
  embeddings — UC1 inside YOLO boxes, UC2 full-frame via SCRFD. **The
  recognition forward pass (the expensive part) runs twice on the same
  footage.**
- **Clips decoded multiple times:** yes — UC2 decodes the clip UC1 already
  decoded.

## CPU & memory per step

| Step | CPU | Memory |
| --- | --- | --- |
| Decrypt whole clip → RAM | ⚠️ AES on full file | ⚠️ clip size in RAM |
| Decode + sample (~2 fps, ≤200) | ⚠️ cv2 decode | ❌ **up to 200 × full-res frames** ≈ ~0.7–1.2 GB/job (1080p) |
| **InsightFace@640 detect + embed per frame** | ❌ **dominant cost**, lock-serialized | shared model RAM (0 extra) |
| Face matching (cosine vs cache) | ✅✅ microseconds | ✅ ~6 MB cache (enrollment-sized) |
| Best-per-track crop save → Fernet → INSERT | ✅ cheap | ✅ small |
| Attendance fan-out | ✅ cheap (SQL) | ✅ small |

Cost = **InsightFace@640 detection (CPU, lock-bound)** + **full-res frame
list (memory)**. Matching is negligible.

---

## With 21 cameras generating clips simultaneously

- **UC2 cropping** → one shared worker (`clip-pipeline-crop-uc2`), serialized on
  `_detect_lock` (shared with live + UC1 + UC3). **UC2 matching** → the single
  shared `clip-pipeline-match` worker (shared across all UCs).
- **Queue buildup: yes** at cropping (bounded `StageQueue`, `max_depth=4096`;
  overflow drops, logged). Matching queue rarely builds.
- **Shared globally:** InsightFace model, `_detect_lock`, UC2 cropping worker,
  the single matching worker, the MatcherCache.
- **Scales with clip volume:** decode CPU, InsightFace CPU, frame-list memory,
  crop storage, cropping-queue depth. (Matcher cache scales with *enrollment*.)
- **Bottlenecks:** (1) UC2 cropping detection on the global lock; (2) duplicate
  decode+embed vs UC1; (3) frame-list memory. **Matching is not a bottleneck.**

---

## Five approaches compared

### Approach 1 — Current Shared UC2 Worker
- Workflow: 1 cropping worker (detect+embed) → 1 shared matching worker →
  best-per-track save → attendance.
- Loading: shared global InsightFace.
- Worker/Thread: 1 cropping + 1 matching (shared across UCs); cropping on
  `_detect_lock`.
- CPU ❌ cropping ceiling / ✅ match cheap. Memory ✅ model+cache / ❌ frames.
- Scale 21+: ❌ cropping queue builds.
- +Simple; tiny matcher; accurate. −Detection ceiling; duplicate decode+embed
  vs UC1; frame memory.

### Approach 2 — Multiple UC2 Workers
- Workflow: N cropping threads + optionally N matching threads.
- Loading: one shared model under one lock.
- Worker/Thread: N threads, cropping serializes on `_detect_lock`.
- CPU ⚠️ little gain (cropping lock-bound; matching already cheap).
- Memory ⚠️ N× frame spikes.
- Scale 21+: ⚠️ marginal.
- +Trivial. −Futile vs lock; matching wasn't the bottleneck.

### Approach 3 — CPU Multiprocess UC2
- Workflow: N processes, each own InsightFace + lock, each a clip shard.
- Loading: N × buffalo_l.
- Worker/Thread: processes — true parallel detect+embed, no GIL/shared lock.
- CPU ✅✅ uses N cores. Memory ⚠️ N × ~0.5 GB + frame spikes (fits N=3–4).
- Scale 21+: ✅ best raw throughput.
- +Real parallelism; isolation. −N× memory; sharding/IPC; cache duplicated/proc.

### Approach 4 — Reuse UC1 Detection Results
- Workflow: UC1 + UC2 both run InsightFace on the same clip — **unify into one
  decode + one detect/embed pass**; UC2 becomes **match-only + best-per-track
  selection** on UC1's faces/embeddings.
- Loading: none extra.
- Worker/Thread: UC2 reduces to the cheap matching worker.
- CPU ✅✅ **eliminates UC2 decode + detection + embedding**. Memory ✅✅ no
  second frame list.
- Scale 21+: ✅✅ massive — UC2 stops being a detection consumer.
- +Removes the biggest duplicate (double InsightFace). −UC1 (yolo+face@960,
  min_face 30²) and UC2 (insightface@640, min_face 60²) differ in which faces
  they find; unifying needs one detection policy + UC2's quality gate applied
  to shared detections so neither UC regresses.

### Approach 5 — Vector Database / FAISS
- Workflow: replace in-memory cosine loop with FAISS/pgvector ANN for matching.
- Loading: unchanged (InsightFace still embeds).
- Worker/Thread: matching queries an index.
- CPU: matching is **already microseconds**; ANN helps only at **tens of
  thousands** of identities. Memory: index > current ~6 MB.
- Scale 21+: ✅ for *enrollment* scale, not camera scale.
- +Needed at 50k+ identities; persistence. −**Over-engineering for office
  attendance**; wrong lever for the 21-camera problem.

### Side-by-side

| | Loading | Workers | CPU | Memory | Scale 21+ | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Shared UC2 worker (current) | once | 1 crop + 1 match | ❌ crop ceiling / ✅ match | ✅ model+cache / ❌ frames | ❌ | correct base, capped |
| 2 Multiple UC2 workers | once | N threads | ⚠️ lock-bound | ⚠️ N× frames | ⚠️ | futile on CPU |
| 3 Multiprocess UC2 | N× | N procs | ✅✅ parallel | ⚠️ N× | ✅ | best raw throughput |
| 4 Reuse UC1 detections | none extra | match-only | ✅✅ no detect | ✅✅ no frames | ✅✅ | biggest win |
| 5 FAISS / vector DB | once | index | ✅ only at huge enrollment | ⚠️ index | ✅ enrollment-scale | over-engineering here |

---

## Best approach for CPU-only

1. **Now — unify UC1 + UC2 into one decode + one detect/embed pass
   (Approach 4).** The single biggest CPU win in the clip pipeline: a UC1+UC2
   clip pays **2 decrypts + 2 decodes + 2 InsightFace passes** today; unified it
   pays **1 + 1 + 1**, with UC1/UC2 differing only in crop-selection (UC1 = save
   all, UC2 = best-per-track) and UC2 adding the match step. Roughly **halves**
   clip-pipeline detection.
2. **Now — bound frame memory** (downscale/stream/cap), as in UC1.
3. **Medium — Approach 3 (multiprocess)** for true parallel detection once
   duplication is gone.
4. **Keep the in-memory matcher — do NOT adopt FAISS** at office scale; it's the
   wrong lever (matching isn't slow).

**Avoid Approach 2** — cropping is lock-bound, matching isn't the bottleneck.

## Unnecessary processing / duplicate work / optimization opportunities

1. **Double InsightFace embedding (UC1 + UC2)** — the recognition forward pass,
   the most expensive step, runs **twice on the same footage**. **Unify the
   detection/embedding pass.** (Biggest waste in the pipeline.)
2. **Duplicate decode** — UC2 decodes the clip UC1 already decoded. **Decode
   once, share frames.**
3. **Full-res frame list in RAM** (~0.7–1.2 GB/job), now ×UC. **Downscale /
   stream / cap.**
4. **Matching is already optimal for this scale** — cheap cosine + tiny cache.
   Don't FAISS it; invest accuracy in **crop resolution + enrollment quality**,
   tune `match_threshold` for the site.
5. **Single shared matching worker** is fine (microseconds); the **cropping**
   lock is the ceiling — escape via multiprocess (3) or a shared detection
   service.
6. **Whole-clip decrypt into RAM** — chunked decrypt would bound the spike.

**Net:** UC2's matcher (model loading + cache + cosine) is **already
well-designed and not the bottleneck**. The waste is the **duplicated decode +
InsightFace embedding shared with UC1**. Highest-impact CPU-only change:
**decode-once / detect-once / embed-once across UC1 + UC2** — pays off most here
because UC2 processes the exact clip UC1 just embedded.

---

## Cross-references

- Live feed / RTSP: `docs/architecture/live-feed-options.md`.
- Detection models + lock: `docs/architecture/stage2-detection-models.md`.
- Clip recording / saving: `docs/architecture/stage3-clip-recording.md`.
- UC1 processing: `docs/architecture/stage4-uc1-processing.md`.
- Matcher + cache: `backend/maugood/identification/matcher.py`.
- Match flow + crop helpers: `backend/maugood/person_clips/reprocess.py`.
- Face matching engine: `face-matching-engine` skill.
