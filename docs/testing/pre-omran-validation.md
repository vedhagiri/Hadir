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
   cd /opt/hadir   # or your local checkout
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
          "from hadir.attendance.scheduler import recompute_today; \
           from hadir.tenants.scope import TenantScope; \
           from hadir.db import tenant_context; \
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
          "from hadir.db import get_engine, employee_photos, tenant_context; \
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
- [ ] `hadir_app` has INSERT+SELECT only on `audit_log`:
      ```sql
      SELECT grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_name = 'audit_log' AND grantee = 'hadir_app';
      ```
      Two rows, both INSERT or SELECT. No UPDATE, no DELETE.

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
