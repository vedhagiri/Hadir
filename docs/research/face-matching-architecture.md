# Face Matching Architecture — Real-time vs. Clip-based vs. Hybrid

> **Date:** 2026-05-11  
> **Context:** Evaluating face matching approaches for 25 cameras, ~3000 clips/day scale.

## 1. Approaches

### A. Real-time only
Match faces directly from the live camera stream as frames arrive.

```
Camera → Detector → Matcher → Attendance (immediate)
```

### B. Clip-based only
Save short video clips on motion/detection, then run face matching asynchronously in a background worker.

```
Camera → Clip storage → [async] Detector → Matcher → Attendance (delayed)
```

### C. Hybrid (Maugood current)
Run lightweight real-time matching for low-latency attendance while also saving clips with metadata for evidence, reprocessing, and audit.

```
Camera → Detector → Matcher → Attendance (immediate)
       ↘ Clip storage (with match metadata) → [async] Reprocessing (optional)
```

---

## 2. Comparison

| Dimension | Real-time only | Clip-based only | Hybrid |
|---|---|---|---|
| **Latency** | Immediate — attendance computed in seconds | Minutes delayed — must wait for clip finalisation + async processing | Immediate for attendance; clips are evidence only |
| **CPU/GPU** | Sustained continuous load per camera | Burst load during batch processing — can schedule off-peak | Sustained but bounded by motion-skip (quiet cameras = near-zero) |
| **Accuracy** | Fixed to current model version — model upgrade requires a re-run path anyway | Can re-run with newer/better models without losing original data | Best of both — real-time for ops, re-runnable for accuracy upgrades |
| **Storage** | Detection events only (small) | Full video clips (large — see §3) | Events + clips — moderate |
| **Stability under load** | Frame drops when detection backs up — no backpressure mechanism | Queues naturally — slow processing delays results but never drops data | Motion-skip + skip-to-latest frame prevents backlog |
| **Scalability (25 cameras)** | Serial `_detect_lock` becomes bottleneck (§5) | Can scale workers horizontally | Same bottleneck on real-time path, but async path scales independently |
| **Audit / Evidence** | No visual evidence — only DB rows | Full video clips + face crops as court-of-record | Full evidence trail |
| **Operational complexity** | Simple pipeline | Needs clip lifecycle management (finalise, clean up) | More moving parts but each is well-bounded |

---

## 3. Storage at scale (25 cameras)

Assumptions: 50 clips/hr/camera, average clip ~500 KB (H.264, 10–15 s at low res), 12 hr/day active.

```
Per hour:  25 cameras × 50 clips × 500 KB = 625 MB/hr
Per day:   625 MB/hr × 12 hr = 7.5 GB/day
Per month: 7.5 GB × 30 = 225 GB/month
```

With retention cleanup (30-day default, already implemented in Maugood P25), steady-state storage is ~225 GB — comfortably within a single NVMe drive. Clip storage is not a concern at this scale.

---

## 4. The `_detect_lock` bottleneck (real-time path)

InsightFace `buffalo_l` on CPU:

| Det size | CPU (single core) | GPU (CUDA) |
|---|---|---|
| 320 | ~80 ms | ~2–5 ms |
| 640 | ~200 ms | ~5–10 ms |

With a module-level serialising lock, 25 active cameras share one inference slot:

| Cameras | Per-cycle time | Effective fps per camera |
|---|---|---|
| 5 | 400 ms | 2.5 fps |
| 10 | 800 ms | 1.25 fps |
| 25 | 2000 ms | 0.5 fps |

For attendance purposes, 0.5 fps is sufficient — a person walking past a camera is visible for 2–5 seconds, giving 1–2 detection opportunities. **But continuous tracking degrades.**

**Fix:** Move inference to GPU (ONNX Runtime + CUDA). 5 ms per inference → 25 cameras cycle in 125 ms → ~8 fps per camera. No bottleneck.

---

## 5. Recommendation: Hybrid (current architecture)

**Keep the hybrid. Do not drop either side.**

### Why:

1. **Real-time matching is required for attendance.** Attendance needs to be available within seconds (APIs, dashboard), not minutes later. Clip-only would make the attendance page stale.

2. **Clips are required for evidence.** Compliance (especially PDPL/right-to-erasure) demands visual proof. Real-time matching leaves no trace of what was actually seen.

3. **Clips enable model upgrades.** When a better face model ships, you can re-process all saved clips without deploying new cameras. The `reprocess-face-match` endpoint already exists.

4. **Clips are the audit trail.** A matched `detection_events` row points at a Fernet-encrypted face crop. Without clips, there is no way to verify a match was correct.

### Recommended optimisations for 25 cameras:

| Optimisation | Impact |
|---|---|
| **GPU inference** (ONNX Runtime + CUDA) | `_detect_lock` serial → no bottleneck; ~100× per-inference speedup |
| **Motion-skip** (already shipped P28.5a) | Quiet cameras burn zero detection cycles |
| **Separate reprocess worker pool** | Live detection never competes with bulk reprocessing |
| **Skip-to-latest frame** (already shipped P28.5a) | Slow analyzer never backlogs frames |
| **30-day clip retention** (already shipped P25) | Storage capped at ~225 GB steady-state |

---

## 6. Decision

| Layer | Approach | Status |
|---|---|---|
| Real-time matching | **Keep** — low-latency attendance | Shipped |
| Clip saving | **Keep** — evidence + reprocessing | Shipped |
| GPU inference | **Add** — unlocks 25 camera scale | Not yet done |
| Motion-skip | **Keep** — CPU efficiency | Shipped (P28.5a) |
| Reprocess worker | **Keep** — model upgrade path | Shipped |
| Retention cleanup | **Keep** — storage bound | Shipped (P25) |
