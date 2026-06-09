# Stage 3 — Clip Recording / Clip Saving: architecture (CPU-only)

> Scope: **segment creation, clip finalize, encryption, disk/CPU/memory
> behavior, and CPU-only scaling** for the Clip Recording / Saving stage.
> Companion to `live-feed-options.md` and `stage2-detection-models.md`.
> Grounded in `backend/maugood/capture/segmenter.py` and
> `backend/maugood/capture/clip_worker.py` (v1.1.x).
>
> Target box: one site, 21+ cameras, 24 vCPU / 16 GB, **CPU-only (no GPU)**.

```
Person Present → Clip Start → Segment Creation → Clip Finalize → FFmpeg Merge → Encryption → Clip Save
```

---

## Components loaded in this stage

**No ML models — pure I/O + ffmpeg.** Per camera:

| Component | What it is | Lifetime |
| --- | --- | --- |
| RtspSegmenter | per-camera **ffmpeg subprocess** doing `-c copy` segmenting | continuous (stream_copy) |
| Segmenter watchdog thread | restarts ffmpeg on crash w/ backoff | continuous |
| Segmenter janitor thread | purges segments older than retention | continuous |
| ClipWorker thread | drains a bounded queue, finalizes clips | continuous |
| Fernet | symmetric AES encryption (lib, not a model) | per finalize |

## How each piece works (grounded)

**FFmpeg — one process per camera (not shared).** Segmenter spawn args:
```
ffmpeg -rtsp_transport tcp -fflags +nobuffer -i <rtsp> -c copy -an
       -f segment -segment_time 10 -segment_atclocktime 1 -reset_timestamps 1
       -strftime 1  seg_%Y%m%d_%H%M%S.mp4
```
- `-c copy` → **no decode, no encode** — raw H.264 packets to disk.
- `-an` → drop audio.
- **Segment creation:** ffmpeg writes a new 10 s MP4 every 10 s
  (`SEGMENT_SECONDS=10`), clock-aligned. The app does nothing per segment.
- **Retention:** janitor deletes segments older than `RETENTION_SECONDS=600`
  (10-min rolling on-disk buffer).

**Clip saving — a dedicated worker per camera.** Each `CaptureWorker` owns one
`ClipWorker` thread with a bounded queue (maxsize 16). Not shared.

**Clip finalization (stream_copy, `_finalize_stream_copy`):**
1. `segmenter.get_segments_in_range(t_start, t_end)` — pick covering segments.
2. `ffmpeg -f concat -c copy` → stitch into one MP4 (**no re-encode**,
   O(seconds)).
3. `merged.read_bytes()` → **whole clip into RAM** → `encrypt_bytes()` (Fernet)
   → `write_bytes()` to `/clips/...`.
4. UPDATE `recording` placeholder row → `completed`; auto-submit to UC pipeline.

**Encryption:** **whole-file Fernet** (AES-128-CBC + HMAC, base64). During
finalize a clip transiently occupies **~2.3× its size in RAM** (plaintext +
ciphertext + base64).

**Copied / encoded / re-encoded?**
- **stream_copy (default): copied only** — never decoded/encoded. Lossless,
  cheap.
- **encode (legacy): re-encoded** — reader saves JPEG frames, ClipWorker runs
  `libx264` per chunk (ThreadPool ≤4) then concat-copies. CPU-heavy.

## Resource behavior per step (stream_copy)

| Step | CPU | Memory | Disk I/O |
| --- | --- | --- | --- |
| Segment creation (`-c copy`) | ✅ ~0 (mux) | ✅ tiny | **sustained writes = camera bitrate** |
| Clip trigger / presence | ✅ ~0 | ✅ ~0 | none |
| Concat-copy finalize | ✅ low (O(s)) | ⚠️ reads segments | burst read+write of clip size |
| **Encryption (Fernet whole file)** | ⚠️ **AES on full clip** | ❌ **~2.3× clip-size RAM spike** | none |
| Clip save (write) | ✅ low | — | burst write of clip size (+33% base64) |

In stream_copy the only non-trivial CPU/RAM in clip-saving is **whole-file
encryption**; the dominant sustained resource is **continuous segment
disk-write bandwidth**.

---

## With 21 cameras recording simultaneously

**Per camera (scales linearly):**
- 1 ffmpeg `-c copy` subprocess
- 1 watchdog + 1 janitor + 1 ClipWorker thread
- **2 RTSP connections** — OpenCV reader (Stage 1/2) **and** segmenter ffmpeg
  pull the stream **independently**
- continuous disk writes at camera bitrate; disk space = 21 × 600 s × bitrate

21 cameras ≈ **21 ffmpeg processes + ~63 threads + 42 RTSP connections**, plus
sustained disk write = **Σ bitrates** (e.g. 21 × 4 Mbps ≈ ~10 MB/s, 24/7) and
constant create/delete churn every 10 s × 21.

**Shared globally:** essentially **nothing** in clip-saving (no shared model/
encoder). The UC pipeline downstream is shared — that's Stage 4/5.

**Duplicate processing:**
1. **Two independent full-stream RTSP pulls per camera** (reader decode +
   segmenter copy). 2× network + 2× connection budget.
2. **Whole-clip in-memory encryption** spikes RAM; concurrent finalizes stack.
3. Raw **segments are plaintext on disk** for up to 10 min (only the final clip
   is Fernet-encrypted).

**Bottleneck?**
- **stream_copy: rarely CPU-bound.** Bottleneck is **disk write bandwidth +
  IOPS** and the **encryption RAM spike** under concurrent finalize.
- **encode: yes, CPU-bound** (`libx264` × 21 = the incident).

---

## Five approaches compared

### Approach 1 — Stream Copy Recording (current)
- Workflow: continuous `-c copy` segments → concat-copy person-window →
  encrypt → save.
- FFmpeg: 1 subprocess/camera (segment) + 1 short-lived concat/camera.
- Worker/Thread: 1 ClipWorker/camera + segmenter watchdog/janitor.
- CPU ✅✅ low (mux + AES). Memory ⚠️ encryption spike. Disk ⚠️ continuous.
- Scale 21+: ✅ strong on CPU; bounded by disk bandwidth.
- +Lossless, cheap, encrypt-at-rest. −2nd RTSP pull; plaintext transient
  segments; whole-file encryption RAM.

### Approach 2 — Encode-Based Recording (legacy)
- Workflow: reader saves JPEG frames → `libx264` per chunk → concat → encrypt.
- FFmpeg: per-chunk encode (ThreadPool ≤4)/camera.
- CPU ❌ heavy. Memory ❌ frame accumulation. Disk moderate.
- Scale 21+: ❌ doesn't scale (the incident).
- +Exact frame count; transcode/downscale. −CPU + memory blowup.

### Approach 3 — Continuous Recording + Event Markers
- Workflow: keep **all** segments by age; store person-present **time ranges
  as DB markers**; clips become **virtual** time ranges. Finalize largely
  disappears (extract on demand / never).
- FFmpeg: same `-c copy` segmenter; **no concat at record time.**
- Worker/Thread: cheap marker-writer instead of encoder.
- CPU ✅✅ lowest. Memory ✅ low. Disk ❌ highest (keep everything) but
  predictable.
- Scale 21+: ✅✅ what real NVRs do.
- +Never miss footage; trivial finalize; re-extract any window. −Large disk;
  player seeks segment ranges; encrypting a continuous archive is more design.

### Approach 4 — Shared Recording Service
- Workflow: external service (MediaMTX/go2rtc/ffmpeg-manager) ingests + records
  all cameras; app consumes finished clips/segments.
- FFmpeg: managed by the service (still `-c copy`).
- Worker/Thread: out of the Python process.
- CPU ✅ same low, offloaded. Memory ✅ off-app. Disk same.
- Scale 21+: ✅ good; crash-isolated; **reuses the Stage-1 preview relay**.
- +Lighter app; one service for preview + record; isolation. −Extra service;
  encryption boundary moves.

### Approach 5 — Centralized Clip Processing Queue
- Workflow: drop per-camera ClipWorkers; one **shared pool of N finalize
  workers** drains a global queue from all cameras.
- FFmpeg: concat/encode invoked by pool workers.
- Worker/Thread: N shared workers (bounded).
- CPU same total, bounded + fair. Memory ✅ caps concurrent whole-clip
  **encryption RAM** to N clips at once. Disk same.
- Scale 21+: ✅ prevents 21 simultaneous encrypt/encode RAM spikes.
- +Bounds the memory spike; fair. −Finalize latency under burst; mainly helps
  encode + the encryption spike (stream_copy finalize is already cheap).

### Side-by-side

| | FFmpeg | CPU | Memory | Disk | Scale 21+ | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Stream copy (current) | 1 copy/cam | ✅✅ low | ⚠️ encrypt spike | ⚠️ continuous | ✅ | correct base |
| 2 Encode | encode/cam | ❌ high | ❌ frames | ⚠️ | ❌ | retire |
| 3 Continuous + markers | 1 copy/cam | ✅✅ lowest | ✅ low | ❌ highest | ✅✅ | NVR-grade if disk allows |
| 4 Shared service | external | ✅ offloaded | ✅ off-app | ⚠️ | ✅ | great long-term |
| 5 Centralized finalize queue | pool | ✅ bounded | ✅ caps spike | ⚠️ | ✅ | cheap RAM-safety add-on |

---

## Best approach for CPU-only

**Keep stream_copy (Approach 1)** — already the right answer on CPU (no decode,
no encode). Then blend:

1. **Add a centralized finalize queue (Approach 5)** — a small shared pool for
   concat+encrypt so concurrent finalizes can't stack whole-clip encryption RAM
   spikes. Cheap, low-risk, fixes the one stream_copy memory concern.
2. **Move recording into a shared service (Approach 4)** longer-term — the same
   MediaMTX/go2rtc relay used for preview can also do `-c copy` recording,
   which **collapses the two RTSP pulls per camera into one** and takes ffmpeg
   out of the Python process.
3. **Consider continuous + markers (Approach 3)** *only if* "never miss
   footage" is required and disk allows — it removes the finalize step.

Avoid Approach 2 (encode) for normal operation.

## Unnecessary processing / duplicate work / optimization opportunities

1. **Double RTSP ingest per camera** (reader decode + segmenter copy) — 42
   connections at 21 cameras. **Biggest structural waste here.** A shared relay
   (Approach 4) or feeding detection from the segments collapses this to one
   pull/camera.
2. **Whole-file in-memory Fernet encryption** (~2.3× clip-size RAM spike).
   **Opportunity:** chunked/streaming encryption + bound concurrency
   (Approach 5).
3. **Plaintext segments on disk for up to 10 min** — only the final clip is
   encrypted; rolling raw segments are decodable video at rest.
   **Opportunity:** encrypt segments / shorten retention / restrict temp dir —
   weigh against the encrypt-at-rest red line.
4. **`frame_count` approximated as `duration×25`** in stream_copy — minor
   data-quality gap.
5. **Per-camera watchdog + janitor threads** — 42 mostly-sleeping threads; a
   single shared supervisor + janitor would tidy this (negligible CPU/RAM win,
   cleaner).
6. **Segments use `+frag_keyframe+empty_moov`** then concat-copy re-mux at
   finalize — correct; continuous+markers (#3) skips this re-mux entirely.

**Net:** clip-saving is **not** a CPU bottleneck in stream_copy — the real
costs are **continuous disk-write bandwidth**, the **double RTSP pull**, and the
**whole-clip encryption RAM spike**. Highest-value changes: a **centralized
finalize queue** (bounds RAM, cheap) and a **shared recording/relay service**
(kills duplicate ingest, offloads ffmpeg).

---

## Cross-references

- Live feed / RTSP options: `docs/architecture/live-feed-options.md`.
- Detection models + lock: `docs/architecture/stage2-detection-models.md`.
- Segmenter: `backend/maugood/capture/segmenter.py`.
- ClipWorker + finalize + encryption: `backend/maugood/capture/clip_worker.py`.
- Clip storage / retention / analytics: `clip-storage-management` skill.
