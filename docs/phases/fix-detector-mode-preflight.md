# Fix: capture pipeline silently bricked by `yolo+face` detection mode

## Symptom (reported)

> "Capturing the faces from live camera is not working."

Workers page (operations/workers) showed two cameras with RTSP green
+ Detection green but Matching red and Faces saved (60 s) at 19 then
0. Database confirmed: zero new `detection_events` rows since the
operator toggled detection mode.

## Diagnosis

Backend logs were spamming, on every analyzer cycle (≈ 6/s × 2
cameras):

```
WARNING hadir.capture.reader camera Camera 2: analyzer error: ModuleNotFoundError
WARNING hadir.capture.reader camera Giri Home: analyzer error: ModuleNotFoundError
```

Reproduced from a python REPL inside the backend container:

```python
>>> from hadir.detection.detectors import _load_yolo
>>> _load_yolo()
ModuleNotFoundError: No module named 'ultralytics'
```

Audit log showed the operator switching `tenant_mts_demo`'s
`tenant_settings.detection_config.mode` from `insightface` to
`yolo+face` on `2026-04-26 19:56:22 UTC`. The `yolo+face` code path
in `hadir/detection/detectors.py::_load_yolo` does
`from ultralytics import YOLO`, but `ultralytics` is **not** in
`backend/pyproject.toml` and not installed in the runtime image. The
import raised on every analyzer cycle, the analyzer thread caught
it, set `detections = []`, and the rest of the pipeline (tracker,
matcher, event emit) ran on an empty list — producing zero rows.

The Workers page reported "Detector firing but matcher silent —
check enrolled photos" because the rolling 60s `_matches_window` was
empty. The text was misleading: detection wasn't firing at all.

## Root cause

Two-part:

1. **Mode availability gap.** The runtime image ships InsightFace
   but not Ultralytics. The System Settings page nonetheless
   advertised `yolo+face` as a valid choice and the
   `PUT /api/system/detection-config` endpoint accepted it without
   verifying the runtime deps were present.
2. **Silent failure mode in the analyzer.** The catch-all in
   `reader.py::_analyzer_loop` logs `type(exc).__name__` only,
   so `ModuleNotFoundError` doesn't even mention which module is
   missing. The error spammed at WARN forever instead of taking
   the worker into a `failed` state.

## Fix

### A — live recovery (one-shot SQL on the running tenant)

```sql
SET search_path TO tenant_mts_demo, public;
BEGIN;
UPDATE tenant_settings
   SET detection_config = jsonb_set(detection_config, '{mode}', '"insightface"')
 WHERE tenant_id = 2;
INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, before, after, actor_label)
VALUES (2, 'system.detection_config.recovered', 'tenant_settings', '2',
  jsonb_build_object('mode','yolo+face','reason','ultralytics_not_installed_in_image'),
  jsonb_build_object('mode','insightface'),
  'ops_recovery');
COMMIT;
```

The 2-second `CaptureManager._reconcile_tick` saw the diff and
hot-swapped each worker's detector config without a worker restart.
ModuleNotFoundError stopped firing within one tick. Backend logs:

```
INFO hadir.identification.matcher matcher cache loaded: tenant_id=2 employees=1 vectors=1
INFO hadir.capture.directory employee directory loaded: tenant_id=2 employees=1
```

### C — pre-flight check on `PUT /api/system/detection-config`

New `hadir/detection/detectors.py::is_mode_available(mode)` returns
True iff the runtime carries the deps for that mode:

* `insightface` → always True (mandatory dep).
* `yolo+face`  → True iff `_yolo_model is not None`
  (already loaded) **or** `importlib.util.find_spec("ultralytics")`
  returns a spec.

`hadir/system/router.py::put_detection_config` calls this
immediately after the Pydantic validation step. An unavailable mode
returns **400** with the canonical detail shape:

```json
{
  "field": "mode",
  "message": "detector mode 'yolo+face' is not available in this build (required runtime dependency missing)"
}
```

The frontend's existing field-level error handling on the System
Settings page picks up `detail.field=mode` and surfaces it inline
on the mode radio. No more silent mis-configuration.

## Tests

* Updated existing `test_put_detection_config_round_trips` to use
  `mode=insightface` (it had been silently testing a code path
  that always failed at runtime).
* New `test_put_detection_config_rejects_unavailable_mode`
  monkeypatches `is_mode_available` to return False for `yolo+face`
  and asserts the PUT returns 400 with `detail.field == "mode"` and
  the canonical message. Doesn't depend on whether the test image
  has `ultralytics` installed.

**Backend suite: 543 passed + 1 skipped** (was 542 + 1; +1 pre-flight
test, no regressions).

## Future work (deferred)

* **Decision: install ultralytics or remove the YOLO toggle from
  the UI?** ultralytics pulls torch (~500 MB image bloat). Until
  that decision is made, the pre-flight makes the toggle honest:
  saving an unavailable mode now fails loudly. If we keep the
  toggle and ship ultralytics, this guard becomes a no-op (the
  function returns True) — no code change needed.
* **Improve analyzer error logging.** Today the worker's analyzer
  loop logs `type(exc).__name__` only, so a `ModuleNotFoundError`
  doesn't say which module is missing. Should log
  `repr(exc)` once-per-error-message and dedupe — covered under
  P28.8 backlog as "noisy analyzer error" cleanup.

## Layer 2 — `min_face_quality_to_save` rejecting legitimate captures

After Layer 1 was fixed and capture resumed, a second symptom
appeared: **live video showed face boxes drawn on detected faces, but
no `detection_events` rows landed in the DB**. Camera Logs page
stayed empty even though the analyzer was clearly producing
detections (the boxes are baked into the live MJPEG feed).

### Diagnosis

`_publish_cached_boxes` (reader.py:836) draws annotation boxes
**before** the emit step, so a detection produces a box even when
`emit_detection_event` later rejects the row. The pre-fix events.py
carried this gate (events.py:204):

```python
score = quality_score(bbox, det_score)
if score < min_quality:           # min_quality default = 0.35
    return None                    # silently skipped, DEBUG-logged
```

`quality_score(bbox, det_score)` in v1.0 is the simplified formula
`0.75 × area_norm + 0.25 × det_score` where
`area_norm = min(w*h / 200², 1.0)`. For a typical walk-past at a few
metres from a 1080p IP camera the face is ~70×80 px:

```
area_norm = 70*80 / 40000 = 0.14
score    = 0.75 * 0.14 + 0.25 * 0.7 = 0.105 + 0.175 = 0.280
```

That's below `0.35`, so every detection at that distance silently
rejected. Mts_demo's live walk-past produced rows with bbox
65-66 × 75-84 — confirmed by the post-fix data.

### Why the threshold was wrong

The 0.35 default came from `prototype-reference/backend/`, where
`quality_score` is **pose-aware** (`0.6 × area + 0.25 × pose_score
+ 0.15 × det_score`). With landmarks available, a frontal 80×80 face
scores `0.6*0.16 + 0.25*1.0 + 0.15*0.7 = 0.451` — comfortably above
0.35. v1.0's `Detection` dataclass doesn't carry `kps` yet, so the
analyzer can't compute pose; the simplified formula effectively
penalises every distance-medium face.

But the deeper issue: **the prototype itself doesn't have an absolute
quality threshold.** Reading
`prototype-reference/backend/capture.py::_handle_face` (line 398-456)
shows `quality_score` is computed but used only to *rank* faces
within a multi-face-per-event row (top-N selection across the track's
lifetime). Detector-level filtering (`min_det_score=0.5`,
`min_face_pixels=60²=3600`) happens in `_detect_insightface`; nothing
downstream rejects on quality.

v1.0 is single-row-per-event today (multi-face accumulation is
deferred), which makes the ranking moot and the absolute gate purely
a recall regression.

### Fix

* `hadir/capture/events.py::emit_detection_event` — removed the
  `if score < min_quality: return None` block. Detector-level
  filtering upstream (`min_det_score`, `min_face_pixels`) is the
  only gate now, mirroring prototype.
* `hadir/capture/events.py` docstring updated — invariant 1 is now
  the empty-crop guard, invariant 2 is reserved.
* `hadir/cameras/schemas.py::CaptureConfig` — `min_face_quality_to_save`
  default lowered to `0.0` and field marked deprecated. Kept on the
  schema so existing JSON validates and migration 0027 doesn't need
  a follow-up.
* `hadir/cameras/repository.py::DEFAULT_CAPTURE_CONFIG` — same.
* `hadir/db.py::cameras` server_default JSON — same.
* `hadir/capture/reader.py::CaptureWorker.DEFAULT_CAPTURE_CONFIG` —
  same.
* `frontend/src/features/cameras/types.ts::DEFAULT_CAPTURE_CONFIG`
  — same; field documented as deprecated.
* `frontend/src/features/cameras/CameraDrawer.tsx` — the slider that
  exposed the knob is gone. The CaptureConfig interface still
  carries the field so existing camera rows don't fail validation.
* i18n keys (`cameras.fields.minFaceQualityToSave` and matching
  hint) left in `en.json`/`ar.json` as orphaned strings — harmless
  and avoids reflowing the locale files.
* `quality_score` itself **stays** in `events.py`; it'll be useful
  when v1.x adds kps-aware ranking for multi-face-per-event.

### Tests

* `test_emit_skips_row_and_file_when_quality_below_threshold` →
  renamed to `test_emit_writes_low_quality_row_after_quality_gate_removal`
  and inverted: a 60×60 detection at det_score=0.9 (which scores
  ~0.29, the same number that triggered the bug) **must** now land
  one row + one file even when the legacy `min_face_quality_to_save:
  0.35` is still in the config dict.
* `test_quality_score_filters_low_quality_below_threshold` →
  renamed to `test_quality_score_arithmetic` (was misleading — the
  formula doesn't filter anything anymore; only documents the
  arithmetic).

### Live recovery (one-shot SQL on the running tenant)

```sql
SET search_path TO tenant_mts_demo, public;
BEGIN;
UPDATE cameras
   SET capture_config = jsonb_set(capture_config, '{min_face_quality_to_save}', '0.0')
 WHERE tenant_id = 2;
INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, before, after, actor_label)
VALUES (2, 'camera.capture_config.recovered', 'camera', 'all',
  jsonb_build_object('min_face_quality_to_save', 0.35),
  jsonb_build_object('min_face_quality_to_save', 0.0,
                     'reason', 'quality_score formula non-pose-aware in v1.0; 0.35 was prototype pose-aware threshold'),
  'ops_recovery');
COMMIT;
```

The 2 s reconcile tick picked up the diff and hot-swapped each
worker's `capture_config` without a worker restart. First fresh
detection_events rows landed within seconds with employee_id
populated.

## Layer 3 — per-event detection metadata (model + version)

After Layer 2 unblocked capture, operator asked to record, for each
captured photo, *which* model identified the face and *which* version
was running, alongside the event time the Camera Logs page already
shows. Use case: forensic audit ("the matcher missed someone six
months ago — was the recogniser the same version we run today?") and
operational debugging ("did the mode flip on Tuesday change which
faces we're catching?").

### Why per-row JSONB

The `DetectorConfig` changes whenever an operator edits System
Settings → Detection. The capture worker hot-reloads via
`analyzer.update_config` rather than restart, so a single worker can
produce events under two different configs in the same minute. A
per-worker snapshot would be wrong after the first hot-reload; only
per-row capture records the truth at event time. Stored as JSONB so
v1.x can extend the field set (e.g. `pose_score` once kps land on
`Detection`) without another migration.

### What's stored

```json
{
  "detector_mode": "insightface",
  "detector_pack": "buffalo_l",
  "recognition_model": "w600k_r50",
  "det_size": 320,
  "min_det_score": 0.5,
  "insightface_version": "0.7.3",
  "onnxruntime_version": "1.19.2",
  "match_threshold": 0.45
}
```

`ultralytics_version` is added when `detector_mode == "yolo+face"`.
Versions come from `importlib.metadata` so they pick up image
rebuilds without code change.

### Implementation

* `backend/alembic/versions/0032_detection_events_metadata.py` — adds
  `detection_events.detection_metadata JSONB NULL`. Idempotent
  (`_has_column` short-circuit) so re-running per tenant via the
  orchestrator is safe.
* `backend/hadir/db.py::detection_events` — column declaration.
* `backend/hadir/detection/metadata.py` — `current_metadata(config,
  match_threshold=)` helper. Single source of truth for the snapshot
  shape.
* `backend/hadir/capture/events.py::emit_detection_event` — accepts
  `detector_config=` param. Computes metadata via the helper and
  writes it on the same INSERT. Failure to compute is logged at
  DEBUG and produces NULL — a version-probe error never sinks the
  event write.
* `backend/hadir/capture/reader.py::_analyzer_loop` — snapshots the
  worker's current detection_config under the lock and passes a
  `DetectorConfig` instance to `emit_detection_event` for every new
  track.
* `backend/hadir/detection_events/router.py::DetectionEventOut` —
  surfaces `detection_metadata: Optional[dict]`. The list query
  selects the column.
* `frontend/src/features/camera-logs/types.ts` — `DetectionMetadata`
  type + optional field on `DetectionEvent`.
* `frontend/src/features/camera-logs/CameraLogsPage.tsx` — renders
  `{detector_mode} · {detector_pack} · v{insightface_version}` in a
  dim mono caption under the timestamp; hover shows full JSON via
  `title` attribute.

### Tests

* `tests/test_capture.py::test_emit_writes_detection_metadata_when_detector_config_passed`
  — passes a `DetectorConfig` to `emit_detection_event`, asserts the
  resulting row's `detection_metadata` JSONB carries every fixed key
  with the right values; version fields are best-effort (assert
  string when present, don't pin specific versions).
* Back-compat: every existing test that omits `detector_config`
  continues to work (column stays NULL — verified by absence of
  regressions across the 544-test suite).

## Validated by

* **Layer 1 A — live recovery**: confirmed by Claude on
  `2026-04-27 15:51 UTC`. `analyzer error: ModuleNotFoundError` log
  line stopped firing. Last error timestamp: `15:44:42`. Clean since.
* **Layer 1 C — pre-flight**: confirmed by Claude on
  `2026-04-27 15:54 UTC`. `is_mode_available('insightface')=True`,
  `is_mode_available('yolo+face')=False` (ultralytics not in image).
  Pre-flight wired into the PUT handler.
* **Layer 2 — quality-gate removal**: confirmed by Claude on
  `2026-04-27 16:11 UTC`. Walk-past produced 5 detection_events rows
  in 12 s with bbox 62-66 × 75-84 (formerly rejected at the 0.35
  gate). Several rows matched to `employee_id=27` (Vedhagiri) at
  confidence 0.48-0.54; unmatched rows have `employee_id=NULL`,
  `confidence=NULL` — matcher hard-threshold logic verified.
* Backend full suite (post-Layer 3): **544 passed + 1 skipped**
  (Layer 2 swapped one test for a stronger inverted regression test;
  Layer 3 added the metadata round-trip test).
* Frontend typecheck: clean.

Awaiting Suresh's full walk-past confirmation against the live
deployment.
