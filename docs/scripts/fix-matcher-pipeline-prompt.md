# Fix: matching pipeline not running on cameras

**Status:** Bug fix during pre-Omran validation. Capture pipeline appears to detect faces but is not identifying employees against enrolled photos.

## The symptom

Two cameras have been added (inaisys tenant). Employees with reference photos have been enrolled via the UI. The Workers page (P28.8) reports the Matching pipeline stage as not working on these cameras — Detection is firing but matches against known employees aren't happening.

This is the conditional-red case the P28.8 stage logic was designed to catch:
- RTSP green (frames flowing)
- Detection green (analyzer running, faces detected)
- **Matching not green** (matcher silent or rejecting all matches)
- Attendance unknown (correctly suppressed because Matching isn't working)

Reference screenshot: `docs/scripts/issues-screenshots/01-worker_monitor_screen.jpeg`

## What the prototype proves works

The prototype in `prototype-reference/backend/` runs identification successfully across multiple cameras. The relevant files are the source of truth for how this is supposed to work:

- `prototype-reference/backend/detectors.py` — face detection + embedding generation. Returns the `embedding` field on each face dict.
- `prototype-reference/backend/known_people.py` — per-photo embedding cache. Note: per-photo embeddings, NOT averaged. Stores `(n_photos, 512)` matrices per person.
- `prototype-reference/backend/identify.py` — matches detection embeddings against the known-people cache via cosine similarity matmul.

These three files implement the full known-faces pipeline that we know works. v1.0's identification code should produce equivalent behavior.

## Most likely root causes (ordered by probability)

1. **Embedding cache not loaded into matcher.** Matcher's in-memory cache of enrolled embeddings is empty or stale. Adding employees via UI didn't trigger a cache reload.
2. **Embeddings not computed at photo upload time.** Photos got uploaded but InsightFace was never run on them. Employees appear "enrolled" but have no usable embedding.
3. **Match step missing from analyzer cycle.** Worker detects faces and writes detection_events but never calls the matcher to populate `employee_id`. P28.5b's face-save fix may have inadvertently broken this call.
4. **Match threshold too strict.** Matcher computes similarity but the threshold rejects real matches. Prototype uses ~0.4 cosine similarity; v1.0 might be at 0.7+.
5. **Enrolled employees marked inactive.** P28.7's inactive-employee logic correctly skips matching for inactive employees. If test employees got accidentally inactive, this would happen.
6. **Tenant scoping mismatch.** Matcher loads embeddings for one tenant but worker processes frames under a different tenant context.

---

## The prompt to paste into Claude Code

> A bug in Maugood's matching pipeline: faces are being detected on cameras, but employees with enrolled reference photos are not being identified. The Workers page (from P28.8) shows the Matching stage as red/amber even though Detection is green and the inaisys tenant has employees with reference photos enrolled.
>
> Read these files completely before diagnosing:
>
> 1. `docs/scripts/issues-screenshots/01-worker_monitor_screen.jpeg` — the failing state observed
> 2. `prototype-reference/backend/detectors.py` — particularly the function that produces the `embedding` field on each detected face
> 3. `prototype-reference/backend/known_people.py` — `KnownPeopleCache.reload()` and the per-photo (not averaged) embedding storage pattern
> 4. `prototype-reference/backend/identify.py` — the matching algorithm itself, the threshold value, the matmul approach
> 5. `backend/maugood/identification/` — v1.0's matching code. Whatever exists here is the broken thing.
> 6. `backend/maugood/employees/photos.py` (or wherever photo upload lives) — verify whether embedding computation happens at upload
> 7. `backend/maugood/capture/worker.py` — find the analyzer cycle, see whether/where it calls the matcher
> 8. `backend/maugood/capture/events.py` — verify whether matcher result populates `employee_id` on `detection_events`
>
> ### Diagnose first — do NOT fix blindly
>
> Run these diagnostic queries against the inaisys tenant database and **paste the findings before changing any code**. The fix depends on which of the six failure modes is actually occurring.
>
> **Diagnostic 1: are detection_events rows getting employee_id populated?**
> ```sql
> SELECT id, captured_at, camera_id, employee_id, former_employee_match, confidence
> FROM tenant_inaisys.detection_events
> ORDER BY captured_at DESC
> LIMIT 20;
> ```
> Three patterns to spot:
> - All `employee_id IS NULL` and `former_employee_match=false` → matcher never matched anything (most likely root cause)
> - Some `former_employee_match=true` → matcher matched but those employees flagged inactive
> - `confidence` populated but `employee_id` still NULL → matcher computed similarity but threshold rejected
>
> **Diagnostic 2: do enrolled employees actually have embeddings?**
> ```sql
> SELECT e.id, e.employee_code, e.full_name, e.status,
>        COUNT(p.id) AS photo_count,
>        SUM(CASE WHEN p.embedding IS NOT NULL THEN 1 ELSE 0 END) AS embeddings_present
> FROM tenant_inaisys.employees e
> LEFT JOIN tenant_inaisys.employee_photos p ON p.employee_id = e.id
> GROUP BY e.id, e.employee_code, e.full_name, e.status
> ORDER BY e.id;
> ```
> If any row has `photo_count > 0` but `embeddings_present = 0`, the embedding-at-upload step is broken. Adjust column names if v1.0 uses different naming.
>
> **Diagnostic 3: how many embeddings does the matcher cache have loaded right now?**
> Add a temporary log line in the matcher (or expose via a debug endpoint) showing `cache.embeddings_count` per tenant. Compare to Diagnostic 2's count. If matcher has 0 but DB has them → matcher hasn't been told to load. If matcher has them but no matches happen → threshold or similarity logic is the bug.
>
> **Diagnostic 4: trace the analyzer cycle in worker.py.**
> After a face is detected, what happens? Does the code path call the matcher at all? If yes, what's the matcher's output? If no — the bug is "matcher never called from worker."
>
> **Diagnostic 5: tenant scoping check.**
> Confirm the worker for inaisys cameras is loading inaisys's embeddings, not mts_demo's. The matcher cache should be keyed by tenant_id.
>
> **Stop here and report findings before applying any fix.**
>
> ### Once diagnosed, the fix shape depends on which root cause is real
>
> **Cause 1: matcher cache empty/stale**
> Add a `MatcherCache` class modeled on prototype's `KnownPeopleCache`. Per-tenant. Loaded at backend startup AND reloaded on:
> - New employee created
> - Employee photo added/deleted
> - Employee status changed (active ↔ inactive)
> - Employee hard-deleted
>
> Use the prototype's matrix-stacking approach: `(total_photos, 512)` matrix where `names_per_row[i]` tells which employee that row belongs to. One matmul per detection — fast.
>
> **Cause 2: embeddings not computed at upload**
> Port the embedding-computation step from `known_people.py:KnownPeopleCache.reload()`. When a photo uploads:
> 1. Load image with cv2
> 2. Run InsightFace `app.get(img)` to get face detections
> 3. If 0 faces detected, **reject the upload** with a clear error to the user — don't silently store a useless photo
> 4. If multiple faces, pick the largest
> 5. Extract `normed_embedding`, store as `bytea` (or numpy float32 serialized) on `employee_photos.embedding`
>
> **Cause 3: matcher not called from analyzer**
> In the analyzer cycle, after detection produces a `face` dict with `embedding`, call `matcher.match(tenant_id, face['embedding'])`. The matcher returns `{employee_id: int|None, confidence: float, former_employee: bool}`. Pass these through to the detection_events INSERT.
>
> **Cause 4: threshold too strict**
> Prototype's typical threshold is 0.4 cosine similarity (matched faces score 0.5–0.9; unrelated faces score 0.0–0.3). If v1.0 uses 0.7+ it'll reject real matches. Log a histogram of recent similarity scores to confirm. Tune to 0.4, document the rationale.
>
> **Cause 5: employees inadvertently inactive**
> Verify `employees.status` for the test users. If active is correct, fix data; if logic is wrong, fix code.
>
> **Cause 6: tenant scoping**
> Per-tenant cache key. Worker passes its tenant_id to matcher.
>
> ### Fix invariants — these must all hold after the fix
>
> 1. **Photo upload → embedding stored.** Every `employee_photos` row with a valid image also has an embedding. Uploads with no detectable face are rejected.
> 2. **Matcher cache reflects current state.** New employees and photo changes apply within ~10 seconds without backend restart.
> 3. **Analyzer always calls matcher.** Every detection_events row gets matched. Result populates `employee_id` (active match), `former_employee_match=true` (inactive match), or both NULL/false (genuine unknown).
> 4. **Tenant scoping holds.** mts_demo employees never match against inaisys faces or vice versa.
> 5. **Threshold tuned per prototype.** 0.4 cosine similarity unless explicitly tuned higher with documented rationale.
> 6. **Workers page Matching stage turns green** within minutes of a real match.
>
> ### Add diagnostic endpoint to catch this class of bug at next site
>
> Per-tenant matcher health check at `GET /api/operations/matcher-health` (Admin only):
> ```json
> {
>   "tenant_id": ...,
>   "embeddings_loaded": 12,
>   "employees_with_photos": 12,
>   "employees_without_photos": 3,
>   "last_cache_reload_at": "...",
>   "recent_match_count_60s": 5,
>   "recent_match_avg_confidence": 0.74,
>   "recent_unknown_count_60s": 2
> }
> ```
>
> Wire into the Workers page so each camera's Matching stage card can show "matcher loaded N embeddings, last successful match Xs ago" — turns the diagnosis-by-SQL workflow into a one-click drill-down.
>
> ### Tests
>
> `backend/tests/test_matcher_pipeline.py`:
> - Upload photo of person A, submit frame containing person A → `employee_id` populates correctly
> - Upload photo of person A, submit frame containing person B → `employee_id IS NULL`, no false positive
> - Mark employee inactive, submit their face → `former_employee_match=true`, `employee_id IS NULL`
> - Cross-tenant: upload photo to inaisys, submit frame under mts_demo context → no match
> - Photo with no detectable face → upload rejected, not silently stored
> - Matcher cache reload triggers correctly on photo add/delete/status-change
>
> ---
>
> ### 🚦 VALIDATION MILESTONE
>
> #### Setup
> 1. `docker compose restart backend`
>
> #### Diagnostic confirmation
> 2. Run all five diagnostic queries above. Paste output. Confirm which root cause was actually broken.
>
> #### Photo upload → embedding
> 3. Add a new test employee in inaisys, upload a photo. Verify `employee_photos.embedding` is non-null.
> 4. Try uploading a photo with no face (e.g. a landscape) — must be rejected with clear error.
>
> #### Matcher cache loaded
> 5. `GET /api/operations/matcher-health` as inaisys Admin. Confirm `embeddings_loaded` matches enrolled employee count from Diagnostic 2.
>
> #### End-to-end matching
> 6. Walk past inaisys camera as a test employee.
> 7. Within 10 seconds:
>    ```sql
>    SELECT id, captured_at, employee_id, confidence
>    FROM tenant_inaisys.detection_events
>    ORDER BY captured_at DESC LIMIT 1;
>    ```
>    `employee_id` populated. `confidence > 0.4`.
>
> #### Workers page reflects the fix
> 8. Open Workers page. Within 30 seconds of walk-past, Matching stage turns green with "Last match Xs ago".
> 9. Attendance stage turns green within an hour as engine writes attendance_records.
>
> #### Negative tests
> 10. Walk past as someone not enrolled. detection_events row exists, `employee_id IS NULL`. Workers Matching stage stays green (matched correctly to unknown).
> 11. Mark a test employee inactive. Walk past. `former_employee_match=true`, `employee_id IS NULL`. Camera Logs shows "Former employee" badge.
>
> #### Tenant isolation
> 12. With both tenants enrolled: inaisys employee walking past inaisys camera matches inaisys; same face under mts_demo camera does NOT match.
>
> #### Sign-off
>
> Append to `docs/phases/fix-matcher-pipeline.md`:
>
> ```
> ## Fix: matcher pipeline not identifying enrolled employees
>
> Diagnosed root cause: <which of the 6 causes above>
>
> Validated by Suresh on <date>:
> - Photo upload computes and stores embedding ✓
> - Photo with no face is rejected ✓
> - Matcher cache loaded with correct count ✓
> - Cache reloads on employee/photo changes ✓
> - Walk-past enrolled employee → employee_id populated ✓
> - Walk-past unknown → no false positive ✓
> - Inactive employee → former_employee_match=true ✓
> - Tenant isolation holds ✓
> - Workers page Matching stage green ✓
> - /api/operations/matcher-health works ✓
> ```
>
> Commit as `fix: matcher pipeline + embedding-at-upload + matcher-health endpoint`. Stop and show Suresh.

---

## Why this is worth fixing carefully

The matcher is the core of Maugood's value. Without it, Maugood is a fancy face-detection logger, not an attendance system. The prototype proves the algorithm works — the bug is in how v1.0 wired it up. Find the actual broken wire, fix that one wire, don't rewrite the algorithm.

The diagnostic-first approach produces the matcher-health endpoint as a side benefit. That's the operational visibility that catches this class of bug at Omran's site before HR notices missing attendance a week later.
