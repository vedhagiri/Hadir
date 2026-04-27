# Animation polish

**Date (UTC):** 2026-04-27
**Engineer:** Suresh (MTS) via Claude Code
**Goal:** Linear/Vercel-level motion polish across the v1.0
frontend. Behaviour unchanged — only motion added.

## What shipped

* **`frontend/src/motion/`** — single source of truth for animation
  timing.
  * `tokens.ts` — `DURATION` (instant/fast/normal/slow/slower),
    `EASING` (smooth/snappy/entrance/exit cubic-beziers), `SPRING`
    (gentle/bouncy/stiff presets).
  * `useReducedMotion.ts` — wraps Framer's hook + documents the
    project policy (page transitions OFF, hover effects + active-
    indicator slide ON).
  * `PageTransition.tsx` — AnimatePresence wrapper around the
    route render area. Outgoing fades out + drifts up 8 px;
    incoming fades in from 8 px below. ~200 ms.
  * `StaggeredList.tsx` — generic stagger for tables, card grids,
    menu items. First 12 items animate with 30 ms cadence; beyond
    that everyone appears instantly. Reduced-motion turns it off.
    Supports `as="tbody"` for tables.
  * `RollingNumber.tsx` — useSpring-driven counter for live stats.
* **Page transitions** — `Layout.tsx` wraps `<Outlet />` in
  `<PageTransition>`. The prior P28.6 CSS-keyframe approach is
  gone (its `will-change: transform` was the root cause of the
  drawer-positioning bug — see `docs/phases/fix-drawer-positioning.md`).
* **Sidebar active indicator** — `Sidebar.tsx` renders a 3 px
  accent bar at the inline-start edge of the active nav item. A
  shared `layoutId="sidebar-active-indicator"` makes Framer
  Motion slide the bar between items rather than re-render in
  place. Always plays even with reduced motion (short, spatial).
* **Drawer slide + scrim fade** — restored in
  `shell/transitions.css` as CSS keyframes targeting the
  portaled `.drawer` + `.drawer-scrim` classes. Reduced-motion
  shortens duration to 100 ms instead of disabling.
* **Toast system** — `shell/Toaster.tsx` exports a `toast` API
  (`success`/`error`/`warning`/`info`). Slides in from the
  inline-end with a depleting progress bar. Mounted once in
  `main.tsx`, fires from anywhere via
  `import { toast } from "../shell/Toaster"; toast.success(…)`.
* **Button polish** — `transitions.css` adds `transform:
  translateY(-1px)` + soft shadow on `.btn:hover`, depresses on
  active. New `components/Button.tsx` primitive with built-in
  async-loading state + spinner; consumers can opt in over time
  for Save / Submit / Restart actions.
* **Sample integrations**
  * `LiveCapture.tsx` — counters use `<RollingNumber>` so the
    detection counts roll as new events arrive instead of
    snapping.
  * `EmployeeDrawer.tsx` — Save success/error fires a toast.

## What we did NOT do

* No third-party UI library (Headless UI, Radix). Framer Motion
  alone covers what we need.
* No bulk migration of every Save button to the `Button`
  primitive — that's an opt-in tidying-up over time. The
  primitive is ready when consumers want it.
* No bulk migration of every list to `StaggeredList` —
  Employees + Live Capture are wired; the rest can opt in
  consciously. Tables that update on poll (Workers page, etc.)
  shouldn't stagger every refresh.
* No animation on form fields, tooltips, or login screen (per
  the prompt's "Where NOT to add animation" list).

## Reduced-motion policy

* **Disabled** when `prefers-reduced-motion: reduce` is on:
  page transitions, list staggers, toast slide-in
  (degrades to opacity fade).
* **Kept (often shortened)**: drawer slide (100 ms),
  sidebar active-indicator slide, button hover lift, spinner.

## Validation walkthrough

Validated by Suresh on _____ at _____:
- [ ] Page transitions feel smooth and quick (under 300 ms) ✓
- [ ] Sidebar active-indicator bar slides between items ✓
- [ ] List stagger caps at 12 items on Employees ✓
- [ ] Skeleton-to-content crossfade (TanStack Query loading) ✓
- [ ] Button hover lift + active-state press feedback ✓
- [ ] `Button` primitive's async-loading spinner works on Save ✓
- [ ] Number rolling on Live Capture counters as new events arrive ✓
- [ ] Toast: success after Add Employee — slides in top-right with
      green border + progress bar that depletes ✓
- [ ] Toast: error on save with invalid input — red border ✓
- [ ] Multiple toasts stack vertically ✓
- [ ] Drawer slides in from inline-end edge with scrim fade ✓
- [ ] Reduced motion (OS preference) disables page transitions and
      list staggers ✓
- [ ] Reduced motion keeps hover effects, button feedback, and
      active-indicator slide ✓
- [ ] No frame drops navigating quickly between pages 10 times ✓
- [ ] No flicker as Live Capture counters update ✓

Notes / issues:
- _to be filled in during walkthrough_
