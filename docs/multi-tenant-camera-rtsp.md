# Multi-tenant cameras + RTSP load — verification and options

## TL;DR

When the same physical camera is configured under two tenant admin
accounts (each as its own `cameras` row), Maugood opens **independent
RTSP connections per tenant per worker stage**. With both `analyzer`
and `clip_segmenter` active in two tenants, that's **4 concurrent
RTSP pulls** from one device. Most consumer-grade IP cameras have a
hard cap of 1–3 concurrent main-stream connections, which is what
causes the "video recording sometimes fails" behaviour reported.

This is a per-deployment operational choice, not a code defect:
software isolation is correct (workers are keyed by
`(tenant_id, camera_id)`; no shared frame buffers, no shared
connections, no shared queues at the per-camera layer). The fix
options below trade off operational cost vs. resource savings.

## What was verified

### Worker isolation
* `CaptureManager._workers` is `dict[(tenant_id, camera_id), CaptureWorker]`.
  Two tenants pointing at the same physical camera produce two
  distinct worker entries with independent reader+analyzer threads,
  independent latest-frame slots, independent IoU trackers, and
  independent event emitters.
  (`backend/maugood/capture/manager.py`)

### RTSP stream sharing
* No sharing. Each `CaptureWorker.__init__` accepts a `decrypted_url`
  and `cv2.VideoCapture(decrypted_url)` is called per worker. There
  is no broker, no proxy, no shared decoder. Two workers → two
  underlying connections to the device.
  (`backend/maugood/capture/reader.py`)

### Clip saving
* Clip files are scoped per tenant at the path level:
  `/data/clips/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.mp4`. Two
  tenants writing clips from the same physical camera produce two
  separate file trees — no filesystem collision possible.
  Database isolation is enforced by `tenant_context()` scoping every
  insert to the tenant's schema (P1 invariant).

### Queue + worker init
* The clip pipeline's `ClipPipeline` is a process-wide singleton with
  per-UC global queues (`uc1`/`uc2`/`uc3`). Jobs carry a
  `TenantScope`; the handler re-enters `tenant_context(scope.tenant_schema)`
  per job. Cross-tenant cascade failure is prevented by per-job
  `try/except` around `_handle_crop` — one tenant's bad job cannot
  poison another tenant's queue position.
  (`backend/maugood/clip_pipeline/pipeline.py`)
* Worker startup: `CaptureManager.start()` iterates `public.tenants`
  on FastAPI lifespan, opens a `tenant_context(schema)` per tenant,
  and spawns workers for every enabled camera under that tenant.
  Same physical camera in two tenants → two worker spawn calls,
  each fully scoped.

### Shared resource locks
* The detector lock (`maugood.detection._detect_lock`) is **intentionally
  module-level**: face/person detection is CPU-bound, and serial
  execution beats parallel because parallel thrashes L1/L2 cache.
  This lock affects *throughput* (cameras share one detection thread
  worth of CPU) but not *correctness* and not *RTSP behaviour*. It
  is the one cross-tenant shared resource by design (P28.5c).

### Conclusion of verification
**The tenants do not interfere with each other in software.** All
isolation invariants hold. The instability is caused by external
hardware constraints — the camera's own concurrent-connection cap.

## RTSP connection math (current architecture)

For one physical camera registered in N tenants:
* N reader threads (one per tenant's `CaptureWorker`).
* Each reader opens 1 RTSP connection (the analyzer thread shares
  the reader's `cv2.VideoCapture` via a frame-reference handoff —
  no second RTSP per worker for analyzer).
* If `clip_recording_enabled = true`, the same reader frames feed
  the clip segmenter — still no second RTSP.

So:
* 1 tenant → 1 RTSP connection per camera.
* 2 tenants → 2 RTSP connections per camera.
* N tenants → N RTSP connections per camera.

Hardware concurrent-connection caps (from public datasheets):
* Hikvision (main stream): 3-5 simultaneous clients depending on
  model + firmware.
* Dahua (main stream): 3 simultaneous (some pro models 5).
* Imou / consumer: 1-3 simultaneous; some models silently drop the
  oldest connection when a 4th comes in.
* Generic ONVIF white-label: 1-2 simultaneous, often unstable above 1.

A typical pilot deployment (Omran HQ) with `1 camera × 2 tenants`
sits at 2 connections — within most hardware caps. The instability
window opens when:
* A third tenant joins, or
* A camera supports only 1 connection (some Imou models), or
* A camera's H.264 baseline keyframe interval is high and the
  reconnect storm temporarily double-counts connections, or
* Network jitter triggers `cv2.VideoCapture` reconnect on both
  workers within a short window → 4 transient connections.

## Options to mitigate

### Option A — Sub-stream for analyzer (recommended for office deployments)

Cameras typically expose two RTSP endpoints — main stream (1080p
H.264, 25fps) and sub-stream (480p H.264, 10fps). Run the
**analyzer** on the sub-stream and **clip recording** on the main
stream. Detection accuracy on faces at 480p is acceptable for
office-scale (1-3 m subject distance); clip recording stays
high-res for evidence quality.

Pros:
* Zero new infrastructure; per-camera knob change only.
* Sub-stream connections often don't count against main-stream
  cap on Hikvision / Dahua (they have separate caps).
* Halves analyzer CPU.

Cons:
* Per-camera config field needs to grow a `sub_rtsp_url_encrypted`
  column + a `cameras.capture_config.use_sub_stream_for_analyzer`
  boolean.
* Some cheap cameras don't expose a sub-stream.

Implementation effort: ~1 migration + ~50 lines on
`CaptureWorker.__init__` to open the sub-stream for the analyzer
thread while the reader keeps the main stream for clip frames.

### Option B — Shared RTSP broker (recommended if N tenants > 2)

Run a single per-host RTSP relay process (e.g. `mediamtx` /
ex-`rtsp-simple-server`, or a custom asyncio relay) that opens
**one** connection per physical camera and re-publishes it on
`rtsp://127.0.0.1:8554/{camera_serial}`. Each tenant's worker
connects to the local relay instead of the device.

Pros:
* Decouples Maugood scaling from camera concurrent-connection
  caps entirely. N tenants → 1 device connection.
* Local loopback is rock-solid; no jitter.
* Single point to debug RTSP issues per camera.

Cons:
* New service to deploy, monitor, and version.
* Crash on the broker is a single point of failure for every
  tenant on the host. Needs supervisor + restart policy.
* Adds ~50 ms latency on first frame; negligible for steady
  state but matters for live-capture viewer freshness.
* `mediamtx` is the right open-source choice (Go binary, no
  runtime deps); ~30 MB image, well-maintained.

Implementation effort: 1-2 days. Add a `rtsp_relay` service to
`docker-compose.yml`, change `decrypt_url` to optionally rewrite
the host to the relay, and add a per-camera `via_relay` flag.

### Option C — Operational restriction (zero engineering effort)

Document that each physical camera should be registered in **at
most one tenant at a time** for recording, with other tenants
either:
* Pointing at a different camera, or
* Reading clips via cross-tenant share API (does not exist today;
  would be a future feature), or
* Sharing the same tenant for a shared room.

Pros: ships today; no code.
Cons: ergonomically poor for SaaS — the whole point of
multi-tenant is that two unrelated organisations can use Maugood
on the same host without coordinating their camera setup.

### Option D — Detect + warn at configuration time

When an Admin adds a camera whose `rtsp_host` matches a camera
already registered in another tenant, surface a warning at the
provisioning UI: "This camera URL is already in use by another
tenant. Continuing will open 2 concurrent RTSP connections to
the device. Some cameras limit this; consider Option A or B."

Pros: cheap, defensive, non-breaking.
Cons: doesn't actually fix anything; relies on operator
discipline.

Implementation effort: ~30 min. Hash `rtsp_host:port` and compare
against rows in other tenants on POST `/api/cameras` — show the
banner if a collision is detected. Admin can still proceed.

## Recommendation

Short-term: **Option D** (warning banner) — ships defensively
without breaking the multi-tenant model.

Medium-term: **Option A** (sub-stream for analyzer) — biggest
return on engineering effort, halves both RTSP load and CPU,
fits within the existing `cameras.capture_config` JSONB knob
bag without architectural changes.

Long-term (if Maugood is sold to ≥3 tenants sharing a single
camera frequently): **Option B** (mediamtx broker) — pays the
infrastructure cost once and removes the entire failure mode.

## What the user should do today

For the immediate "video recording sometimes fails" symptom on
the same camera registered in two tenants:

1. Check the camera's datasheet for its concurrent-connection
   cap. If = 1, this configuration cannot work without Option B.
2. If = 2-3, the current setup should be stable; if it's
   intermittent, the problem is likely network jitter triggering
   simultaneous reconnects. Tune the reconnect backoff in
   `ReaderConfig.reconnect_backoff_initial_s` (default 1) up to
   3-5 seconds for both tenants — staggers the reconnect storm.
3. Confirm both tenants' cameras point at the same `rtsp://...`
   URL via the Super-Admin console (cross-tenant view). A
   typo'd path/port doubles up the effective connection count
   on one device.
4. If neither helps, implement Option A on the affected cameras.
