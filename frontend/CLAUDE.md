# Maugood frontend — Claude Code notes

## Status
P1 + P4 + P6 + P7 + P11 + P12 complete. **P13 complete**: `/reports`
renders the on-demand Excel report page (date range + employee +
department filters + Generate Excel button that downloads via blob).
`tests/pilot-smoke.spec.ts` is the end-to-end Playwright spec that
goes through login → import → photo → seed detection → recompute →
generate report → parse downloaded XLSX.

## Accessibility
**Every new interactive element must have an accessible name.**
That means an `aria-label` on icon-only buttons, an `aria-haspopup`
+ `aria-expanded` on dropdown triggers, `role="dialog"` +
`aria-label` on popover panels, and `aria-pressed` on
segmented-control buttons. Keyboard handlers (Esc-to-close,
focus-restore-to-trigger) ride on the same components — see
`shell/DisplaySwitcher.tsx` for the reference shape.

The design CSS resets `:focus`. P22 added a `:focus-visible`
override at the bottom of `styles-enhancements3.css` that paints a
2px accent outline for keyboard users only — pointer users still
see the design's pristine surfaces. Don't reintroduce
`outline: none` on individual selectors; let the global rule do
its job.

## Stack
- Vite 5 + React 18
- TypeScript strict (`tsconfig.json` enables `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals/Parameters`, `verbatimModuleSyntax`)
- React Router v6
- TanStack Query (one `QueryClient` at the root; `refetchOnWindowFocus`
  off — the backend already slides session expiry on every request)
- Zustand (installed; not used yet — P6+ when client-only state appears)
- React Hook Form + Zod (small hand-written zod resolver; we don't pull
  in `@hookform/resolvers` for a one-liner)
- **No Tailwind, no CSS-in-JS, no component library.** Styling is plain
  CSS via the design system.

## Layout
```
frontend/
  package.json
  tsconfig.json
  vite.config.ts          # proxies ^/api/ to the backend; SPA routes pass through
  index.html
  Dockerfile
  .env.example
  src/
    main.tsx              # entry; imports CSS, wraps in QueryClient + BrowserRouter
    App.tsx               # route tree (/login + authenticated shell)
    types.ts              # Role, MeResponse, primaryRole()
    api/
      client.ts           # fetch wrapper, ApiError
    auth/
      AuthProvider.tsx    # useMe / useLogin / useLogout via TanStack Query
      ProtectedRoute.tsx  # redirect to /login on 401
      LoginPage.tsx       # /login — RHF + Zod, email + password only
    shell/
      Icon.tsx            # typed port of design/icons.jsx
      nav.ts              # literal port of NAV + CRUMBS from design/shell.jsx
      Sidebar.tsx         # role-aware nav + brand + identity footer
      Topbar.tsx          # breadcrumbs + role badge + logout
      Layout.tsx          # composes sidebar + topbar + <Outlet/>
    pages/
      Placeholder.tsx     # "Coming in P<N>" scaffolds
    features/
      employees/          # P6
        types.ts          # wire types mirroring maugood/employees/schemas.py
        hooks.ts          # TanStack Query hooks: list/detail/photos + mutations
        EmployeesPage.tsx # ported from design/pages.jsx::EmployeesPage
        ImportModal.tsx   # Excel import flow with per-row results
        EmployeeDrawer.tsx # right-sliding detail drawer + photo drop zone
      cameras/            # P7
        types.ts          # Camera/CameraCreateInput/CameraPatchInput (rtsp_url inbound only)
        hooks.ts          # useCameras / useCreateCamera / usePatchCamera / useDeleteCamera
        CamerasPage.tsx   # list with Preview/Edit/Delete per row
        CameraDrawer.tsx  # Add/Edit drawer; RTSP field is *** placeholder on edit
        PreviewModal.tsx  # single-frame fetch + Refresh; revokes blob URLs on unmount
      camera-logs/        # P11
        types.ts hooks.ts CameraLogsPage.tsx
      system/             # P11
        types.ts hooks.ts SystemPage.tsx
      audit-log/          # P11
        types.ts hooks.ts AuditLogPage.tsx
      attendance/         # P12
        types.ts hooks.ts DailyAttendancePage.tsx AttendanceDrawer.tsx MyAttendancePage.tsx
      dashboard/          # P12
        DashboardRouter.tsx + AdminDashboard / HrDashboard / ManagerDashboard / EmployeeDashboard
        StatCard.tsx + StatusBreakdown.tsx (shared dashboard primitives)
      reports/            # P13
        ReportsPage.tsx   # POST /api/reports/attendance.xlsx, blob download
  tests/                  # P13 — Playwright pilot smoke
    pilot-smoke.spec.ts   # login → import → photo → seed → recompute → report → assert XLSX
  playwright.config.ts
    styles/               # design CSS, copied verbatim — DO NOT EDIT
      styles.css
      styles-enhancements.css
      styles-enhancements2.css
      styles-enhancements3.css
    design/               # design archive JSX, READ-ONLY reference for later sessions
      icons.jsx
      shell.jsx
      ui.jsx
      pages.jsx
      dashboards.jsx
      employee.jsx
      data.jsx
```

## Auth flow (P4)
- `useMe()` (in `auth/AuthProvider.tsx`) hits `GET /api/auth/me`. 401 is
  treated as "not logged in" — returns `null` instead of throwing.
- `useLogin()` posts `POST /api/auth/login`; on success populates the
  `me` cache so `ProtectedRoute` lets the user through without a second
  round-trip.
- `useLogout()` posts `POST /api/auth/logout` and clears the cache.
- `ProtectedRoute` redirects to `/login` whenever `me` is null after the
  probe resolves. The login page redirects back to `/` (which redirects
  to `/dashboard`) once auth succeeds.

## Role-aware nav (P4)
`src/shell/nav.ts` is a literal port of the `NAV` and `CRUMBS` constants
from `src/design/shell.jsx`. Do not edit labels, icons, badges, or
ordering without touching the design reference first.

Pilot uses the user's **highest role only** (Admin > HR > Manager >
Employee) via `primaryRole()` in `src/types.ts`. A full role switcher
ships in v1.0 (PROJECT_CONTEXT §8); the sidebar footer renders a static
identity card with a TODO comment pointing at the deferred switcher.

## Design red lines (unchanged from P1)
- `src/styles/*.css` and `src/design/*.jsx` are **copied verbatim** from
  the design archive. Never edit, reformat, or "modernise" them.
- Primary buttons are **black**, not teal (the accent is for signals).
  `LoginPage.tsx` uses `btn btn-primary`; the topbar logout uses the
  secondary `btn btn-sm`.
- No Arabic, no RTL, no dark-mode toggle in the pilot — all deferred.

## Run
- `docker compose up frontend` — http://localhost:5173.
- `docker compose exec frontend npm run typecheck` — TypeScript strict check.
- `docker compose exec frontend npm run dev` — Vite hot-reloads on save.

## Smoke test (P13)
The Playwright spec runs against the live compose stack. Requires
`MAUGOOD_ENV=dev` (it uses the `/api/_test/*` endpoints to seed a
detection and force a recompute).

```bash
docker compose up -d
cd frontend && npm install && npx playwright install chromium
npm run smoke
```

The spec exercises the real auth flow (UI login + cookie), the
employees import + photo upload + report download UI, and the
dev-only seed/recompute pair. It cleans up the seeded employee at
the end so a re-run starts clean.

## Pilot prompt currently active
P13 — done. Next: **P14 — Omran on-site deployment + acceptance
walkthrough.** Wait for the user before starting P14. Walk through
the demo script in `pilot-plan.md` §P13 first to surface any UX
papercuts.
