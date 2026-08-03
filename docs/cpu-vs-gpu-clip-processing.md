# CPU vs GPU for Maugood Clip & Detection Processing

**Purpose:** justify GPU acceleration for the client deployment — with the
mechanism stated *correctly*, so the argument survives technical review.

> **Key correction vs. the generic version of this note:** Maugood does **not
> re-encode** video clips. Clips are saved with ffmpeg **`-c copy`
> (stream-copy)** — the camera's existing H.264 bytes are written straight to
> disk, no transcode. Therefore the GPU benefit is **NOT** hardware video
> encoding (NVENC). The real, heavy, GPU-accelerable workload is the
> **face-detection / recognition neural network** (YOLO + InsightFace), which
> runs on **CUDA/Tensor cores**. Getting this distinction right is what makes
> the recommendation defensible.

---

## 1. Two workloads — do not conflate them

Maugood does two very different things with camera video. They have opposite
cost profiles:

| Workload | What happens | CPU cost | Bottleneck? |
|----------|--------------|----------|-------------|
| **A. Clip recording / saving** | Per-camera ffmpeg **`-c copy`** writes the existing H.264 stream to an MP4 segment. **No decode, no encode.** | **Near-zero** | ❌ No |
| **B. Face detection + recognition** | Decode frames → run **YOLO/InsightFace** neural nets → match against enrolled faces. Runs live *and* in on-demand reprocess (UC1/UC2). | **Very high** | ✅ **Yes** |

Saving 15–20 clips per minute (Workload A) is **cheap** — stream-copy is a byte
copy. The load the client feels comes from Workload B: the **detection neural
network** that runs on the frames.

### Why "15–20 clips processed simultaneously" is not the real picture
Detection is **serialized through a single global lock** (`_detect_lock`) — all
cameras share **one detection lane** box-wide. So detections don't run "all at
once"; they queue and run **one at a time**. That is *why* throughput collapses
as cameras/clips increase — not because of concurrent encoding contention.

---

## 2. Where the CPU time actually goes (measured)

On the client's current box (24-vCPU Intel Haswell KVM VM, **no GPU**):

- **UC1 face-crop extraction ≈ 415 s per clip** (~**7 s per analyzed frame**).
- **~97% of that time is the detection/extraction** (the neural net), and only
  ~0.2 s is the matching step.
- This is roughly **45× slower** than the same detection on modern
  GPU-class hardware.

The clip **saving** (stream-copy) does not appear in this hot path — it is not
the problem. The **neural-network inference** is.

---

## 3. What CPU-only optimization can (and cannot) do

We have already applied, or can apply, the CPU-side levers:

- Stream-copy clips (`-c copy`) — **already the default**, keeps saving cheap.
- Lower analyzer FPS (`analyzer_max_fps` 3 → 1–2) — fewer detections/sec.
- Smaller detector input (`det_size` 320 → 256) — cheaper per detection.
- Cheaper detection mode (InsightFace over YOLO+face for the live path).
- Motion-skip to skip still frames (tuned so it doesn't drop real faces).
- Viewer-gated preview encoding; inference thread caps; retention/disk hygiene.
- Vertical scaling: more/faster CPU cores.

**The hard limit:** because detection is serialized through the one
`_detect_lock` lane, box-wide detection throughput is
`~1000 ms/s ÷ per-detection-ms`, **independent of core count**. More cores do
**not** add detection lanes. On the CPU each detection costs ~80 ms (modern) to
~250 ms+ (this Haswell), capping the box at ~4–12 detections/sec total — below
what 25 cameras need. **No CPU tuning closes that gap; it only softens it.**

---

## 4. What a GPU actually accelerates here

A CUDA GPU (NVIDIA) runs the **detection/recognition neural networks** on its
parallel compute + Tensor cores. This is the correct and dominant benefit:

- **Per-detection cost drops from ~80–250 ms (CPU) to ~10–20 ms (GPU)** — a
  ~10× (vs modern CPU) to ~45× (vs this Haswell) speedup on the exact operation
  that is 97% of the cost today.
- That multiplies the serialized detection ceiling from ~4–12/sec to ~60+/sec
  box-wide — **enough to serve all 25 cameras** at a sane FPS with headroom.
- It **offloads the heaviest work off the CPU**, so the CPU cores keep the RTSP
  readers draining at native FPS → no live-view lag, no frame drops.

### About NVENC / NVDEC (hardware video codec) — the honest scope
- **NVENC (hardware *encode*)**: **not used** by Maugood. We stream-copy clips
  (no encode), so NVENC sits idle. It would only matter if we switched to
  `encode` mode — which we deliberately avoid *because* it is expensive. So the
  right fix for encode cost is "stay on stream-copy," not "buy NVENC."
- **NVDEC (hardware *decode*)**: a **minor** bonus. The reprocess step decodes
  saved clips before detection; NVDEC could shave that decode slice, but it is a
  small fraction next to the neural-net inference. It is not the reason to buy
  the GPU.

**Bottom line:** buy the GPU for **CUDA neural-net acceleration of detection**,
not for the video codec blocks.

---

## 5. Expected benefits (correctly attributed)

| Benefit | Mechanism |
|---------|-----------|
| Faster detection / recognition | Neural nets run on CUDA/Tensor cores (~10–45× faster per detection) |
| Higher throughput (more cameras/clips) | Serialized detection ceiling rises from ~4–12/s to ~60+/s box-wide |
| Lower CPU utilization | Heavy inference leaves the CPU; readers + stream-copy keep flowing |
| Reduced latency / real-time performance | Detections clear the `_detect_lock` lane far faster |
| Scalability headroom | Room to raise FPS or det_size, or add cameras, without saturating |

Clip **saving** speed is essentially unchanged by the GPU — it was already cheap
(stream-copy). What gets faster is the **detection** that runs on those clips.

---

## 6. Recommendation

**Provision an NVIDIA CUDA GPU** (RTX A2000 12 GB / RTX 4000 Ada; min RTX 3060
12 GB) and run detection on the CUDA execution provider. Justification:

1. The bottleneck is **face-detection neural inference**, not clip encoding —
   measured at ~97% of processing time and ~7 s/frame on the current CPU-only
   box.
2. Detection is **serialized through one lock**, so CPU core count cannot lift
   the ceiling; only **cheaper detections (GPU)** or **fewer detections (lower
   FPS)** can.
3. A GPU cuts per-detection cost ~10–45×, lifting box-wide throughput to
   comfortably serve **25 cameras** with headroom.
4. Keep clips on **stream-copy** regardless — that keeps the "15–20 clips/min"
   saving effectively free and means NVENC is not needed.

Continue the CPU-side optimizations (§3) as good hygiene, but treat them as
*softening* the limit, not removing it. For a single-box 25-camera site, the
GPU is the component that actually moves the ceiling.

> Sizing, BOM, memory/storage/PoE math, and the CPU-only fallback envelope are
> in the companion document **`docs/hardware-sizing-25-cameras.md`**.

---

*Grounded in Maugood's shipped defaults (`clip_saving_mode=stream_copy`,
`analyzer_max_fps=3.0`, `det_size=320`) and the single global `_detect_lock`
serialization model, plus measured field data from the client's 21-camera
Haswell VM.*
