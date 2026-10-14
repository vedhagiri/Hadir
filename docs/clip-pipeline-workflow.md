# Clip pipeline workflow — Use case 1 vs Use case 2 (current state)

*Snapshot of how the system works today (12 Oct 2026), taken from the code and the running
dev stack. Update this file when the pipeline changes.*

## 1. The two use cases

Both use cases look for faces in a saved clip and match them to employees. **Use case 1 is
the person-based one.** There is no use case 3 (`_VALID_USE_CASES = ("uc1", "uc2")`,
`backend/maugood/clip_pipeline/pipeline.py:121`).

| | **Use case 1: "High Accuracy" (person-based)** | **Use case 2: "Standard"** |
|---|---|---|
| How it finds faces | YOLOv8n finds each **person's body** first (class 0, imgsz 640, conf 0.25), then InsightFace buffalo_l finds the face **inside each body box** (40 px padding) | InsightFace buffalo_l (SCRFD `det_10g`, det_size 640) on the **whole frame** |
| Good for | Crowds, wide-angle cameras, people far away | Clear faces at entrances and exits |
| Smallest face / min score | 30×30 px · 0.35 | 60×60 px · 0.45 |
| Skips unchanged frames | Yes (`MAUGOOD_CLIP_PIPELINE_UC1_MOTION_SKIP`, default 5.0) | No |
| Face photos kept | Best crop per face track, ranked by quality but **never dropped**; max 30 per clip, 30% padding, small faces upscaled to 200 px | Best crop per track by blur, size, pose and confidence; **low-quality and side-on tracks are dropped**; 320×320 |
| Matching | ArcFace `w600k_r50` embedding → cosine similarity against `matcher_cache` (employees' reference photos) | Same |
| Results written | `clip_processing_results` (uc1), `face_crops` (uc1), **`person_clips.matched_employees`** (UC1 is the result shown on the clip), `detection_events` | `clip_processing_results` (uc2), `face_crops` (uc2), `detection_events` |

Detection settings: `backend/maugood/person_clips/reprocess.py:191-208`;
crop saving: `_save_face_crops_uc1_best_per_track` (:979) and
`_save_face_crops_uc2_best_per_track` (:785).

## 2. End-to-end workflow

1. **Capture.** The camera reader thread (`capture/reader.py:1478`,
   `_check_and_record_clip`) starts a clip when a person is in view (the analyzer saw a
   person or the tracker has an active track).
   - The clip ends after a grace period with nobody in view, or is split every
     `chunk_duration_sec` (default 180 s).
   - When it starts, a placeholder `person_clips` row is inserted with
     `recording_status='recording'`, shown as **LIVE** in the UI.
   - Dev saving mode is `MAUGOOD_CLIP_SAVING_MODE=stream_copy`: `RtspSegmenter` records
     the H.264 stream.
   - In `logs_only` recording mode, only a presence-log row is written and no video is
     saved.
2. **Clip saved.** `ClipWorker` (`capture/clip_worker.py`) encrypts the MP4 with Fernet and
   writes the `person_clips` row.
3. **Automatic submission.** Straight after saving, `ClipWorker` calls
   `clip_pipeline.submit_batch(use_cases=enabled_use_cases_for(scope), skip_existing=True)`
   (`clip_worker.py:721`, `:944`).
   - Enabled use cases come from `MAUGOOD_CLIP_PIPELINE_USE_CASES` (default `uc1,uc2`).
   - A per-tenant `tenant_settings.clip_pipeline_use_cases` overrides it (Settings toggles).
4. **Two-stage queue** (`clip_pipeline/pipeline.py`).
   - Each (clip, use case) pair is one job. There is a cropping queue per use case
     (`crop_uc1`, `crop_uc2`) and one shared `match` queue.
   - Each stage runs 1 worker by default (`MAUGOOD_CLIP_PIPELINE_CROPPING_WORKERS` /
     `MATCHING_WORKERS`).
   - The queue holds up to 64 jobs.
5. **Cropping stage** (`_handle_crop`):
   - Marks the result `processing`.
   - Decrypts the clip to a temporary file.
   - Samples about 2 fps, max 30 frames (`MAUGOOD_CLIP_PIPELINE_MAX_FRAMES_PER_CLIP`),
     spread evenly over long clips.
   - Runs detection: `yolo+face` for UC1, `insightface` for UC2.
   - Saves the best crop per face track to `face_crops` (encrypted on disk,
     `employee_id` empty for now).
6. **Matching stage:**
   - Each embedding is matched against employees (`_match_detections`).
   - Matched employee and confidence are written back to `face_crops`.
   - `clip_processing_results` is set to `completed`, with matched employees, unknown count,
     match details and timings.
   - UC1 only: writes `person_clips.matched_employees` and `matched_status='processed'`.
7. **Attendance.** `_emit_attendance_detection_events` (`reprocess.py:1471`) inserts
   `detection_events`. **This is the only way camera sightings reach attendance today:** the
   live analyzer detects and tracks faces but does not write `detection_events`
   (`capture/events.py::emit_detection_event` exists but has no caller). So
   `recording_mode=logs_only` means no camera attendance; only attendance terminals still
   record.
   - For each matched employee it writes one **"in"** row (earliest sighting) and one
     **"out"** row (latest sighting).
   - It writes one unidentified row per unknown face.
   - **These rows feed the attendance engine.**
8. **Optional clean-up.** `_maybe_auto_delete_clip_video` deletes the video only when the
   tenant flag is on **and** every enabled use case has completed.

**Other ways to trigger processing:**
- **Manual:** right-click "Run face matching" or the drawer's Reprocess button calls
  `POST /api/person-clips/{id}/reprocess`. This takes the older direct path
  (`_process_clip_for_use_case`) and bypasses the queues.
- **Batch / retry:** `/api/clip-pipeline/*` (submit-all, retry-failed).
- **Recovery:** `recovery.py` / `reconcile.py` re-queue jobs interrupted by a restart.

**Database tables touched:** `person_clips`, `clip_processing_results` (one row per clip +
use case), `face_crops` (has a `use_case` column), `detection_events`, and
`tenant_settings` (read only).

## 3. Where results show in the app

| Page | What you see |
|---|---|
| **Person Clips** | Status pills per clip, right-click to run UC1 or UC2, a "Use Case Results" section with face crops per use case, and the UC1-vs-UC2 comparison (`/api/person-clips/uc-comparison`) |
| **Clip Logs** (Admin) | List of clips and presence logs; the drawer has the video player and the per-use-case results |
| **Clip Analytics** | Clips with match-result and recording-mode filters |
| **Pipeline Analytics** | Where UC1/UC2 time goes: queue wait, load, decode, detection, crop, match, CPU %, memory |
| **Pipeline Monitor** | Live queue and worker state |

## 4. CPU or GPU? → **CPU only**

| Check | Finding |
|---|---|
| Code | `detection/detectors.py:303` forces `providers=["CPUExecutionProvider"]`; `:307`/`:317` use `ctx_id=-1` (CPU) |
| Package | `backend/pyproject.toml:36` pins `onnxruntime==1.19.2` (CPU build, not `onnxruntime-gpu`); `backend/Dockerfile` uses `python:3.11-slim` (no CUDA) |
| Running container | onnxruntime providers: Azure + CPU only; `torch.cuda.is_available() = False`; no `/dev/nvidia*`; no GPU settings in any compose file |
| YOLO (UC1) | No `device=` given; torch can't see CUDA in the container, so it runs on the CPU |
| Host | **NVIDIA GeForce RTX 5050, 8 GB** (driver 595.84, CUDA 13.2), **0% used** |

**To use the GPU later** (needs testing):
1. Pass the GPU into the backend container (compose `gpus` / NVIDIA runtime).
2. Install `onnxruntime-gpu`.
3. Remove the CPU-only setting in `detection/detectors.py`.

YOLO would then probably move to the GPU automatically, because torch is already a CUDA
build. GPU metrics on the system page also need `pynvml`, which is not installed.

## 5. Known gaps
- **Stale help text.** The UI help text (`en.json`, clip logs `helpTitle`) and a comment in
  `clip_worker.py:689-700` say clips are "not matched automatically — right-click to run".
  That is out of date: clips **are** processed automatically.
- **Two code paths.** Manual single-clip reprocess uses the older direct path; automatic and
  batch processing use the queued pipeline. The behaviour is the same in principle.
- **Dead code.** `_trigger_face_match` / `process_single_clip` (`clip_worker.py:1213`) is
  never called.
- **Unchecked.** Whether a tenant has overridden which use cases are enabled was not
  checked in the database (the env default is both).
