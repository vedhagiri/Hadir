# Session summary — 2026-05-15

A structured record of everything worked on during this session.
Sections are independent — read them in any order.

---

## 1. Bug fixes (UI breakage)

### Leave & Calendar → Holidays tab going fully blank
- **Cause:** Rules of Hooks violation in `HolidaysTab` — `useState`
  call was placed below an early-return guard, so the hook order
  changed between renders.
- **Fix:** Moved `useState(importSummary)` above every early-return
  in `HolidaysTab`.
- **File:** `frontend/src/features/leave-calendar/LeaveCalendarPage.tsx`.

---

## 2. Worker architecture decisions

### Disable live face matching tenant-wide
- New per-tenant Admin toggle `live_matching_enabled` on
  `tenant_settings`.
- **Migrations:** `0059_tenant_settings_live_matching.py` (add
  column) → `0060_lm_default_off.py` (flip default to OFF).
- When the toggle is OFF, the analyzer skips face detection /
  matching and only computes body bounding boxes for the live
  preview overlay.
- **File:** `backend/maugood/capture/reader.py` — analyzer branches
  on the flag.

### Show only person bounding boxes in the live stream
- When live matching is disabled, the live MJPEG stream still
  receives bounding boxes — but they come from
  `detect_person_boxes` (YOLO person class only), not from
  InsightFace face detection.
- Wrapped `detect_person_boxes` with a rate-limited graceful
  `ModuleNotFoundError` fallback so missing `ultralytics`
  doesn't crash the worker — logs a single warning instead.
- Added `ultralytics==8.3.40` to `pyproject.toml`.
- **File:** `backend/maugood/detection/detectors.py`.

### Clip Saving as independent toggle
- Renamed the camera "Recording" toggle to **Clip Saving**.
- Clip Saving runs independently of Detection / Live Matching.
- The Cameras page now exposes three orthogonal flags:
  - `worker_enabled` (CPU + DB load — runs the worker at all)
  - `display_enabled` (Live Capture viewer access)
  - `clip_saving` mode (off / encode / stream_copy)

### Always-on worker model (per-UC cropping + shared matching)
- Decided **against** spawning ad-hoc cropping workers per request.
- Instead, every backend runs:
  - **3 always-on per-UC cropping queues** (one per use case)
  - **1 always-on shared matching queue** that consumes cropped
    faces from all three UCs.
- Workers are spawned at app startup; new submissions are pushed
  onto the queues with backpressure.
- **Package:** `backend/maugood/clip_pipeline/` —
  `stage.py` (StageQueue), `pipeline.py` (per-UC + shared
  matching), `batches.py` (BatchTracker), `jobs.py`,
  `router.py`.

---

## 3. Stream copy / encoding optimisation

### Problem
- Per-camera clip saving was re-encoding RTSP feeds with
  ffmpeg, which burned ~80% of one CPU core per camera at 1080p.

### Decision: Option B (stream-copy via `RtspSegmenter`)
- **Chosen approach:** zero-encode segmenter.
- Each camera runs a single long-lived ffmpeg subprocess
  (`-c copy -f segment`) that writes rolling H.264 MP4 segments
  to disk at native fps.
- The `ClipWorker` finalises a clip by concat-copying the
  relevant segments (no re-encode).
- **Default flipped to `stream_copy`** via the new
  `clip_saving_mode` setting.
- **New file:** `backend/maugood/capture/segmenter.py`
  (`RtspSegmenter`).
- **Modified:** `backend/maugood/capture/clip_worker.py` —
  added `_finalize_stream_copy` path; legacy encode path kept
  behind the flag.
- **Modified:** `backend/maugood/config.py` — added
  `clip_saving_mode` (default `stream_copy`).

### Auto-submit
- Every finalised clip is auto-submitted to the new
  `clip_pipeline` for all enabled use cases — no manual
  "Submit to pipeline" click required.

---

## 4. Face matching pipeline

### New migration: `0061_face_crops_match_confidence`
- Added `face_crops.match_confidence` column so each crop
  records the matcher's confidence at the time it was bound to
  an employee.
- Threaded `match_confidence` through every code path that
  writes face crops:
  - `_save_face_crops_*` helpers
  - `_backfill_crop_matches` for the matcher cache rebuild
  - The crop-to-event fan-out in `_emit_attendance_detection_events`.

### Pipeline shape
- Per-UC cropping (always-on): RTSP segment → face crop → row.
- Shared matching (always-on): face crop → InsightFace
  recognition → employee assignment with confidence.
- Match confidence stays attached to the crop forever, so the
  operator can see *why* a face was bound to a given employee
  even months later.

---

## 5. Attendance logic fixes

### Frame-accurate timestamps
- **Problem:** attendance was using the *processing time* of
  a crop as the "detection moment" — sometimes hours after
  the actual frame.
- **Fix:** every face crop carries `clip_start_at` +
  `event_timestamp` (computed as
  `clip_start + (orig_frame / frame_count) * duration_s`,
  equivalent to `clip_start + frame_index / fps`).
- Attendance now reads `event_timestamp`, not the crop's
  `processed_at`.

### In/Out emission as two detection events
- Per (clip, employee) pair, the fan-out now writes **two**
  `detection_events` rows — one for the **earliest** matched
  frame (in-time anchor) and one for the **latest** (out-time
  anchor).
- Idempotency: `track_id = "clip-{N}-emp-{E}-in"` and
  `"clip-{N}-emp-{E}-out"` so re-processing the same clip
  upserts the same anchors rather than duplicating rows.
- **File:** `backend/maugood/person_clips/reprocess.py` —
  `_emit_attendance_detection_events`.

### UTC parse bug in FaceCropLightbox
- `parseFlexibleTimestamp` was parsing `YYYYMMDD_HHMMSS`
  strings as **local time** (`new Date(y, mo, d, h, mi, s)`).
- Fixed to parse as UTC via `Date.UTC(...)`.
- **File:** `frontend/src/features/person-clips/PersonClipsPage.tsx`.

### Timezone display clarification
- User reported a 1.5h offset between expected (Kolkata) and
  displayed (Muscat) times. Confirmed this is **configuration,
  not a bug** — `tenant_settings.timezone` controls the
  display TZ. No code change required.

---

## 6. Clip Analytics changes

### Bulk delete scope: selected only
- **Problem:** "Delete All Matching Filter" button deleted every
  clip in the current filter even when only one row was selected.
- **Fix:** when the user has selected specific rows, delete
  only those. The "all matching" branch is only used when no
  rows are selected.
- **File:** `frontend/src/features/clip-analytics/ClipAnalyticsPage.tsx`.

### Batch Identify Event modal
- Rewired to use the new `clip_pipeline` `/submit-all` endpoint.
- Live per-UC progress panel (`BatchLiveProgressPanel`)
  polls the batch tracker.
- Overwrite confirmation: when one or more selected clips are
  already processed for the chosen UCs, a confirmation panel
  appears showing the exact processed-count per UC
  (`useProcessedClipCounts`).
- New endpoint: `GET /api/person-clips/processed-counts`.
- Overwrite mode pre-deletes prior
  `clip_processing_results` + `face_crops` + fan-out
  `detection_events` rows before re-submitting.

### Processing status pill
- New purple "Processing" pill in Clip Analytics rows when a
  clip is currently being processed for at least one UC.
- New `processing_use_cases` field on the clip response.

### FaceCropLightbox metadata
- Removed the processing-time "Match timestamp" field.
- Now displays: Detection time, Detection date, Use case,
  Match confidence.

---

## 7. Queue & Pipeline Monitor

### New `/pipeline-monitor` page
- Unified worker table — every worker on the box renders as
  one row.
- Columns: name, type, status, fps / queue depth, recent
  errors, last activity.
- 13 worker rows total: capture workers (per camera), 3 UC
  croppers, shared matcher, attendance scheduler, etc.

### Sync now button
- Spinning-icon button that triggers a manual reconcile pass
  on the CaptureManager and refreshes the workers table
  immediately (no 2-second tick wait).

### Queue / Pipeline panel
- Live counts for each queue (per-UC cropping + shared
  matching).
- Per-UC stats: queued / processing / completed / failed.

### Backend
- New `maugood/pipeline_monitor/` aggregator that joins
  `CaptureManager` state with `clip_pipeline` queue stats and
  returns a single payload at `/api/pipeline-monitor/workers`.

---

## 8. UI/UX improvements

### Shift Policies → Edit
- Switched **Edit** from a side drawer to a centered modal
  (operator preference: drawer was harder to scan against the
  detail panel).
- New `PolicyEditDrawer` (despite the name, it's a modal)
  built on `ModalShell`.
- `type` field locked when editing (server's `PolicyPatchInput`
  doesn't accept type changes — delete + recreate is the right
  path).
- `usePatchPolicy` mutation wired up; toast on save success/fail.

### Shift Policies → New (create)
- Also converted from drawer to centered modal — matches Edit
  for consistency.
- Removed the unused `DrawerShell` import from
  `PoliciesPage.tsx`.

### DatePicker popover clipping
- **Problem:** when the DatePicker lived inside a modal/drawer,
  the calendar popover got clipped by the modal's
  `overflow: auto` ancestor — operator couldn't see the date
  cells below "Active from".
- **Fix:** popover now renders via
  `createPortal(..., document.body)` with `position: fixed`.
  - Computes coordinates from
    `triggerRef.current.getBoundingClientRect()`.
  - Auto flip-above when there's no room below.
  - Listens to scroll + resize and re-positions.
  - Click-outside handler updated to allow clicks inside the
    portaled popover.
- **File:** `frontend/src/components/DatePicker.tsx`.

### Leave Types → duplicate code/name error message
- **Problem:** creating a Leave Type with a duplicate code or
  name returned a raw `IntegrityError` to the operator.
- **Fix:**
  - Pre-check `(tenant_id, lower(code))` and
    `(tenant_id, lower(name))` before INSERT.
  - Return clean 409s:
    - `A leave type with code 'X' already exists.`
    - `A leave type named 'Y' already exists.`
  - Blank code/name returns 400 with `Code is required.` /
    `Name is required.`.
  - IntegrityError race-condition fallback returns the same
    shape.
  - PATCH also dedups against the new name.
  - Code + name are stripped of leading/trailing whitespace
    before insert.
- **File:** `backend/maugood/leave_calendar/router.py`.

### Approved Leaves → Employee field
- **Step 1:** replaced free-form numeric `employee_id` input
  with a native `<select>` listing
  `{employee_code} — {full_name}` for every active employee.
- **Step 2:** dropdown was empty — root cause was passing
  `page_size: 500` which exceeded the backend's `le=200`
  cap, silently 422'ing the request. Capped at 200.
- **Step 3:** switched native `<select>` to a custom
  **searchable** `EmployeeSearchSelect` component (filter by
  code OR name; bold code + name body; `×` to clear).
- **Step 4:** dropdown was overlapping the Notes field and
  Create button below it. Fixed with same portal pattern as
  the DatePicker: `createPortal(...)` to `document.body`
  with `position: fixed`, auto flip-above when no room
  below, scroll/resize listeners for re-position.
- The ledger row also now displays the employee code + name
  instead of the bare `employee_id` integer (falls back to
  `#<id>` when the employee row is gone).

### Person Clips tab visibility
- Added `HIDE_PERSON_CLIPS` env flag to `frontend/src/config.ts`.
- Sidebar filters the entry when the flag is set — useful
  for tenants that don't want to expose the raw clip viewer.

### Sidebar version chip
- Verified the build pipeline:
  `package.json.version` → Vite `__APP_VERSION__` define →
  `config.ts` → `Sidebar.tsx`.
- Chip now shows `v1.1.15`.

---

## 9. Import / export improvements

### Shift Policies XLSX import (matches Employees flow)
- Three-step modal: **upload → preview → confirm**.
- New endpoints:
  - `GET /api/policies/import-template` — downloadable
    template `.xlsx`.
  - `POST /api/policies/import-preview` — server-side
    validation with per-row errors and warnings, no writes.
  - `POST /api/policies/import` — actual import (existing).
- New shared parser `_parse_policy_xlsx` reused by preview +
  import.
- New schemas: `PolicyImportPreviewRow`,
  `PolicyImportPreviewError`, `PolicyImportPreviewResult`.
- Drag-and-drop upload zone.
- **Files:** `backend/maugood/policies/router.py`,
  `backend/maugood/policies/schemas.py`,
  `frontend/src/policies/PolicyImportModal.tsx`,
  `frontend/src/policies/hooks.ts`
  (`usePreviewPoliciesImport`).

---

## 10. Pending tasks / implementation notes

### Validation walkthroughs awaiting Suresh sign-off
- P28.5a (Live Capture refactor) —
  `docs/phases/P28.5a.md`.
- P28.5b (worker / display split + per-camera knobs) —
  `docs/phases/P28.5b.md`.
- P28.5c (system detection + tracker config) —
  `docs/phases/P28.5c.md`.
- P28.7 (employee management) —
  `docs/testing/pre-omran-validation.md §13d`.
- P28.8 (worker monitoring + camera metadata) —
  `docs/testing/pre-omran-validation.md §13e`.

### Open critical item
- **Omran HR native-speaker review of the Arabic translations
  before v1.0 launch** — see `docs/phases/P21.md`. Standing
  carryover from P21; applies to all subsequent phases that
  added Arabic strings (P28.5b/c, P28.6, P28.7, P28.8).

### Known config trade-off
- Per-tenant timezone (`tenant_settings.timezone`) is the
  display TZ. Operators expecting a different TZ (e.g.
  Kolkata vs Muscat) need to change the setting, not the
  code.

### Architecture invariants worth remembering
- `analyzer_consume_every_seq` is **test-only**. Production
  must stay at False so a slow analyzer can't backlog frames.
- `FORCE_DETECT_EVERY_S=3.0` is the motion-skip safety net.
- The IoU tracker's caller (analyzer thread vs read loop)
  and rate (≤6 fps) is the only thing P28.5a changed —
  tracker logic itself is unchanged.
- Detector serialisation: module-level `_detect_lock`
  serialises all detect calls across cameras (parallel
  thrashes L1/L2 cache; serial is actually faster).
- Capture configuration precedence: per-camera
  `capture_config.max_event_duration_sec` **wins** over the
  tenant-wide `tracker_config.max_event_duration_sec`.

---

## 11. Tests touched

- `backend/tests/test_live_capture.py` — rewritten end-to-end
  for the P28.5a viewer (manager scoping, MJPEG, cap helpers,
  live-stats, events.csv, WebSocket).
- `backend/tests/test_capture.py` — adapted for the new
  `ReaderConfig` shape (`analyzer_max_fps`,
  `force_detect_every_s`, `analyzer_consume_every_seq` test
  knob).
- New regression test
  `test_https_gate_exempts_metrics_for_prometheus`.
- `tests/test_p28_5c_detection_settings.py` — 23 tests
  covering detection + tracker config validation.
- `tests/test_attendance_calendar.py` — 16 tests covering
  the new calendar aggregator.
- `tests/test_operations_workers.py` — 9 tests covering the
  worker stage state machine + role gates.
- `tests/test_super_admin_system.py` — 7 tests covering host
  metrics + tenants summary.

**Final state:** 542 backend tests passing. Frontend
typecheck clean across all edits.
