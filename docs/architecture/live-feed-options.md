# Live Feed / RTSP stage — architecture options & comparison

> Scope: **only the Live Capture / RTSP Reader stage** (RTSP in → smooth
> preview to the browser, and frames handed to detection). Analyzer,
> detection, clip saving, UC1/UC2 are out of scope here and covered
> separately. Written against the v1.1.x capture pipeline
> (`backend/maugood/capture/reader.py`, `live_capture/router.py`).
>
> Target deployment this doc reasons about: **one site, 21+ cameras,
> 24 vCPU / 16 GB, CPU-only (no GPU today)** — the Sangfor KVM box from
> the perf incident.

## The principle behind every option

"Live capture" hides **two different jobs with opposite requirements**:

| Job | fps | resolution | loss tolerance | latency |
| --- | --- | --- | --- | --- |
| (a) Smooth video for a **human** | native (15–30) | full | lossy OK | low |
| (b) Frames for the **AI** | 2–6 | downscale OK | must be the *right* frames | irrelevant |

Every serious VMS/NVR/analytics system **separates these two jobs.** The
architectures below differ mainly in *how* they separate them and *where
the decode happens*. The throughline of the recommendation:
**stop decoding-and-re-encoding for preview, and feed detection the
smallest sufficient stream.**

---

## 1. Current approach — Decode + MJPEG re-encode

```
RTSP ─▶ Reader thread ─▶ OpenCV/FFmpeg decode ─▶ 2× full-res JPEG encode ─▶ MJPEG ─▶ Browser
                              │
                              └─▶ latest-frame slot ─▶ Analyzer thread (detection)
```

**Why it was designed this way:** simplest thing that works with tools
already in the project. OpenCV is required for detection anyway, so the
decoded frame is reused "for free" for preview; no extra infrastructure
(no relay, no WebRTC). Reasonable for a few-camera pilot.

**Grounding (real code):** `reader.py::_update_preview` annotates and
encodes **two full-resolution JPEGs per native frame, unconditionally**
(no check for whether any viewer is connected), with **two full-frame
`.copy()`** each. At 21 cams × ~25 fps × 2 encodes ≈ ~1,000 JPEG
encodes/sec even with the Live page closed. Each `cv2.imencode` fans
across all cores (no `cv2.setNumThreads` cap).

| Dimension | Assessment |
| --- | --- |
| Thread model | 1 reader + 1 analyzer per camera (+ clip + segmenter helpers). |
| Worker model | Per-camera in-process threads; shared serialized detector (`_detect_lock`). |
| CPU | ❌ High. Full decode at native fps **plus** always-on 2× full-res re-encode/frame. |
| Memory | ⚠️ Moderate–high. 2 full-frame copies/frame + latest-frame + clip buffers per camera. |
| Scalability 21+ | ❌ Poor on CPU. Re-encode scales with cameras × native fps; saturates 24-vCPU box. |
| Frame drops | ❌ Preview encode competes with `cap.read()` budget; slow encode → dropped frames. |
| Detection accuracy | ✅ Unaffected (full-res frames); motion-skip is the only minor risk. |
| Complexity | ✅ Lowest — already built. |

**Pros:** simple; one decode; no extra services; works on isolated LAN.
**Cons:** does exactly what vendors never do (decode + re-encode);
preview cost is always-on; doesn't scale on CPU.

### Optimize WITHOUT changing the architecture (high value, low risk)

1. **Gate preview encode on active viewers** — idle cameras → zero
   preview CPU. Biggest single win. (Manager already tracks subscriber
   counts.)
2. **Throttle preview to ~10 fps + downscale (≤960px) + encode one slot
   unless the second is consumed** — cuts preview CPU several-fold.
3. **Cap native threads** (`cv2.setNumThreads(1)`, `OMP_NUM_THREADS=2`,
   `OPENBLAS_NUM_THREADS=2`) — kills the native-pool oversubscription
   (the "500 threads on 21 cameras" finding).
4. **Use the camera sub-stream** for preview/detection (see §3-D) — a
   config/URL change, not an architecture change, and a large win.
5. **Mid-stream read watchdog/timeout** — `cap.read()` is blocking with
   no mid-stream timeout today; a half-dead camera can wedge the reader.

These alone likely reach 21 cameras stably with no design change.

---

## 2. Split Preview (relay) + Detection (low-fps decode)

```
Preview:    RTSP ─▶ MediaMTX/go2rtc ─▶ WebRTC/HLS (stream-copy) ─▶ Browser GPU decodes
Detection:  RTSP ─▶ low-fps decode (FFmpeg/OpenCV @2–6fps) ─▶ YOLO ─▶ Tracker
```

Server **stops re-encoding for preview** — relays the camera's existing
H.264 untouched, browser GPU decodes it. Detection gets its own cheap
low-fps decode.

| Dimension | Assessment |
| --- | --- |
| Thread model | Preview handled by relay process (async I/O, ~1–2 threads/cam). Detection: 1 low-fps decode + analyzer per camera. |
| Worker model | Relay is a separate service; detection stays in the Python app. |
| CPU | ✅ Low. Preview ≈ byte-shuffling; detection decodes only 2–6 fps, downscaled. |
| Memory | ✅ Low–moderate. Relay buffers compressed bytes; detection holds few small frames. |
| Scalability 21+ | ✅ Strong. Preview scales to dozens; detection bounded by analyzer fps, not native fps. |
| Frame drops | ✅ Preview drops are client/network (graceful in WebRTC). Detection samples — never "drops". |
| Detection accuracy | ✅ Good at 2–6 fps for attendance; slight risk on very fast transits (mitigated by tracker + force-detect). |
| Complexity | ⚠️ Medium. Adds a relay service, WebRTC signaling, a 2nd RTSP pull/camera. |

**Pros:** vendor-grade smooth video; preview decoupled from detection;
sub-second latency (WebRTC); big CPU drop.
**Cons:** new moving part; WebRTC NAT/signaling; 2 RTSP connections/cam.

**Refinement:** pull the **sub-stream** for detection and the **main
stream** (stream-copy) for preview (§3-D). If face *recognition* needs
resolution, detect/track on the sub-stream but crop faces from the main
stream.

---

## 3. Other architectures used in large-scale VMS / NVR / analytics

### 3-A. WebRTC relay fan-out (Frigate / go2rtc / MediaMTX style)
Dedicated streaming server ingests RTSP once, fans out WebRTC/LL-HLS to
many viewers.

- Thread/Worker: relay process, async I/O core; ~constant threads
  regardless of viewer count.
- CPU/Mem: ✅ very low (stream-copy) / ✅ low (compressed buffers).
- Scalability: ✅✅ excellent (many cameras × many viewers).
- Frame drops: ✅ WebRTC degrades gracefully.
- Accuracy: n/a (preview only).
- Complexity: ⚠️ medium (run/monitor relay; signaling).
- +Best live experience, sub-second latency, one ingest/camera.
  −Extra service; WebRTC networking.

### 3-B. HLS / LL-HLS fan-out
Segmented HTTP files instead of WebRTC.

- CPU/Mem: ✅ low (stream-copy segments) / ✅ low.
- Scalability: ✅✅ excellent; proxy/CDN-cacheable; survives flaky nets.
- Frame drops: ✅ buffered — no drops, but **higher latency**
  (LL-HLS ~2–5 s, classic HLS ~10–30 s).
- Accuracy: n/a.
- Complexity: ✅ lower than WebRTC (plain HTTP, no signaling).
- +Simple, robust, endless scale. −Latency too high for "live
  monitoring" feel; fine for casual viewing.

### 3-C. GPU hardware decode + batched inference (NVIDIA DeepStream / GStreamer NVDEC)
Cameras' H.264 decoded on the **GPU (NVDEC)**, frames stay in GPU memory,
one model runs **batched** inference across all cameras.

- Thread/Worker: GStreamer pipeline/camera feeding a shared batched
  engine; few CPU threads.
- CPU/Mem: ✅✅ CPU near-idle (decode on GPU); ⚠️ GPU VRAM is the budget.
- Scalability: ✅✅✅ 30–100+ cameras on one GPU. The professional answer.
- Frame drops: ✅ pipeline back-pressure handles it.
- Accuracy: ✅✅ highest — full-res/full-fps feasible; batching doesn't
  reduce accuracy.
- Complexity: ❌ high — GPU hardware, CUDA/GStreamer/DeepStream stack.
- +Massive scale, frees CPU. −Needs a GPU (box has none today); steep
  stack.

### 3-D. Dual-stream / sub-stream (the single most important CCTV technique)
Almost every IP camera publishes **two RTSP streams at once**: a **main
stream** (e.g. 1080p/25fps, for recording) and a **sub-stream** (e.g.
640×480/low-fps, for live view + analytics). VMS shows the sub-stream in
live tiles + runs analytics on it, records the main stream.

- Thread/Worker: same per-camera model, but frames are ~10× smaller.
- CPU/Mem: ✅✅ decode + detect on 640×480 vs 1080p ≈ ~4–9× cheaper;
  ✅ small frames.
- Scalability: ✅✅ often the difference between 21 cameras fitting or not
  — on the *same* code.
- Frame drops: ✅ much smaller per-frame budget → reader keeps up.
- Accuracy: ⚠️ trade-off — lower-res faces harder to **recognize** at
  distance. Mitigation: detect/track on sub-stream, crop the face from
  the main stream; or sub-stream only where faces are close (entries).
- Complexity: ✅✅ lowest-effort big win — mostly a config/URL change +
  a main-stream pull for crops.
- +Huge cost cut, minimal code. −Recognition range drops unless faces
  are cropped from the main stream.

### 3-E. Shared decode / frame-server (zero-copy)
One decode per camera writes frames into **shared memory**; preview
encoder and detection both *read* the same buffer (no copies, no second
decode).

- Thread/Worker: one decoder/camera + consumers attach to a ring buffer.
- CPU/Mem: ✅ decode once; ✅ zero-copy avoids today's double `.copy()`.
- Scalability: ✅ good; removes duplicate work.
- Frame drops: ✅ slow consumers skip to latest.
- Accuracy: ✅ unaffected.
- Complexity: ⚠️ medium — shared-memory/ring-buffer plumbing + lifecycle.
- +Eliminates redundant decode/copy. −Still CPU-decoding; not
  vendor-grade preview by itself.

### 3-F. Microservice / message-bus decomposition (multi-host VMS)
Separate services — ingest/decode, inference, tracking, storage,
streaming — over a bus (Redis/Kafka/gRPC), each independently scalable
across hosts.

- Thread/Worker: pools of stateless workers/service; horizontal scale.
- CPU/Mem: scales out across machines.
- Scalability: ✅✅✅ hundreds–thousands of cameras across a cluster.
- Frame drops: ✅ queues + back-pressure.
- Accuracy: ✅ unaffected.
- Complexity: ❌❌ very high — distributed system + ops + multi-host.
- +Web-scale. −Massive complexity; wrong fit for one 21-camera site.

### 3-G. Edge / on-camera analytics (ONVIF metadata)
The **camera** does detection (many support on-board AI) and emits
ONVIF/metadata events; the server consumes events, not pixels.

- CPU/Mem: ✅✅✅ server barely works.
- Scalability: ✅✅✅ bounded by camera count only.
- Accuracy: ⚠️ tied to the camera's model; not your face-recognition.
- Complexity: ⚠️ medium, but **depends on the camera hardware** given.
- +Near-zero server cost. −You don't control the model; mixed-vendor
  fleets vary; face recognition still needs your server.

---

## Master comparison

| Architecture | CPU | Mem | Scale 21+ | Frame drops | Accuracy | Complexity |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Current (decode+MJPEG) | ❌ High | ⚠️ Med-Hi | ❌ Poor | ❌ Yes | ✅ Full | ✅ Built |
| 1+ Current, optimized | ⚠️ Med | ✅ Med | ⚠️ OK | ⚠️ Reduced | ✅ Full | ✅ Low |
| 2. Relay preview + low-fps detect | ✅ Low | ✅ Low | ✅ Strong | ✅ Graceful | ✅ Good | ⚠️ Med |
| 3-A. WebRTC relay | ✅ V.Low | ✅ Low | ✅✅ Excellent | ✅ Graceful | n/a | ⚠️ Med |
| 3-B. HLS/LL-HLS | ✅ Low | ✅ Low | ✅✅ Excellent | ✅ (latency) | n/a | ✅ Low-Med |
| 3-C. GPU NVDEC + batch | ✅✅ Idle | ⚠️ VRAM | ✅✅✅ Best | ✅ Clean | ✅✅ Highest | ❌ High |
| 3-D. Sub-stream | ✅✅ Low | ✅✅ Low | ✅✅ Strong | ✅ Easy | ⚠️ Range↓ | ✅✅ Lowest |
| 3-E. Shared decode | ✅ Low | ✅ Low | ✅ Good | ✅ Skip | ✅ Full | ⚠️ Med |
| 3-F. Microservices | scale-out | scale-out | ✅✅✅ | ✅ | ✅ | ❌❌ V.High |
| 3-G. Edge/on-camera | ✅✅✅ | ✅✅✅ | ✅✅✅ | ✅ | ⚠️ Camera | ⚠️ HW-dep |

---

## Recommendation for Maugood (one site, 21+ cameras, 24 vCPU / 16 GB, no GPU)

A **phased combination**, not a single jump:

**Phase 1 — optimize the current architecture (days, no new services).**
Viewer-gated + throttled + downscaled preview, native-thread caps,
mid-stream watchdog, **and switch detection (ideally preview too) to the
camera sub-stream (§3-D).** Highest value-per-effort; very likely makes
21 cameras stable on the existing CPU box with existing code.

**Phase 2 — split preview off the CPU (weeks).** Add **MediaMTX/go2rtc**,
serve the browser **WebRTC** (main stream, stream-copy); keep low-fps
sub-stream decode for detection (§2 / §3-A). Vendor-grade smooth video
while CPU stays free for detection. Best long-term fit for a single-site
CPU deployment.

**Phase 3 — only if camera count / accuracy demands grow.** Add a **GPU
(§3-C)** for batched full-res inference — the move when CPU detection is
outgrown, independent of the preview solution.

**Skip** microservices (§3-F) — wrong scale for one office. Treat edge
analytics (§3-G) as opportunistic (use ONVIF events *if* the deployed
cameras support them; don't depend on it for face recognition).

---

## Cross-references

- Capture worker/thread model & invariants: `backend/CLAUDE.md`
  ("Capture pipeline", "Live Capture viewer").
- Reader/analyzer split & motion-skip: `backend/maugood/capture/reader.py`,
  `analyzer.py`.
- Detector cost & the shared `_detect_lock`: `backend/maugood/detection/detectors.py`.
- Frame-drop / FPS / CPU diagnosis: the `maugood-frame-pipeline-debugging`
  skill and `capture-performance-optimization` skill.
