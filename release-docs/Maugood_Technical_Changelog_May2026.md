# Maugood — Technical & UI/UX Changelog
**Period:** May 2026 · Branch: `release/staging-testing`  
**Version:** v1.1.14 → v1.1.15-dev  
**Prepared:** 2026-05-27

---

## Table of Contents

1. [Attendance Calendar — Day Detail Drawer Redesign](#1-attendance-calendar--day-detail-drawer-redesign)
2. [Attendance Status UI — Per-Status Handling](#2-attendance-status-ui--per-status-handling)
3. [Evidence Gallery & Face Crop Preview](#3-evidence-gallery--face-crop-preview)
4. [Day Timeline Ribbon Redesign](#4-day-timeline-ribbon-redesign)
5. [Escalation Workflow](#5-escalation-workflow)
6. [Manager / HR Inline Approval Flow](#6-manager--hr-inline-approval-flow)
7. [Policy Applied & Expected Shift UI](#7-policy-applied--expected-shift-ui)
8. [Employee Module Improvements](#8-employee-module-improvements)
9. [Form Validation Improvements](#9-form-validation-improvements)
10. [Camera & Clip Analytics](#10-camera--clip-analytics)
11. [Unidentified Faces Module](#11-unidentified-faces-module)
12. [Authentication & Session Management](#12-authentication--session-management)
13. [Backend Architecture Improvements](#13-backend-architecture-improvements)
14. [Performance & Loading Improvements](#14-performance--loading-improvements)
15. [Deployment Updates](#15-deployment-updates)
16. [Open Items & Planned Work](#16-open-items--planned-work)

---

## 1. Attendance Calendar — Day Detail Drawer Redesign

### 1.1 Architecture: `DayDetailContent` Extraction

**Problem:** Three surfaces required identical day-detail UI — Calendar drawer, Employee Profile Attendance tab, Daily Attendance drawer — each had separate implementations that diverged over time.

**Solution:** Extracted `export function DayDetailContent` from `DayDetailDrawer.tsx`. All state (highlight, escalation drawer, refs, role detection, cache invalidation) lives inside the content component. The drawer wrapper is now ~30 lines.

**Consumers updated:**

| Consumer | Before | After |
|---|---|---|
| `DayDetailDrawer.tsx` | Monolithic 1000-line file | Shell + `<DayDetailContent>` |
| `EmployeeViewDrawer.tsx` — Attendance tab | Custom `AttendanceDayCard` (230 lines) | `<DayDetailContent>` |
| `AttendanceDrawer.tsx` | Custom UI (260 lines) | DrawerShell + `<DayDetailContent>` (57 lines) |

**Key props:**
```tsx
<DayDetailContent
  employeeId={number}
  isoDate={string}           // ISO "YYYY-MM-DD"
  onSubmitException={fn | null}
/>
```

### 1.2 Cache Invalidation — `onDecisionMade`

After any escalation action (submit, approve, reject), a stable `useCallback` invalidates:
```
["calendar"]          → all calendar query families
["attendance"]        → DailyAttendancePage + dashboards
["requests"]          → Approvals inbox badge count
```
And immediately refetches:
```
["calendar","day", employeeId, isoDate]        → drawer
["calendar","person", employeeId, month]       → person grid
```

### 1.3 Export Button Disable Logic

The header Export button is disabled based on status and whether work was recorded:

```
Always disabled:   no_record · future · absent · waiting
Weekend/Holiday:   disabled only when no in_time, no total_minutes, no timeline events
Always enabled:    present · late · escalation_present · leave (with data)
```

---

## 2. Attendance Status UI — Per-Status Handling

### 2.1 Status Routing in `DayDetailContent`

```
absent            → AbsentStateCard
waiting           → AbsentWaitingCard
(all others)
  ├─ escalation_confirmed → EscalationConfirmedCard
  ├─ weekend              → WeekOffDayContent
  ├─ holiday              → HolidayDayContent  ← NEW
  ├─ no_record / future   → NoRecordCard
  └─ default              → 4-tile grid + timeline + policy + evidence
```

### 2.2 `present` / `late` — Standard Tile Grid

Renders four stat tiles: **In Time · Out Time · Total · Overtime** followed by the day timeline ribbon, Policy Applied card, and evidence gallery. Late status additionally renders `LateBreakdownCard` with a visual shift ruler showing grace window.

### 2.3 `waiting` — Day In Progress (`AbsentWaitingCard`)

**Layout:**
1. **Live amber banner** — ⏳ icon with live dot, "Day In Progress" heading, "LIVE" pill, shift window still open subtitle, mono date
2. **`PolicyAppliedCard`** — exact same visual as the Policy Applied section (reused component, not a copy)
3. **Camera monitoring strip** — accent blue, camera icon, "Camera monitoring active" message
4. **Actions section** — role-gated: Submit exception CTA (all roles) + Raise escalation button (Employee only)

**Colors:** `var(--warning)` family for banner; `var(--accent)` family for monitoring strip.

### 2.4 `absent` — Simplified (`AbsentStateCard` → `SimpleAbsentCard`)

**Removed:** All camera-diagnostic detail (offline windows, detection counts, camera-wise sub-state cards). These were irrelevant to the employee and added noise.

**`SimpleAbsentCard` layout:**
- Red status banner with `BsXCircleFill` icon at 22 px
- Single "Submit Escalation Request" CTA (`BsClipboard2PlusFill` icon)
- Employee sees the CTA; Admin/Manager/HR see "Employee has not submitted an exception request"
- If a pending request exists → `RequestPendingCard` (with inline approve/reject)
- If an approved request exists → `ApprovedAbsenceCard`

### 2.5 `weekend` — `WeekOffDayContent`

Two rendering paths:
- **Not worked:** Status card with info stripe, 3-column stat tiles (Off days/week · Selected day · Detections), weekly schedule strip (Mon–Sun dots), assigned shift policy card, dashed info note
- **Worked:** Amber warning banner "Worked on Week Off", 4-tile summary, weekly strip context, full timeline + evidence

### 2.6 `holiday` — `HolidayDayContent` (NEW)

**Not worked path:**
- **Hero banner**: 4 px info-blue top bar, star SVG illustration, holiday name (large bold), "Official Holiday" badge, full date, "No attendance expected" subtitle, date chip + "No activity" green chip in footer bar
- **Info panel**: 3 contextual fact rows with inline SVG icons
  - ✓ No attendance required (green icon)
  - 📅 Record stays clean — not counted as absent (blue icon)
  - ⏱ Overtime applies if worked (amber clock icon)
- **Assigned shift policy** card (if policy exists)
- **Dashed bottom note** — contact HR to update holiday schedule

**Worked path:**
- Same hero banner + OT chip in footer
- Amber "Worked on a public holiday" warning banner
- 4-tile summary + full timeline + policy + evidence

**Design tokens:** `var(--info)` family for all chrome; `var(--warning)` only for the worked-on-holiday banner.

### 2.7 `no_record` — `NoRecordCard`

Two variants via `isFuture` prop:

**`no_record` (past date):**
- 74 px circle with dashed outer ring + camera SVG + question mark inside
- "No Data for This Day" heading, parsed date, short date chip
- Three fact rows (No attendance record / No detections available / No face crops captured) in sunken panel
- Bottom info note (camera offline, predates system setup, employee absent)

**`future`:**
- Calendar SVG with three progressive dots
- "Future Date" heading, parsed date
- Bottom accent strip — clock icon + "Attendance will be monitored as detections come in"

### 2.8 `escalation_present` — New Status

Added after Manager + HR approve an escalation. Distinct from plain "present" so operators can audit which records were camera-detected vs. manually confirmed.

**Backend:** `attendance_calendar/queries.py` — checks `ar.locked` in both person-view and day-detail status chains. Priority: after `absent`, before `late`/`present`.

**Frontend cell:** `var(--success-soft)` background + teal left border stripe.  
**StatusPill:** `✓ Present via Escalation` in teal bordered badge.

---

## 3. Evidence Gallery & Face Crop Preview

### 3.1 Thumbnail Grid

| Property | Before | After |
|---|---|---|
| Min card width | 120 px | 150 px |
| Aspect ratio | Square | 3 / 4 (portrait — matches face crop shape) |
| Hover state | Border color change | `translateY(-3px)` lift + shadow |
| Confidence footer | Text only | Color-coded strip (green ≥75% / amber ≥50% / red <50%) |
| Flash on timeline click | Static border | `@keyframes evidenceFlash` — ring 0→6→4 px + card scale 1→1.06→1.04 |
| Flash duration | 1500 ms | 2500 ms |
| Gallery overflow clip | Visible | `padding: 4px; margin: -4px` to prevent ring clipping |

### 3.2 `EvidenceLightbox`

**Architecture:** `createPortal(…, #drawer-root)` — escapes the drawer's `position: fixed` containing block.

**Split-panel layout:**
- **Left pane (dark):** Full-resolution crop, filmstrip strip at bottom (all crops, active accent-highlighted), prev/next arrows, keyboard (← →) + Esc navigation
- **Right panel (280 px light):** Large mono time, ISO date, confidence progress bar, 2×2 metadata grid (Camera / Event ID / Full time / Confidence pct), keyboard hint footer

**Confidence progress bar:** Green ≥75% / amber ≥50% / red <50%, `width: ${conf*100}%` CSS transition.

### 3.3 Summary Line

Above the gallery: `N face crops · Best match XX%` + `Click any crop to preview` right-aligned.

---

## 4. Day Timeline Ribbon Redesign

### 4.1 Smart Zoom

- **Default view:** Auto-crops to ±90 min around first/last activity with a minimum 4 h window — no more tiny slivers on a 24 h ruler
- **"Full day" toggle:** Switches to midnight–midnight view
- Hour label density adapts: 1 h / 2 h / 3 h / 6 h step depending on window width

### 4.2 Detection Dots

| Property | Before | After |
|---|---|---|
| Size | 14 px | 18 px |
| Ring | None | Confidence-coloured ring (green/amber/red) |
| Hit area | 14 px | 28 px transparent click zone |

### 4.3 Tooltip

Rich hover tooltip replaces plain time string:
- Time (HH:MM)
- Camera code
- Confidence progress bar (same color logic as gallery)
- "↓ Click to highlight face crop" hint

### 4.4 IN / OUT Markers

First and last event now show permanent **IN** / **OUT** diamond labels below the ruler — no hover required. Connected to evidence gallery: clicking a dot scrolls + flashes the corresponding crop.

### 4.5 Stat Pills & Legend

- **Stat pills row:** First seen · Last seen · Duration (replaces plain inline text)
- **Legend strip:** Present window · Face detected · First seen · Last seen

---

## 5. Escalation Workflow

### 5.1 `EscalationDrawer` Redesign

**Purpose:** Employee-facing form to explain a missed detection and request attendance correction.

**Before:** Free-text textarea + dropdown fetching empty `/api/request-reason-categories?type=escalation`.

**After:**
- Title: "Submit Escalation Request"
- Info banner with `BsInfoCircleFill` icon: *"Explain your situation. Manager and HR will review your escalation request and update your attendance status if approved."*
- **4 hardcoded radio selection cards** (each a styled `<label>` block):
  1. "My face was not detected properly by the camera" → `camera_missed`
  2. "I was present, but detection may have failed due to camera angle/location" → `not_in_frame`
  3. "I was present in another monitored location" → `different_entry`
  4. "Face detection may have failed because of lighting or visibility issues" → `system_error`
- **Optional In Time + Out Time** `<input type="time">` fields
- On submit: time values prepended to reason_text — `"Estimated time present — In: HH:MM  |  Out: HH:MM\n<comment>"`

### 5.2 `EscalationConfirmedCard`

Shown when `detail.escalation_confirmed === true` (record is locked).

**Layout:**
1. Green success banner: "Present confirmed by escalation"
2. **`EscalationTimingCard`** — parsed employee-submitted In/Out times displayed as two colored panels
3. **Approval chain** — Submitted → Manager Approved → HR Approved step trail

**Encoding fix:** The "Submitted" chain step previously showed the raw encoded time string (e.g. `"Estimated time present — In: 08:30 | Out: 16:00\nFeel better now"`). Fixed by `parseEscalationTimes()` — extracts the HH:MM values and shows only the plain comment in the chain step.

### 5.3 `EscalationTimingCard`

Two full-width colored panels side by side:
- **In Time** — green tint, clock icon, 12 h formatted time, large weight 800 font
- **Out Time** — amber/warning tint, matching treatment

`fmt12()` helper converts `"HH:MM"` → `"H:MM AM/PM"`.

### 5.4 Backend — Escalation DB Constraint Fix

**Root cause:** `requests` table `CheckConstraint` only covered `type IN ('exception','leave')`. Submitting an escalation (type `'escalation'`) caused a DB constraint violation → HTTP 500.

**Fix applied:**
1. `db.py` — Updated both constraints to include `'escalation'`
2. Migration `0065_fix_requests_escalation_constraints.py` — Idempotent `DROP + ADD CONSTRAINT` applied across all schemas
3. Live DB — Direct DDL applied to `tenant_inaisys` and `tenant_giitm` which were provisioned via `metadata.create_all` after 0063 and missed the migration

### 5.5 Terminal Status Names Fix

**Root cause:** `attendance_calendar/queries.py._TERMINAL_STATUSES` used `"rejected_by_manager"` / `"rejected_by_hr"` — but actual DB values are `"manager_rejected"` / `"hr_rejected"` / `"admin_rejected"`. Rejected requests kept appearing as "pending".

**Fix:** Corrected status strings + added `"admin_rejected"` to the terminal set.

---

## 6. Manager / HR Inline Approval Flow

### 6.1 Feature Overview

Managers and HR can approve or reject escalation requests directly from the Calendar Day Detail drawer — no navigation to the Approvals page required.

### 6.2 `RequestPendingCard`

Detects the acting role and request stage:

| Viewer role | Request status | Action shown |
|---|---|---|
| Manager | `submitted` | Approve + Reject buttons |
| HR | `manager_approved` | Approve + Reject buttons |
| Employee / others | Any | Read-only status display |

**Approve flow:** Single click → `POST /api/requests/{id}/manager-decide` or `/hr-decide` with `{decision: "approve"}`.

**Reject flow:** Click Reject → inline textarea (optional comment) appears → Confirm button → same endpoint with `{decision: "reject", comment}`.

**On success:** `onDecisionMade()` fires — invalidates `["calendar"]`, `["attendance"]`, `["requests"]` and immediately refetches the affected day and month views.

### 6.3 Bug Fix — Wrong Endpoint

Frontend previously called `/api/requests/{id}/decide` which does not exist. Corrected to `/api/requests/{id}/manager-decide`.

---

## 7. Policy Applied & Expected Shift UI

### 7.1 `PolicyAppliedCard`

Shared component used in three places: Policy Applied section (normal status), `AbsentWaitingCard` Expected Shift, and `WeekOffDayContent` assigned policy.

**Layout:**
- Policy name (bold) + type badge (`Fixed` / `Flex` / `Ramadan` / `Custom`)
- "Must complete X hours" subtitle
- `PolicyShiftRibbon` — 06:00–20:00 SVG time ruler with colored shift window and grace region

### 7.2 `PolicyShiftRibbon`

SVG ruler spanning 06:00–20:00 (840 min). Renders:
- Light gray background track
- Colored shift window (present color)
- Grace window overlay (warning tint)
- Start/end time labels below the ruler

### 7.3 Waiting Status — Expected Shift

**Before:** Custom timeline section with progress bar, 3 tiles, manual `toMins()` / `fmt12()` helpers, `progressPct` computation.

**After:** `<PolicyAppliedCard detail={detail} />` — identical output to the Policy Applied section. Removed ~60 lines of duplicate logic.

**Prop change:** `AbsentWaitingCard` signature simplified from 5 individual policy props to `detail: DayDetail` (full object passed through, `PolicyAppliedCard` reads from it directly).

---

## 8. Employee Module Improvements

### 8.1 Photo Lightbox (`EmployeeViewDrawer`)

- Keyboard navigation: ← → arrow keys cycle through photos, Esc closes
- Focus restored to trigger button on close (`useRef` + `focus()` on unmount)
- `aria-label` on each photo button for screen reader accessibility
- Confidence progress bar style matching the calendar evidence lightbox

### 8.2 Attendance Tab Integration

**Before:** Custom `AttendanceDayCard` — basic stat grid, no status handling, no escalation flow, no timeline.

**After:** `<DayDetailContent employeeId={id} isoDate={selectedDate} />` — full Calendar Day Detail UI including all status branches, inline approval, evidence gallery, timeline.

**Date picker:** Placed above the content; navigates forward/backward one day; defaults to today.

### 8.3 `BulkDeleteModal` — Delete All Danger Color

The "Delete All" button in `EmployeesPage.tsx` was styled `btn` (neutral gray). Changed to `btn btn-danger` to match the "Delete Selected" button and clearly communicate destructive intent.

### 8.4 Delete Requests — Approvals Integration

`DeleteRequestsTab` in the Approvals page shows pending employee hard-delete requests. Role-aware: Admin can approve/reject/override; HR can approve pending Admin-submitted requests.

---

## 9. Form Validation Improvements

### 9.1 Camera Add Form

**File:** `frontend/src/features/cameras/CameraDrawer.tsx`

**Changes:**

#### Required Field Indicators
`Field` component gains an optional `required?: boolean` prop. When true, renders a red `*` after the label:
```tsx
<span aria-hidden style={{ color: "var(--danger-text)", fontWeight: 700, fontSize: 13 }}>*</span>
```
Applied to: **Name** (create mode) and **RTSP URL** (create mode).

#### `canSubmit` Logic
```typescript
const canSubmit =
  mode === "edit"
    ? !submitting
    : !submitting && name.trim().length > 0 && rtspUrl.trim().length > 0;
```
Add Camera button: `disabled={!canSubmit}` — starts disabled, enables only after both required fields have non-empty trimmed values.

#### Client-Side Validation Order (create mode)
```
1. name.trim() empty  → setError(t("cameras.errors.nameRequired"))
2. rtspUrl.trim() empty → setError(t("cameras.errors.rtspRequired"))
3. Submit to API
```

#### i18n Keys Added
| Key | en | ar |
|---|---|---|
| `cameras.errors.nameRequired` | "Camera name is required." | "اسم الكاميرا مطلوب." |

### 9.2 Employee Delete All Button

`EmployeesPage.tsx` line 212: `className="btn"` → `className="btn btn-danger"` for the "Delete All" button when no employees are selected.

### 9.3 Login Page

Default form values changed from pre-filled test credentials to empty strings for production readiness.

---

## 10. Camera & Clip Analytics

### 10.1 Person Clips System (`/person-clips`)

**Backend:**
- New `person_clips` table: `id, tenant_id, camera_id, employee_id, started_at, ended_at, duration_sec, clip_path, face_match_count, face_match_confidence, processing_status`
- `person_start` / `person_end` / `face_matching` fields added
- Recovery mechanism (`0062_clip_processing_recovery_attempts`) for failed pipeline jobs

**Frontend (`PersonClipsPage.tsx`):**
- Video clip cards with face match confidence badge
- Filters: date range, camera, employee, processing status
- Encoding settings panel (quality, format)
- "Only Faces" filter to show clips with at least one identified match
- Face reprocess button per clip

### 10.2 Clip Analytics (`ClipAnalyticsPage.tsx`)

- Clip recording enabled/disabled toggle per camera
- Clip detection source radio (face / body / both) — Migration 0053 defaulted new cameras to `body`
- `ClipDetectionSource` type: `"face" | "body" | "both"`
- `AnomalyInfoBanner` shown above face crops section

### 10.3 Frame Diagnostics (`FrameDiagnosticsPage.tsx`)

New page under `/frame-diagnostics`. Logs anomaly events with timestamps, camera source, and error type. Backed by `maugood/diagnostics/recorder.py` — ring-buffer of recent anomaly events per camera, exposed via `GET /api/diagnostics/frames`.

**Use cases:**
- Identify cameras with high drop rates
- Debug detection pipeline failures
- Monitor face detection quality degradation

### 10.4 Pipeline Monitor (`PipelineMonitor.tsx`)

Live view of the capture pipeline stages per camera. Shows per-stage health (rtsp / detection / matching / attendance) with green/amber/red status.

Features added in this period:
- **Sync button** — triggers manual recompute for today
- **Loading animation** on sync
- Per-stage drill-down tooltips

### 10.5 Live Capture Viewer Improvements

- Multi-tenant `CaptureManager` key: `(tenant_id, camera_id)`
- MJPEG stream paced at 25 fps
- WebSocket heartbeat carries: `fps_reader` / `fps_analyzer` / `motion_skipped`
- Camera grouped into: Live / Display-disabled / Worker-disabled with explanatory empty states
- `display_enabled` toggle: MJPEG returns 503 `camera_display_disabled` when off

---

## 11. Unidentified Faces Module

### 11.1 Overview

New module at `/unidentified-faces` for reviewing camera detections that did not match any enrolled employee.

**Backend (`maugood/unidentified_faces/`):**
- `router.py` — paginated list of `detection_events WHERE employee_id IS NULL`
- `clustering.py` — groups similar unidentified face crops by embedding cosine similarity (threshold-based, no external library)
- Endpoints:
  - `GET /api/unidentified-faces` — paginated, filterable by camera / date range / confidence threshold
  - `GET /api/unidentified-faces/clusters` — grouped by visual similarity
  - `POST /api/unidentified-faces/{id}/assign` — maps an unidentified crop to an employee (creates a face enrollment)

**Frontend (`UnidentifiedFacesPage.tsx`):**
- Face crop grid (same thumbnail style as evidence gallery)
- "Cluster view" toggle — groups visually similar faces together
- "Assign to Employee" button per crop / per cluster
- Employee picker modal (search by name/code)
- Filter bar: camera, date, confidence threshold slider

### 11.2 Similar-Face Grouping / Clustering

Algorithm: cosine similarity on existing ArcFace embeddings stored in `detection_events.embedding`. Groups are formed greedily — each crop joins the first cluster whose centroid similarity exceeds `MAUGOOD_CLUSTER_THRESHOLD` (default 0.65).

Cluster card shows: representative crop, count badge, date range span, "Assign all in cluster" CTA.

### 11.3 Map Unidentified Faces to Employees

When an operator assigns an unidentified cluster to an employee:
1. Backend decrypts the embedding from each selected `detection_event` row
2. Creates an `employee_photos` row + enrolls the embedding
3. Invalidates `matcher_cache` for that employee
4. Future detections from similar faces will now resolve to that employee

---

## 12. Authentication & Session Management

### 12.1 Session Countdown (`SessionCountdown.tsx`)

Displays remaining session time in the topbar. Syncs with server time on first load to avoid client clock drift.

**Implementation:**
- `GET /api/auth/me` response includes `session_expires_at` (ISO datetime)
- `SessionCountdown` computes `delta = expires_at - serverNow + (clientNow - serverNow)` for drift-corrected countdown
- Shows warning color (amber) when < 5 min remain
- Clicking opens a "Stay signed in" popover that calls `POST /api/auth/refresh`

### 12.2 Session Expiry Watcher (`SessionExpiryWatcher.tsx`)

Background watcher that fires before the session expires:
- 60 s before expiry → prompts "Your session is about to expire. Stay signed in?"
- On expiry → clears TanStack Query cache, redirects to `/login`
- Refresh anchor: a "refresh every N minutes" invisible ping to keep the session alive during active use

### 12.3 Token Refresh Flow

```
Client → POST /api/auth/refresh
Backend → bumps session expires_at by MAUGOOD_SESSION_IDLE_MINUTES
        → returns new Set-Cookie with updated Max-Age
Client → updates local session_expires_at in React context
```

### 12.4 Login Page

- Default form values changed to empty strings (removed pre-filled dev credentials)
- Login button enabled only after both email and password fields are non-empty

### 12.5 Microsoft / Entra ID Login (Planned)

See `docs/microsoft-login-setup.md`. OIDC flow already implemented in P6. Planned frontend improvements:
- "Sign in with Microsoft" button promoted to primary CTA when OIDC is configured
- Microsoft logo in the button
- Tenant slug auto-detected from Entra tenant claim (so users don't need to type it)

---

## 13. Backend Architecture Improvements

### 13.1 Escalation DB Constraints

**Migration 0063** (`0063_escalation_requests.py`): added `'escalation'` to `requests.type` CHECK.

**Migration 0064** (`0064_escalation_categories_extra.py`): seeded default escalation reason categories.

**Migration 0065** (`0065_fix_requests_escalation_constraints.py`): idempotent constraint repair for schemas provisioned between 0063 and 0064 that missed the DDL change.

### 13.2 Attendance Calendar Queries

`maugood/attendance_calendar/queries.py`:

- Added `STATUS_ESCALATION_PRESENT = "escalation_present"` constant
- `locked` column added to person-view SELECT
- Status computation: `escalation_present` inserted at correct priority (after `absent`, before `late`/`present`)
- `_TERMINAL_STATUSES` corrected: `manager_rejected` / `hr_rejected` / `admin_rejected`

### 13.3 Attendance Scheduler — Multi-tenant

`maugood/attendance/scheduler.py`:
- Recompute jobs now properly scoped per tenant schema via `tenant_context(schema)`
- `recompute_for(employee_id, date)` helper used by escalation approval webhook

### 13.4 Manager Scope Fix

`backend/tests/test_manager_scope.py` extended. Manager attendance visibility uses union of `manager_assignments` + `user_departments` — consistent across attendance router, requests router, and calendar queries.

### 13.5 Schema Sync Tooling

New scripts:
- `scripts/sync_schema.py` — syncs `db.py` table definitions to all tenant schemas without a full migration
- `scripts/sync_grants.py` — re-applies `maugood_app` grants after schema drift
- `scripts/_schema_sync.py` — shared helpers used by both

### 13.6 Clip Pipeline Recovery

Migration `0062_clip_processing_recovery_attempts`:
- Adds `recovery_attempts` counter + `last_error` text to `person_clips`
- `clip_pipeline/recovery.py` retries failed clips up to `MAUGOOD_CLIP_MAX_RECOVERY_ATTEMPTS` (default 3)

---

## 14. Performance & Loading Improvements

### 14.1 Pagination

- `GET /api/unidentified-faces` — cursor-based pagination, default page size 50
- Evidence gallery — `maxHeight: 55vh; overflowY: auto` scroll container
- Person clips list — infinite scroll via TanStack Query `useInfiniteQuery`

### 14.2 Lazy Loading

- Evidence `<img>` elements all carry `loading="lazy"`
- `EvidenceLightbox` filmstrip renders only the visible strip portion (no virtualization, but thumbnails are small)
- `PolicyAppliedCard` / `PolicyShiftRibbon` rendered conditionally on `detail.policy_name` presence

### 14.3 Image Handling

- `BlobURL` management: face crop blob URLs revoked on component unmount (`URL.revokeObjectURL`)
- Live capture MJPEG: `img.src` updates use `createObjectURL` + revoke cycle to prevent memory leaks
- Lightbox: images loaded on demand (only the current index + neighbors preloaded)

### 14.4 Query Deduplication

`DayDetailDrawer` calls `useDayDetail(employeeId, isoDate)` for the header name — same cache key as `DayDetailContent`'s own call. TanStack Query deduplicates: one network request serves both.

### 14.5 `refetchOnWindowFocus: false`

Inherited from root `QueryClient` config. Prevents spurious refetches when operators switch windows during long review sessions.

---

## 15. Deployment Updates

### 15.1 Release Scripts

- `deploy-update.sh` — now uses the shared manifest-driven update planner
- `quick-update.sh` — fast path for hotfix deploys (skips full planner)
- `quick-start.sh` — single-tenant localhost install from scratch
- `scripts/db-backup.sh` — manual DB backup + restore (development / pre-deploy safety)

### 15.2 InayaHR Landing Page

Planned deployment to `inayahr.com`. The Maugood product is branded as **InayaHR** for the commercial launch. Landing page deployment is a separate frontend-only static site; not part of this repo.

### 15.3 Version Display

Login screen and super-admin login now show the product version from `package.json` → Vite `__APP_VERSION__` define → `config.ts` → `Sidebar.tsx` version chip.

Current: `v1.1.15-dev`

---

## 16. Open Items & Planned Work

### 16.1 UI/UX — Pending

| Item | Priority | Notes |
|---|---|---|
| Toast/notification on inline approve/reject success | Medium | Currently drawer refetches silently |
| Admin override for escalation from Calendar Day Detail | Medium | Admin uses Approvals page today |
| `escalation_present` filter chip in `DailyAttendancePage` | Low | Status exists but not in filter dropdown |
| Leave status — dedicated `LeaveDayContent` card | Low | Currently uses default tile grid |
| Arabic translations native-speaker review | **Critical** | P21 carryover — required before v1.0 launch |

### 16.2 Employee Module — Planned

| Item | Priority |
|---|---|
| Resizable Employee Profile drawer (drag handle on edge) | Medium |
| Team Members — searchable table in Manager view | Medium |
| Join/Relieving date picker — calendar popup instead of text input | Low |

### 16.3 Camera & Analytics — Planned

| Item | Priority |
|---|---|
| Face gallery preview UI in Camera Logs | Medium |
| Camera Events page redesign | Medium |
| Similar-face clustering persistence (save cluster assignments across sessions) | High |
| Map unidentified faces bulk-assign (select multiple crops, one assign action) | High |

### 16.4 Auth — Planned

| Item | Priority |
|---|---|
| Microsoft Login — tenant slug auto-detect from Entra claim | High |
| Stay Signed In persistent session option | Medium |
| Logout flow — confirm dialog when unsaved changes exist | Low |

### 16.5 Performance — Planned

| Item | Priority |
|---|---|
| Evidence gallery image virtualization (react-virtual or custom) for 100+ crops | Medium |
| Skeleton loaders on Day Detail Drawer initial load | Low |
| API response compression (gzip already on nginx; ensure Vite dev proxy also passes) | Low |

### 16.6 Backend — Planned

| Item | Priority |
|---|---|
| Fernet two-key rotation tooling (B-8 from v1.x backlog) | Medium |
| `TenantScope.for_tenant` classmethod for background jobs | Medium |
| Email validator `.local` TLD allowlist for dev environments | Low |

---

## Appendix A — Status Color Reference

| Status | Cell background | Top stripe | StatusPill |
|---|---|---|---|
| `present` | `--success-soft` | `--success` | ✓ Present (green) |
| `escalation_present` | `--success-soft` + teal left border | `--accent` | ✓ Present via Escalation (teal) |
| `late` | `--warning-soft` + amber stripe | `--warning-text` | Late (amber) |
| `absent` | `--danger-soft` | `--danger-text` | Absent (red) |
| `waiting` | `--accent-soft` | `--accent` | Waiting (accent) |
| `weekend` | `--info-soft` | `--info` | Week Off (blue) |
| `holiday` | `--bg-elev` + info border | `--info` | Holiday (blue) |
| `leave` | `--warning-soft` | `--warning-text` | Leave (amber) |
| `no_record` | `--bg-sunken` | `--border` | No Record (neutral) |
| `future` | `--accent-soft` | `--accent` | Future (accent) |

---

## Appendix B — Key Files Changed

### Frontend
```
src/features/calendar/DayDetailDrawer.tsx   — main drawer, all status cards
src/features/calendar/EscalationDrawer.tsx  — escalation submission form
src/features/calendar/PersonView.tsx        — month grid cells
src/features/calendar/types.ts             — CalendarStatus + DayDetail types
src/features/attendance/AttendanceDrawer.tsx — simplified to DayDetailContent
src/features/attendance/DailyAttendancePage.tsx
src/features/attendance/MyAttendancePage.tsx
src/features/employees/EmployeeViewDrawer.tsx — Attendance tab
src/features/employees/EmployeesPage.tsx   — Delete All danger button
src/features/cameras/CameraDrawer.tsx      — form validation + required fields
src/features/unidentified-faces/UnidentifiedFacesPage.tsx — NEW
src/features/unidentified-faces/hooks.ts   — NEW
src/features/unidentified-faces/types.ts   — NEW
src/pages/FrameDiagnostics/FrameDiagnosticsPage.tsx — NEW
src/pages/PipelineMonitor/PipelineMonitor.tsx — enhanced
src/auth/SessionCountdown.tsx              — NEW
src/auth/SessionExpiryWatcher.tsx          — NEW
src/components/AnomalyNote.tsx             — icon update
src/i18n/locales/en.json                   — escalation_present, holiday, noRecord keys
src/i18n/locales/ar.json                   — same keys in Arabic
```

### Backend
```
maugood/db.py                              — requests CheckConstraints fixed
maugood/attendance_calendar/queries.py     — escalation_present, locked col, terminal statuses
maugood/attendance/scheduler.py            — multi-tenant scope
maugood/diagnostics/                       — NEW (frame anomaly recorder)
maugood/unidentified_faces/                — NEW (clustering + assign)
maugood/clip_pipeline/recovery.py          — retry logic
alembic/versions/0062_clip_processing_recovery_attempts.py
alembic/versions/0063_escalation_requests.py
alembic/versions/0064_escalation_categories_extra.py
alembic/versions/0065_fix_requests_escalation_constraints.py
scripts/sync_schema.py                     — NEW
scripts/sync_grants.py                     — NEW
```

---

*End of document. Generated 2026-05-27.*
