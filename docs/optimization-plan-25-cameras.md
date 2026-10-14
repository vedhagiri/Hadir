# Optimization plan: 25-camera client deployment

*Discussion document, 12 Oct 2026. Based on the current code (see
`docs/clip-pipeline-workflow.md`) and measurements from the 21-camera client. Nothing in
this plan is implemented yet. All performance figures marked "estimate" must be confirmed by
benchmarking (on the dev RTX 5050 first).*

## 1. Root cause: why clips pile up

From the code (`capture/reader.py`, `capture/clip_worker.py`, `clip_pipeline/`):

1. **Clips are tied to presence, not to events.** Recording starts when a person is in view
   and continues while the tracker sees them, cut into a new clip every **180 s**
   (`chunk_duration_sec`). Someone sitting at a desk for 8 hours makes **~160 clips a day**
   from one camera.
2. **Every clip is processed twice.** Each clip is auto-submitted to **both UC1 and UC2**.
   UC1 took **~7 min per clip** on the client's CPU-only VM.
3. **Processing is single-lane.** There is one global detection lock, one cropping worker and
   one matching worker. A camera makes a clip every 3 min while the server needs minutes per
   clip, so at 25 cameras the queue only grows (it caps at 64 jobs, then drops or fails).
4. **Camera attendance depends entirely on the clips.** The live analyzer detects and tracks
   faces, but it **no longer writes `detection_events`**: `capture/events.py::emit_detection_event`
   still exists, but nothing calls it. The only camera writer of attendance sightings is the clip
   pipeline (`person_clips/reprocess.py::_emit_attendance_detection_events`, one "in" + one "out"
   row per matched employee per clip). Verified on dev: all 748 camera sightings in the last
   30 days came from clip processing. **So `logs_only` today = no camera attendance** (only
   attendance terminals would still record).

**The fix is not "process clips faster".** Move face recognition for attendance back onto the
**live stream** (re-enable live matching and write `detection_events` from the analyzer, once
per track) and treat recordings as **short evidence for real events**.

## 2. Answers to the questions

### Q1. Alternative to continuous clip recording
Process the RTSP stream live and record only events:
- **Live analysis does identification and attendance.** This needs work: the analyzer already
  detects, tracks and can match (`matcher_cache`), but the step that writes `detection_events`
  from the live stream is switched off. It must be re-enabled, once per track, before clips can
  be turned off.
- **Recording is evidence only.** A short clip around an event, made by stream copy (no
  re-encoding), not re-analysed by default.
- **The clip pipeline (UC1/UC2) becomes on-demand.** It runs for unknown faces, disputes, or
  when an admin asks; it does not run on every clip.

### Q2. Intelligent event detection (skip stationary people)
Each person track gets a small state machine:

| Event | Rule | Clip? |
|---|---|---|
| **Enter** | New track appears (first sighting) | Yes (pre + post buffer) |
| **Identified** | Face matched to an employee | No new clip; the result is attached to the Enter event |
| **Dwelling / stationary** | Track box barely moves (low IoU change and low motion in its area) for > N s | **No clip**, only a "still present" heartbeat |
| **Exit** | Track lost for > timeout (e.g. 30–60 s) | Optional short clip, or a log entry only |
| **Re-entry cooldown** | Same employee seen again within X min (e.g. 10) | No new clip |
| **Activity events** (phone, posture) | **New scope, not in the product today** | Yes, if enabled |

Activity detection, if wanted, can reuse what's already loaded:
- **Phone use:** YOLO already detects persons, and the same COCO model has a "cell phone"
  class. Flag "phone near a person's hands or face for more than 3 s".
- **Posture:** a pose model (e.g. YOLOv8n-pose) gives standing, sitting or lying from the
  keypoints.

Run these only on frames that already contain a person, at 1–2 fps. They need a pilot and
tuning per site. Monitoring workplace activity has privacy (PDPL) implications that the
client must approve.

### Q3. Preventing queue backlogs
- **Event-driven, not clip-driven.** The live path makes small event messages (track id,
  camera, time, best face crop) and attendance uses them directly. No video sits in a queue.
- **Smart frame sampling:**
  - analyse at 2–5 fps
  - skip frames when nothing moves (motion-skip exists, but the UC1 threshold of 5.0
    currently misses faces and needs tuning)
  - recognise once per track, plus a re-check when the face quality improves
- **Bounded queues with clear rules:**
  - "latest frame wins" for live frames (already in place)
  - identification takes priority over analytics
  - duplicate jobs are merged (one job per track, not per clip)
- **Heavy pipeline only on demand.** UC1/UC2 runs only for unknown faces or by request, so
  normal activity can never create a backlog.

The in-process queues are fine on one server. Move to Redis Streams only if the system is
split across processes or servers.

### Q4. Storage: event clips with pre- and post-event time
Use a **ring buffer**:
1. ffmpeg records each camera's **main stream by stream copy** (no re-encoding, near-zero CPU)
   into rolling 2-second segments in a small buffer folder, keeping only the last ~10–20 s.
2. When an event starts, keep the buffered segments (the **pre-event** time, e.g. 5 s) and
   continue for the **post-event** time (e.g. 10 s, extended while the event lasts, capped at
   e.g. 60 s).
3. Join the segments into one MP4 (stream copy), encrypt it and store it. Old buffer
   segments are deleted automatically.

Per-camera settings: `pre_event_sec`, `post_event_sec`, `max_clip_sec`, the cooldown, and which
events record.

Storage estimate at ~2 Mbps per camera, 25 cameras:

| Mode | Per day | 30 days |
|---|---|---|
| Continuous recording | ~540 GB | ~16 TB |
| Today (presence-based, mostly continuous in offices) | close to continuous | — |
| Event clips (~5–10% of the time) | ~27–55 GB | ~0.8–1.6 TB |
| Logs + face crops only | < 2 GB | < 60 GB |

Also: auto-delete clip videos after N days (the flag exists), with separate retention for
"evidence" and "routine" clips.

### Q5. CPU and RAM for ~25 streams
In order of impact:
1. **Analyse the camera's sub-stream** (e.g. 640×360 or 704×576 at 5–10 fps), not the 1080p
   main stream. Software decoding 25 × 1080p H.264 costs ~8–12 CPU cores by itself (estimate);
   sub-streams cut that by ~4–6×. Use the main stream only for stream-copy recording.
2. **Pull each stream once.** Today detection uses OpenCV and the recorder runs a separate
   ffmpeg, so each camera is pulled twice.
3. **Lower analysis rate with motion gating:** 2–5 fps, skipping only unchanged frames.
4. **Recognise each track once, not each frame:** one recognition, plus one more when the face
   improves.
5. **Smaller detection size:** 320–480 for close entrance cameras, 640 only for wide ones.
6. **Thread caps:** already added (`MAUGOOD_INFERENCE_THREADS=2`).
7. **Never hold decoded frames in queues.** Pass crops and IDs only; an earlier memory leak came
   from holding whole clip frames.
8. **Encode previews only when someone watches** (fixed on a branch; needs confirming in the
   current build).

### Q6. Is a GPU mandatory?
**Not for attendance-only at a low frame rate on a modern CPU, but strongly recommended for
25 cameras.** For activity detection (phone, posture) it is effectively required.

| | CPU only (modern 16-core) | GPU (RTX 4060-class) |
|---|---|---|
| Face detection (640) | ~40–100 ms per frame per core (estimate) | ~3–6 ms (estimate; less per frame with batching) |
| Whole-system analysis budget | ~25 cams × 1–2 fps, busy CPU | 25 cams × 5–10 fps, CPU mostly free |
| Video decoding | CPU (heavy unless sub-streams) | NVDEC hardware decoder (near-zero CPU) |
| Activity models (pose, phone) | Not practical at 25 cameras | Comfortable |
| Behaviour under load | Lag and missed faces when busy | Stable, with headroom |

**Measured:** on the client's 24-vCPU Haswell VM (no GPU), UC1 took **~7 s per analysed
frame**.

**Which GPU and how much VRAM:**
- **Model memory is small.** InsightFace buffalo_l is ~0.3 GB and YOLOv8n is tiny; with ONNX
  Runtime CUDA or TensorRT the working set is ~1.5–3 GB including buffers (estimate). **8 GB
  is enough** for 25 cameras; 12–16 GB leaves room for pose/phone models and larger batches.
- **Good options:**
  - **Desktop / workstation:** NVIDIA RTX 4060 / 4060 Ti 16 GB (or the RTX 5060 class),
    RTX A2000 12 GB, or RTX 2000 Ada 16 GB (low power, small form factor).
  - **Rack server / datacenter:** NVIDIA **L4 24 GB** (72 W, NVDEC for many streams, built
    for video AI).
- **Virtual servers:** the client runs a **virtual machine (Sangfor KVM)**. A GPU only works
  there with **GPU passthrough or vGPU** set up by their IT team. Confirm this early.
- **Driver note:** the dev RTX 5050 is the newest generation (Blackwell) and needs CUDA
  12.8+ with a matching `onnxruntime-gpu` build. Check this during the benchmark.

### Q7. Recommended architecture (25 cameras)

```
Camera (main + sub stream)
 ├─ main stream ──► Recorder (ffmpeg stream copy → 2 s ring buffer) ──► Event clip (pre+post) ──► encrypted storage
 └─ sub stream ───► Ingest (one pull per camera, NVDEC/CPU decode, 5 fps, latest-frame-wins)
                       └─► Motion gate (skip unchanged frames)
                             └─► Inference service (ONE process owns GPU/CPU models, batches frames from all cameras)
                                   person detect → face detect → recognise (once per track)
                                   [optional] pose / phone
                                   └─► Tracker + event state machine (enter / identified / dwell / exit / activity, cooldowns)
                                         ├─► detection_events → attendance engine (existing)
                                         ├─► "start/stop clip" signal → Recorder
                                         └─► unknown faces / disputes → on-demand UC1/UC2 queue (bounded, low priority)
Storage: NVMe (OS + Postgres + face crops) + HDD/RAID (event clips), retention + auto-delete
Monitoring: Pipeline Monitor + Prometheus (fps per camera, queue depth, GPU %, disk)
```

**Already exists:**
- reader/analyzer threads, motion-skip and the IoU tracker
- the live → `detection_events` writer (`emit_detection_event`), present but not called today
- detection events → attendance
- stream-copy recording and `logs_only` mode
- the UC1/UC2 pipeline and the auto-delete flag

**New:**
- re-enabling live matching → `detection_events` (once per track)
- the event state machine and cooldowns
- the ring-buffer recorder
- a shared batched inference service with GPU support and CPU fallback
- sub-stream analysis
- making the clip pipeline on-demand

### Q8. Server specifications (25 cameras)

| | **Minimum (CPU only, attendance only)** | **Recommended** | **Ideal (activity detection, growth to ~40 cams)** |
|---|---|---|---|
| CPU | 16 modern cores (recent Xeon/EPYC/Ryzen, AVX2; **not** old Haswell) | 16 cores | 24–32 cores |
| RAM | 32 GB | 32–64 GB | 64 GB |
| GPU | none (sub-streams, ≤ 2 fps, attendance only) | RTX 4060 Ti 16 GB / RTX A2000 12 GB / RTX 2000 Ada 16 GB | NVIDIA L4 24 GB (or 2× mid GPUs) |
| VRAM | — | 8–16 GB | 16–24 GB |
| Storage | 1 TB NVMe + 2 TB HDD | 1 TB NVMe + 4 TB HDD (RAID 1) | 2 TB NVMe + 8–16 TB RAID |
| Network | 1 GbE, cameras on their own VLAN | 1 GbE | 10 GbE |
| Notes | Expect delays at peak; no activity detection | Comfortable for 25 cams at 5 fps | Headroom + activity models |

If the client stays on a VM: GPU passthrough, reserved (not shared) vCPUs, and a separate data
disk. Their current disk is 84% full, which is already a risk.

## 3. Implementation plan

| Phase | What | Effort | Effect |
|---|---|---|---|
| **1. Settings only** | Run UC2 only on clips (keep clips: they are the only camera attendance source today); turn on auto-delete after processing and retention; fix the UC1 motion-skip that misses faces. **Do not use `logs_only` yet** — it would stop camera attendance | 1–2 days | Halves the clip work; big storage cut |
| **1b. Live attendance** | Re-enable live face matching in the analyzer → write `detection_events` once per track (the writer already exists); then `logs_only` becomes safe for desk cameras | ~3–5 days + testing | Attendance without saving clips |
| **2. Event-based recording** | Enter/identified/dwell/exit state machine, re-entry cooldown, stationary suppression, ring buffer with pre/post settings per camera | ~1–2 weeks | Only meaningful clips; storage −90% |
| **3. CPU/GPU efficiency** | Sub-stream analysis, one pull per camera, shared batched inference service, GPU mode with automatic CPU fallback, recognition once per track | ~2–3 weeks | 25 cams stable; CPU freed |
| **4. Activity detection (optional, new scope)** | Phone and posture events as a pilot, per camera, with client approval on privacy | ~2–4 weeks + tuning | New feature |
| **Throughout** | Measure before and after with Pipeline Analytics and a benchmark on the RTX 5050 | — | Proof with numbers |

## 4. Open decisions

1. **Attendance from the live stream only?** Needs Phase 1b first (live matching is off today).
   Then clips become evidence only, and the clip pipeline runs only for unknown faces. Does
   that meet the client's needs?
2. **Activity detection:** is phone and posture detection a real requirement for this client,
   or a later idea?
3. **GPU at the client:** can they provide one, and if they stay on the VM, can they set up GPU
   passthrough? This decides Phase 3.
4. **Camera sub-streams:** do the cameras offer one? Most Hikvision/Dahua cameras do.
5. **Earlier fixes:** check that the fixes from `release/staging-testing` are in the current
   build: viewer-gated preview, the memory-leak fix (clip frames held in queues) and the
   inference thread caps. A quick check found the thread caps but not the others in their old
   form.

**Suggested start:** Phase 1. It's small, safe, and the fastest way to stop the backlog.
