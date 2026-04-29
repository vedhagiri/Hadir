# Pre-Omran validation checklist

**Audience:** Suresh.
**When:** after `backend/scripts/pre_omran_reset_seed.py` has run
cleanly and `credentials.txt` exists at the repo root.
**Goal:** walk every v1.0 feature end-to-end with two distinct
tenants — the synthetic `tenant_mts_demo` and your real
corporate office — before Omran sees the build.

This is the playbook to run **once per validation pass**. Each
section is a numbered checklist you tick off; problems land in
§14 "Pre-Omran issues" at the bottom for the cutover fix list.

---

## 0. How to use this doc

1. Run the seed script first:
   ```sh
   cd /opt/maugood   # or your local checkout
   $EDITOR backend/scripts/pre_omran_reset_seed.py    # set the 3 constants
   docker compose up -d
   docker compose exec backend python -m scripts.pre_omran_reset_seed
   ```
   When the script prints `Credentials written to …/credentials.txt`,
   open that file. Keep it in a side window — every section
   below references logins you'll find there.

2. Walk each section in order. Tick the boxes as you go. **Don't
   skip a section** — they build on each other (e.g. §3 needs
   the policies seeded in §2 to be present).

3. When something doesn't behave as expected:
   - Note it under §14 "Pre-Omran issues" with **page**,
     **action**, **expected**, **actual**, **severity**.
   - Don't try to fix it in this pass. Validation first; fixes
     before the next pass.

4. After §13 is green, this pass is done. Show the doc to the
   team or schedule the next pass after fixes land.

---

## 1. Bootstrap check

- [ ] `credentials.txt` exists at repo root.
- [ ] `git check-ignore credentials.txt` returns the path (i.e.
      file is gitignored — the seed script verifies this before
      writing, but confirm by hand).
- [ ] Open `https://localhost` (or the dev frontend at
      `http://localhost:5173` depending on stack) in a
      Chrome/Firefox window.
- [ ] Navigate to `/super-admin/login`. Log in as
      `superadmin@mts.test` from `credentials.txt`.
- [ ] Both `tenant_mts_demo` AND your real corporate tenant are
      visible on the tenants list with non-zero employee counts
      (real corporate has 1 employee until you add more).

---

## 2. Demo tenant — multi-feature smoke

Two browser windows side-by-side help here. Window A logged
into the demo tenant; window B logged into the real corporate
tenant; visually compare branding and behaviour.

- [ ] Log out of Super-Admin. Log into `tenant_mts_demo` via
      `/login` as **Admin** (`admin@mts-demo.test`).
- [ ] Sidebar shows the full Admin nav (every section visible).
- [ ] Branding renders **plum accent + Plus Jakarta Sans font**
      across topbar / buttons / sidebar — visibly distinct from
      the default teal/Inter.
- [ ] Log out, log in as **HR** (`hr@mts-demo.test`). Sidebar
      drops Admin-only items (Audit Log, System, Cameras,
      Manager Assignments, Custom Fields, Branding,
      Authentication settings).
- [ ] Log in as **Manager Eng** (`manager.eng@mts-demo.test`).
      Sidebar smaller still — Approvals, Daily Attendance,
      Reports, Dashboard.
- [ ] Log in as **Employee Eng** (`dawud.al-farsi@mts-demo.test`).
      Smallest sidebar — My Attendance, My Requests, Profile,
      Dashboard.

---

## 3. Demo tenant — policy & attendance

- [ ] Log in as Admin → **Settings → Shift Policies**. Confirm
      all four policies present: `Office Default` (Fixed),
      `Flex Engineers` (Flex), `Ramadan 2026` (Ramadan,
      18 Feb – 19 Mar 2026), `Half-day Friday` (Custom, the
      next upcoming Friday).
- [ ] **Policy Assignments** → tenant default points at
      `Office Default`; Engineering department points at
      `Flex Engineers`.
- [ ] **Settings → Leave & Calendar → Holidays** → 12 holidays
      seeded (Oman 2026 set + New Year + Renaissance Day).
- [ ] **Settings → Leave & Calendar → Leave Types** → 7 types
      (Annual / Sick / Emergency / Unpaid + Maternity /
      Paternity / Bereavement).
- [ ] **Custom Fields** → 3 fields (Badge Number / Contract
      Type / Joining Date). The select shows
      Permanent/Contract/Intern.
- [ ] Trigger a manual attendance recompute via the dev test
      endpoint (or wait for the 15-minute scheduler):
      ```sh
      docker compose exec backend python -c \
          "from maugood.attendance.scheduler import recompute_today; \
           from maugood.tenants.scope import TenantScope; \
           from maugood.db import tenant_context; \
           import sys; \
           with tenant_context('tenant_mts_demo'): \
               print(recompute_today(TenantScope(tenant_id=2, tenant_schema='tenant_mts_demo')))"
      ```
      Expected: a non-negative integer (likely 0 since no
      detection events are seeded — the run completes without
      error, that's the green signal).
- [ ] Spot-check policy resolution: in Settings → Shift
      Policies, click `Flex Engineers` → "Assigned employees" →
      should list the 8 ENG employees. `Office Default` →
      should list the other 17 + the honeypot.

---

## 4. Demo tenant — approval workflow

Use **Employee Eng** (`dawud.al-farsi@mts-demo.test`) as the
submitter for all paths. Use credentials.txt to find each
password.

- [ ] **Happy path (Manager + HR approve):**
  - [ ] Log in as Employee Eng → My Requests → New Request.
  - [ ] Type: Exception. Reason: "Doctor". Date: today. Reason
        text: "Smoke test — happy path".
  - [ ] Submit. Status shows `submitted`.
  - [ ] Log in as Manager Eng → Approvals → see the pending row.
  - [ ] Approve with a comment. Status flips to
        `manager_approved`.
  - [ ] Log in as HR → Approvals → see the row → approve. Status
        `hr_approved`.

- [ ] **Reject path (Manager rejects, terminal):**
  - [ ] Employee Eng submits another request.
  - [ ] Manager Eng rejects with comment. Status
        `manager_rejected`.
  - [ ] Log in as HR → request should NOT appear in inbox.
  - [ ] Log in as Admin → Approvals → "All" tab → see it with
        the `manager_rejected` stage label.

- [ ] **Admin override:**
  - [ ] Employee Eng submits a third request.
  - [ ] Manager Eng rejects.
  - [ ] Log in as Admin → Approvals → click the request → click
        "Override".
  - [ ] Modal demands a 10-char minimum comment + decision.
        Type "Override for testing — pre-Omran validation pass."
        and pick Approve.
  - [ ] Status flips to `admin_approved` and the timeline says
        "⚠ Overridden by admin".

- [ ] **Cross-department invisibility:**
  - [ ] Log in as **Manager Ops** (`manager.ops@mts-demo.test`).
  - [ ] Approvals inbox should NOT show any Engineering
        employee's requests.
  - [ ] Try to POST `/api/requests/<id-from-Eng>/manager-decide`
        directly via curl — expect `403`.

---

## 5. Demo tenant — reports

- [ ] Log in as HR → Reports.
- [ ] Generate **Excel** for the last 7 days. File downloads.
      Open it; sheet named by ISO week (e.g. `2026-W17`); rows
      include the 25 employees.
- [ ] Generate **PDF** for the same range. File downloads. Open;
      tenant-branded letterhead in plum; one section per
      employee with daily rows.
- [ ] **Settings → Schedules** → New schedule. Pick "Weekly,
      Sunday 06:00", recipients = your own email, format Excel.
      Save.
- [ ] Click "Run now" on the schedule.
- [ ] Verify the email arrives (configure SMTP in
      Settings → Email if you haven't already — the seeded
      ``email_config`` row is empty by design).

---

## 6. Demo tenant — Arabic + RTL

- [ ] Topbar → Language switcher → العربية.
- [ ] Page reloads in Arabic with `dir="rtl"` on `<html>`.
      Sidebar slides in from the right; chevrons + arrows flip
      direction; the "Display" + "Notifications" dropdowns
      anchor to the inset-end (left in RTL).
- [ ] Click through every page in the sidebar. Verify nothing
      lays out broken — no overflow, no clipped text, no
      mirrored layout artefacts.
- [ ] Open a notification → text is in Arabic (the
      notification producer pulls per-recipient
      `preferred_language`).
- [ ] Note any obvious mistranslations in §14 — Omran HR
      review of the Arabic strings is **still pending** per
      `docs/phases/P21.md`. Some awkward phrasing is expected
      until that pass.

---

## 7. Cross-tenant isolation

This is the load-bearing red line — keep two windows open and
compare aggressively.

- [ ] Window A: log in as Demo Admin. Window B: log in as your
      real-corp Admin.
- [ ] In A: Employees → search "Test Crossover". One result
      (`DEMO0099`).
- [ ] In B: Employees → search "Test Crossover". **Zero
      results.** If anything appears, that's a P0 isolation
      bug.
- [ ] In A: copy any employee's URL from the address bar
      (`/employees/<id>`). Paste into B, prefix with the real-
      corp host. Expect 404 or 403. Never the row.
- [ ] Repeat for `/api/employees/<id>` via curl with B's
      cookie. Expect 404/403.

---

## 8. Real corporate tenant — camera setup

- [ ] Log in as real-corp **Admin**.
- [ ] **Cameras** page → see the placeholder row "Office
      Camera 1" (location: Reception, disabled).
- [ ] Click Edit → enter your real RTSP URL (e.g.
      `rtsp://user:pass@192.168.1.x:554/stream1`).
- [ ] Toggle Enabled → Save.
- [ ] Click Preview → a JPEG frame returns within 5s. If you
      get "preview timed out", verify the camera is on the
      same network as the docker host.
- [ ] **Red-line check** — SSH to the dev box and run:
      ```sh
      docker compose logs backend | grep -E 'rtsp://[^[:space:]]*:[^@]*@'
      docker compose logs backend | grep '<your-actual-password>'
      ```
      Both should return **zero lines**. If either leaks the
      password — P0.
- [ ] Camera Logs (after a minute or two) → reachable=true on
      `Office Camera 1`.

---

## 9. Real corporate tenant — face enrollment

- [ ] Pick a clear front-facing photo of yourself
      (`<UPPER(SLUG)>0001`). 800px+ short side, JPEG/PNG.
- [ ] **Employees** → click `<UPPER(SLUG)>0001` → drag the
      photo into the photo zone with angle = front.
- [ ] Wait ~10s. The photo gallery shows the thumbnail.
- [ ] Verify the embedding generated:
      ```sh
      docker compose exec backend python -c \
          "from maugood.db import get_engine, employee_photos, tenant_context; \
           from sqlalchemy import select; \
           with tenant_context('<tenant_schema>'): \
               with get_engine().begin() as c: \
                   r = c.execute(select(employee_photos.c.id, \
                       employee_photos.c.embedding).limit(1)).first(); \
                   print('photo id=', r.id, 'has embedding:', r.embedding is not None)"
      ```
      Expected: `has embedding: True`.
- [ ] Walk past the camera within view of `Office Camera 1`.
      Wait ~30s.
- [ ] **Camera Logs** → see your detection event with your
      employee_code identified, confidence > 0.5.

---

## 10. Real corporate tenant — full attendance flow

- [ ] Trigger a manual recompute (same one-liner as §3,
      pointed at your real-corp schema).
- [ ] **Daily Attendance** for today → see your
      `<UPPER(SLUG)>0001` row with `in_time` = your first
      detection's local time.
- [ ] Walk past the camera again 30+ minutes later.
- [ ] Re-run the recompute. `out_time` should now reflect the
      latest detection.

---

## 11. Real corporate tenant — generate report

- [ ] **Reports** → Excel for today only. Download.
- [ ] Open the file; one row for `<UPPER(SLUG)>0001` with
      your in/out times.
- [ ] Same for PDF.

---

## 12. Audit log spot-check

- [ ] Log in as Admin in **demo tenant** → **Audit Log**.
      Confirm rows for: every approval transition from §4,
      every report generation from §5, the language switch
      from §6.
- [ ] Same in **real-corp tenant** → rows for the camera edit,
      photo upload, and report generation.
- [ ] Verify the Super-Admin "Access as" rows from §1 appear
      with `actor_label='super_admin'` (or similar — the P3
      column).
- [ ] Spot the seed rows: `actor_label='system_seed'` rows
      from when this script ran. They should be visible to
      the tenant Admin (not hidden) — that's the
      transparency we want.

---

## 13. Database isolation spot-check

Run the §7 SQL queries from
`docs/testing/v1.0-m2-test-accounts.md`:

- [ ] Schemas: `public`, `tenant_mts_demo`, `tenant_<your-slug>`
      present (no `tenant_omran` — Omran provisions at P29).
- [ ] User counts: ~12 in demo (Admin + HR + 5 dept managers +
      matrix + dual + 5 employee logins), 4 in real-corp.
- [ ] Password hashes start with `$argon2id$v=19$…`. **Never
      plaintext.**
- [ ] `maugood_app` has INSERT+SELECT only on `audit_log`:
      ```sql
      SELECT grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_name = 'audit_log' AND grantee = 'maugood_app';
      ```
      Two rows, both INSERT or SELECT. No UPDATE, no DELETE.

---

## 13a. Live Capture (P28.5a)

Sidebar nav: **Live capture · LIVE**. Verify the viewer +
event stream behave correctly across both tenants.

P28.5a refactored the capture worker onto a two-thread design
(reader at native fps + analyzer at ≤6 fps with motion-skip)
and re-keyed the manager's worker dict by
``(tenant_id, camera_id)``. The frame buffer was deleted and
the per-camera ``latest_jpeg`` lives on the worker now. None of
the user-facing checks below changed shape — the steps still
pass on the old behaviour and the new — but a few are sharper
on the new design (motion-skip means a quiet camera shows ~0%
analyzer load; the preview should feel ≤500 ms latency on a
LAN camera). Watch for "perceived latency" specifically.

- [ ] Sidebar brand chip reads **v1.0** (not `v0.1`). Source
      is `frontend/src/config.ts`; if it says `v0.1` either
      the backend container has stale build artefacts or
      `package.json` was reverted — check both.

- [ ] **Demo tenant — empty viewer state.** Log in as
      `admin@mts-demo.example.com`. Open Live Capture. Page
      renders with the empty viewer ("Select a camera to
      begin"), camera list on the right, and an empty event
      stream below.

- [ ] **Demo tenant — fake-RTSP cameras stay offline.** Click
      any of the 8 mts_demo cameras. Viewer transitions to
      "Camera offline" within ~12 s (2 s cold-start grace +
      10 s idle bail). The capture worker is failing the RTSP
      open silently; that's correct behaviour for placeholder
      URLs, not a bug.

- [ ] **Real corporate tenant — live face detection.** Log
      out, log in as `admin@inaisys.local`. Open Live Capture.
      Click "Office Camera 1". The MJPEG starts within ~2 s.
      Walk past the camera. Your face appears with a bounding
      box (green if your photo is enrolled, amber if not).
      Box label reads "{Name} · {N}%" (or "Unknown").

- [ ] **Event stream populates.** As detections fire, rows
      appear at the top of the event-stream table with a
      brief fade-in. Each row carries a time, the camera id,
      identified or "Unknown face", a confidence percentage,
      and a status pill.

- [ ] **Pause holds the viewer; events keep flowing.** Click
      Pause. The video freezes (the `<img>` src is cleared).
      Walk past the camera again — the viewer stays paused,
      but new rows still appear in the event-stream table
      because the WebSocket stays open.

- [ ] **Resume re-fetches.** Click Resume. Within ~2 s the
      viewer is live again.

- [ ] **Reconnect button.** Click Reconnect. Brief
      "Reconnecting…" overlay appears at the bottom-left of
      the viewer; within a few seconds the stream is back
      and the WebSocket has re-opened.

- [ ] **Two-tab sharing.** Open Live Capture in two tabs of
      the same browser, both pointed at the same camera.
      Both stream successfully. In `docker compose logs
      backend`, confirm only ONE capture worker is running
      for that camera (search for
      `capture worker started for camera id=`). The frame
      buffer is shared.

- [ ] **Concurrency cap.** Open the same camera in 11 tabs.
      The 11th tab's request to `/api/cameras/{id}/live.mjpg`
      returns **503**. Closing one of the earlier tabs frees
      a slot — the 11th can re-load and succeed.

- [ ] **Manager 403.** Log in as a Manager
      (`manager.eng@mts-demo.example.com`). Hit `/live` in
      the URL bar. The router-level role guard returns 403
      (or the page renders the error state — both acceptable;
      sidebar doesn't expose `/live` to Manager).

- [ ] **Anonymous 401.** Log out. Hit
      `/api/cameras/1/live.mjpg` directly. **401**.

- [ ] **Cross-tenant 404.** Logged in as the mts_demo Admin,
      run `curl -b cookies.txt http://localhost:8000/api/cameras/<inaisys_camera_id>/live.mjpg`
      with an inaisys camera id (look it up via
      `psql … 'SELECT id FROM tenant_inaisys.cameras'`).
      **Must return 404.** If it streams the inaisys camera's
      frames, **STOP** — that's a P0 cross-tenant leak.

- [ ] **Audit volume sane.** Stream for one minute, then
      `psql -U maugood -d maugood -c "SELECT action, count(*) FROM
      tenant_inaisys.audit_log WHERE action LIKE
      'live_capture%' AND created_at > now() - interval '5
      minutes' GROUP BY 1 ORDER BY 1"`. Expected: one
      `live_capture.mjpg.subscribed` per stream open, one
      `…unsubscribed` per close, one `events.subscribed` and
      `events.unsubscribed` per WebSocket cycle. **No
      per-frame audit rows** (the audit log would explode if
      we wrote per frame).

- [ ] **(P28.5a) Perceived latency under 500 ms.** Wave your
      hand briefly and count the seconds until the box+frame
      reflect it. Anything above ~0.5 s on a LAN camera
      indicates the reader thread is bottlenecked — file a
      P0. The two-thread design's whole point is to make this
      snappy.

- [ ] **(P28.5a) Quiet-camera CPU near zero.** Point the camera
      at an empty wall for 30 s. `docker stats maugood-backend-1`
      should show the backend container's CPU drop to near
      idle (<5%). Then walk past — CPU jumps. Motion-skip
      working as intended.

- [ ] **(P28.5a) Multi-camera concurrency.** Add a second
      enabled camera (same RTSP URL is fine for the test —
      different name). Open Live Capture, switch between
      cameras. Both should produce events independently in
      Camera Logs. In `docker compose logs backend | grep
      "capture worker started"` you should see TWO worker
      starts (one per camera), and `mgr.active_camera_ids()`
      via the dev REPL would return both ids. Each camera's
      worker reads at native fps independently.

---

## 13b. Capture knobs (P28.5b)

P28.5b added the worker / display split + per-camera capture
knobs. Verify on the running stack with at least one real
camera (Office Camera 1 / Giri Home).

- [ ] **Drawer renders new fields with default values.**
      Open Cameras → click any camera. The drawer shows two
      new toggle rows ("Capture worker" and "Live preview")
      plus an expandable "Capture settings" panel (max faces
      per event, max event duration, min face quality slider,
      save full annotated frames toggle).

- [ ] **Worker disable.** Toggle Capture worker OFF, click
      Save. Within 5 s, `docker compose logs backend` shows
      `capture worker stopped: tenant=… camera_id=…`. Walk
      past the camera — NO new entry in Camera Logs (worker
      not recording). Live Capture page lists this camera at
      the bottom of the list with the "Worker disabled"
      label + tooltip.

- [ ] **Worker re-enable.** Toggle Capture worker ON, save.
      Within 5 s, `capture worker started: tenant=… camera_id=…`.
      Walk past the camera — new event in Camera Logs.

- [ ] **Display disable (worker stays on).** Toggle Live
      preview OFF, save. Walk past — Camera Logs DOES gain a
      new entry (worker still recording). Live Capture page
      shows the camera in the main list but greyed; clicking
      it shows the "Display disabled by Admin" empty state,
      not video.

- [ ] **Display re-enable.** Toggle Live preview ON, save.
      Live Capture works again.

- [ ] **Knob test — max_faces_per_event.** Edit the camera:
      set max_faces_per_event = 1, save. Walk past multiple
      times. Each event in Camera Logs shows exactly 1 face
      crop. (Note: P28.5b's single-row-per-track architecture
      means default 10 also yields 1 crop per event; the
      multi-face follow-up phase ships separately.)

- [ ] **Knob test — min_face_quality_to_save.** Set the
      slider to 0.8 (very strict), save. Walk past at a sharp
      angle (low pose score). Camera Logs shows fewer events
      overall vs. the default 0.35 threshold. Reset to 0.35.

- [ ] **Audit log.** Navigate to Audit Log. Each toggle and
      each `capture_config` edit appears with action
      `camera.updated`; the row's `before` and `after` JSONB
      carry the full pre/post state. Reconcile-driven config
      updates appear as `capture.worker.config_updated` with
      before + after JSONB.

- [ ] **Tenant isolation.** Log in as the mts_demo Admin.
      The Cameras list does NOT show inaisys cameras; the
      Live Capture page doesn't list them either. Optionally
      `psql … 'SELECT id, name, capture_config FROM
      tenant_inaisys.cameras'` confirms inaisys still has its
      own settings — the mts_demo edit didn't touch them.

- [ ] **Reconcile loop running.** `docker compose logs
      backend | grep "_reconcile_tick" | tail -3` shows a
      tick firing every ~2 seconds with
      `executed successfully`.

---

## 13c. Attendance Calendar (P28.6)

Open <http://localhost:5173/calendar> as the demo Admin.

- [ ] **Company tab loads.** Default month is the current
      one. The grid shows ~30 cells; weekend cells (Fri/Sat
      in the demo tenant) render with the `status-weekend`
      tinted class; any seeded holidays show
      `status-holiday` + their name.
- [ ] **Per-person tab.** Switch tabs, type a few letters
      into "Search employee" — the dropdown filters in
      real time. Pick an employee.
- [ ] **Day-detail drawer.** Click a present day. Drawer
      slides in with employee header, status pill,
      In/Out/Total/Overtime tiles, day timeline ribbon
      (one bar per detection cluster), policy applied
      panel, and up to 5 evidence crops (lazy-loaded via
      `/api/detection-events/{id}/crop`).
- [ ] **Evidence is empty for absent / weekend / holiday
      cells.** Drawer renders the "no face crops" hint.
- [ ] **Submit exception.** Drawer's "+ Submit exception"
      button opens the existing P14 NewRequestDrawer
      pre-filled with `type=exception` + the day's date.
- [ ] **Export.** Drawer's "Export" link downloads
      `maugood-attendance-{code}-{date}.xlsx`. Page-level
      "Export month" downloads either the per-person
      month or the company aggregate.
- [ ] **Manager scope.** Log in as a Manager assigned to
      one department. Company tab's `active_employees`
      reflects only their visible employee union (not the
      tenant headcount). Per-person view of an
      out-of-scope employee returns 404 (page shows the
      "Could not load calendar" hint).
- [ ] **Employee scope.** Log in as the Employee user.
      Tab strip is hidden. The page auto-locks to their
      own employee row.
- [ ] **Cross-tenant isolation.** As demo Admin,
      `curl -b cookies.txt
      "http://localhost:8000/api/attendance/calendar/person/999999?month=2026-04"`
      returns 404 with `{"detail":"employee not found"}`.
- [ ] **Arabic.** Switch language to العربية. Every label
      (tabs, month picker, status pills, drawer headers,
      weekday strip) renders right-to-left in Arabic. No
      hard-coded English leaks.
- [ ] **Audit log.** Page-level Export creates one
      `attendance_calendar.exported` row;
      day-detail open creates one
      `attendance_calendar.day_viewed` row. List views
      do **not** audit (would flood).

---

## 13d. Employee management + lifecycle (P28.7)

Use the **inaisys** tenant for this whole block (real-camera testing
requires the corporate tenant's connected RTSP stream). Switch to
mts_demo only for the cross-tenant isolation steps at the end.

### Setup
- [ ] `docker compose down && docker compose up --build`
- [ ] Migration runs cleanly:
      `docker compose exec backend python -m scripts.migrate`
- [ ] Confirm new columns exist on `tenant_inaisys.employees` and
      `tenant_inaisys.detection_events`. Confirm
      `tenant_inaisys.delete_requests` table exists.

### Add new employee
- [ ] Log in as admin@inaisys.local. Employees → Add employee.
- [ ] Fill all fields: code, name, designation, phone, reports_to
      (pick from list), join_date today, relieving_date next year,
      shift policy, status active.
- [ ] Save. New row appears in list with all data populated.

### Edit existing employee
- [ ] Click pencil on the new employee. Drawer opens with all data.
- [ ] Change designation, save. Audit log shows the change with
      before/after.

### Photo upload integration (existing P6 flow)
- [ ] In Edit drawer, upload 3 reference photos. Save.
- [ ] Walk past camera. `detection_events` row has `employee_id`
      populated for this person.

### Inactive flow
- [ ] Edit employee, toggle Active off. Inline reason textarea
      appears, mandatory.
- [ ] Try to save without reason → form blocks, shows error.
- [ ] Add reason "Test deactivation", save. Drawer updates:
      "Inactive" badge, deactivation reason shown, deactivated_at
      populated.
- [ ] Walk past camera as this person. Within 30 seconds, check
      `detection_events`:
      ```sql
      SELECT id, employee_id, former_employee_match, captured_at
      FROM tenant_inaisys.detection_events
      ORDER BY captured_at DESC LIMIT 5;
      ```
      Latest row must have `employee_id IS NULL AND
      former_employee_match=true`.
- [ ] Daily Attendance for today → this employee does NOT show as
      Present (because they're inactive).
- [ ] Camera Logs → recent event for this person shows with red
      "Former employee" badge.

### Reactivate
- [ ] Edit employee, toggle Active back on. Reason field hides.
      Save.
- [ ] Walk past camera. Latest `detection_events` row has
      `employee_id` populated again, `former_employee_match=false`.

### Admin → HR delete approval flow
- [ ] As Admin, click delete on an employee. Modal: "Submit delete
      request to HR". Mandatory reason. Submit.
- [ ] Row in employee list shows "Pending deletion" badge.
- [ ] HR (hr@inaisys.local) logs in. Approvals → Delete requests
      tab. The pending request is there.
- [ ] HR clicks Approve. Row disappears from approvals queue.
      Employee no longer appears in employees list. Their face
      crops on disk are gone (verify with
      `ls /data/faces/{tenant_id}/{code}/`).
- [ ] Walk past camera as the deleted person. Detection event
      created but neither matched nor flagged former — they're
      now genuinely Unknown (matcher cache no longer contains
      their embeddings).

### HR self-delete
- [ ] HR clicks delete on a different employee. Modal: confirm.
      Submit. Employee deleted immediately (no further approval).

### Admin override
- [ ] As Admin, submit a delete request for another employee. As a
      different Admin (create one if needed), open the Edit drawer
      for that pending employee. "Override and approve" button
      visible.
- [ ] Click Override. Modal: mandatory 10+ char comment. Submit.
      Employee deleted. Audit log shows
      `delete_request.admin_override_approve` entry.

### Joining date future
- [ ] Add employee with joining_date = +30 days. Save.
- [ ] Walk past camera as that person. Daily Attendance: no row
      generated for this employee for today.
- [ ] `detection_events` row exists but `employee_id` is NULL.

### Relieving date cron
- [ ] Edit an employee, set relieving_date = yesterday. Save.
      Status still active immediately.
- [ ] Trigger the lifecycle cron manually:
      `docker compose exec backend python -m scripts.run_lifecycle_cron`
- [ ] Reload employee list. Employee is now Inactive with
      deactivation_reason "Auto-deactivated: relieving_date
      reached". Audit log shows `employee.auto_deactivated`.

### Former employees report
- [ ] Reports → Former employees seen. Date range last 7 days.
      Verify deactivated employee's detections appear in the
      report.
- [ ] Export XLSX. Opens cleanly.

### XLSX import
- [ ] Import a small XLSX with the new columns
      (`designation`, `phone`, `reports_to_email`, `joining_date`,
      `relieving_date`). Verify all fields persist.
- [ ] Import an XLSX with `relieving_date` < `joining_date` →
      row error in preview.

### Cross-tenant isolation
- [ ] As mts_demo Admin, in browser dev tools, try to PATCH an
      inaisys employee's data → 404.
- [ ] As mts_demo HR, GET
      `/api/employees/<inaisys_id>/delete-request` → 404.

---

## 13e. Worker monitoring + camera metadata + pipeline health (P28.8)

Use the **inaisys** tenant for happy-path testing (real RTSP needed
to verify metadata auto-detection + the 4 stages turning green).
Switch to mts_demo only for cross-tenant + restart-all.

### Setup
- [ ] `docker compose down && docker compose up --build`
- [ ] Wait for "Application startup complete"
- [ ] Confirm inaisys has at least one running camera

### Camera metadata auto-detection
- [ ] Log in as admin@inaisys.local. Cameras → restart Office Camera
      1 (or wait for next worker startup).
- [ ] Open the camera in the edit drawer. Hardware details footer
      shows: detected resolution, fps, codec, with timestamp.
- [ ] Cameras list now shows "1920×1080 · Hikvision" (or similar)
      under the camera name.
- [ ] Open Operations → Workers, click the pencil on a card.
      Manually fill brand "Hikvision", model "Test Model", mount
      location "Office entrance". Save.
- [ ] List + drawer both reflect the new manual values.

### Worker monitoring page — happy path
- [ ] Sidebar shows OPERATIONS → Worker monitoring (Admin only).
      Click it.
- [ ] Page renders with summary strip (Running, Stages with
      issues, Errors last 5 min, Detections last hour, Matches
      last hour).
- [ ] Each worker card has: header, 4-stage pipeline strip,
      counters strip, metadata footer.
- [ ] Wait 60+ seconds. All 4 stages show non-`unknown` indicators.
- [ ] Walk past the camera. Within 5-10 seconds:
      - RTSP green (frames flowing)
      - Detection green (analyzer running)
      - Matching green (last match Xs ago)
      - Attendance green (last record Xm ago)

### Failure cascades
- [ ] Edit the camera, change RTSP URL to invalid one. Save.
- [ ] Wait 30 seconds. Workers page shows:
      - Worker status: reconnecting / failed
      - RTSP red ("Disconnected — N reconnect attempts")
      - Detection red (no frames)
      - Matching unknown (correctly NOT red)
      - Attendance unknown
- [ ] Restore correct RTSP. Stages cascade back to green.

### Conditional red
- [ ] Force a matcher exception (or stop the matcher service).
      Walk past the camera repeatedly so detection IS firing.
- [ ] Workers page shows:
      - RTSP green
      - Detection green
      - Matching red ("Detector firing but matcher silent")
      - Attendance unknown (because matching is red)
- [ ] Restore matcher. Walk past. Stages return to green.

### Errors drawer
- [ ] Click View errors icon on a card with failures. Drawer
      lists recent error strings (timestamp + category +
      message) plus the last 20 audit-log entries.

### Single restart
- [ ] Click Restart icon on a worker card. Confirmation modal.
      Confirm.
- [ ] Worker status flips starting → running. Audit log shows
      `worker_restart_requested`.

### Restart all
- [ ] Click "Restart all workers". Modal opens with red warning.
- [ ] Action button disabled until typed `RESTART ALL`.
- [ ] Type the phrase, button enables. Click.
- [ ] All workers restart in sequence. Audit log shows
      `worker_restart_all_requested` with `restarted` /
      `failed` / `total` counts.

### Cross-tenant isolation
- [ ] Log in as mts_demo Admin. Workers page shows mts_demo
      workers only.
- [ ] In dev tools, manually
      `POST /api/operations/workers/<inaisys_camera_id>/restart`.
      Must 404. (If it actually restarts inaisys, P0.)

### Negative role tests
- [ ] Log in as hr@inaisys.local. Sidebar does NOT show
      OPERATIONS section. Direct URL `/operations/workers` →
      page renders nothing useful (the API 403s).
- [ ] Same for manager / employee.

### Super-Admin system page
- [ ] Log in as Super-Admin. Top nav shows System.
- [ ] System page renders all metric cards.
- [ ] CPU updates on each 5s poll. Per-core mini-bars reflect load.
- [ ] Memory + disk match `docker compose exec backend free -m`
      and `df -h /data` rough output.
- [ ] Detector lock contention shows real number — walk past
      cameras repeatedly to spike it.
- [ ] Active viewers: open Live Capture in 3 tabs, "3 MJPEG"
      shows; close, count drops.
- [ ] Tenants summary lists both tenants with worker counts +
      `any_stage_red` badge.
- [ ] Scheduled jobs table shows `lifecycle_cron`,
      `attendance_recompute`, `scheduled_reports`,
      `notifications_worker`, `retention`.
- [ ] `estimated_days_until_full` is `—` (we don't persist
      growth history yet).

### Negative role for Super-Admin page
- [ ] Log in as inaisys Admin. Direct URL
      `/super-admin/system` → 401/403 (no super-admin cookie).

### Performance check
- [ ] Workers page open with 5s polling for 5 minutes.
- [ ] CPU overhead negligible (<1%).
- [ ] Network tab: each refetch a few KB, fast response.
- [ ] No visible flicker as numbers update on each poll.

---

## 14. Pre-Omran issues

For every problem found, add a row below. This is the
cutover fix list — ordered by severity, addressed before the
next validation pass.

| # | Page / API | Action | Expected | Actual | Severity | Notes |
|---|------------|--------|----------|--------|----------|-------|
|   |            |        |          |        |          |       |

---

## When this pass is done

- Every box in §1 – §13 ticked.
- §14 either empty (publish-ready) or filled with the cutover
  fix list.
- Show the doc to the MTS team, schedule fixes, run another
  pass.

After two passes with empty §14, the build is ready for the
P29 Omran cutover walkthrough.
