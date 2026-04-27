# Fix: drawer / modal portal rendering

**Date (UTC):** 2026-04-27
**Engineer:** Suresh (MTS) via Claude Code
**Severity:** UX-blocking. Every drawer + modal across the v1.0
frontend rendered inside the page-content container instead of as
a viewport-level overlay. Sidebar wasn't dimmed. Drawer footers
could clip. Started after P28.6 — was latent in earlier phases
because nothing else introduced a containing block.

## Root cause

P28.6 added a page-transition wrapper around the route's
``<Outlet />`` to fade + slide-up the content area on every
navigation:

```css
/* frontend/src/shell/transitions.css */
.page-transition {
  animation: hadir-page-enter 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform;
}

@keyframes hadir-page-enter {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

Per the CSS Positioning spec, **any ancestor with a non-``none``
``transform``, ``perspective``, ``filter``, or ``will-change``
becomes the containing block for ``position: fixed`` descendants**
([MDN: position](https://developer.mozilla.org/en-US/docs/Web/CSS/position#fixed)).

Every drawer in Hadir is rendered inside the route subtree:

```
<Layout>
  <Sidebar />
  <div className="main">
    <div className="content">
      <div className="content-wrap page-transition">  ← will-change here
        <Outlet />                                    ← drawer markup here
      </div>
    </div>
  </div>
</Layout>
```

So the drawer's ``position: fixed; inset: 0`` (scrim) and
``position: fixed; top: 0; right: 0; height: 100vh`` (panel) were
anchored to the ``.page-transition`` wrapper instead of the
viewport. The wrapper sits to the right of the sidebar, so:

* The scrim covered only the page content area — sidebar wasn't
  dimmed.
* The panel's ``height: 100vh`` measured against the viewport but
  was positioned relative to a wrapper that was offset down by the
  topbar — causing the bottom edge to render below the visible
  viewport, which clipped the drawer footer.

## Fix

Two-part fix in line with the prompt's recommendation:

1. **React Portal** moves the drawer DOM into a sibling of
   ``#root`` (a new ``<div id="drawer-root">`` in ``index.html``).
   Drawers render outside the route subtree entirely, so no
   ancestor can create a containing block. ``position: fixed``
   anchors to the viewport as the spec requires.

2. **Centralised shell** at ``frontend/src/components/DrawerShell.tsx``
   handles:
   * Portal mount + scrim
   * Body scroll lock while open
   * Escape-key close
   * Focus trap (Tab cycles within drawer; Shift-Tab cycles
     backward)
   * Auto-focus first focusable element on open
   * Restore focus to trigger on close
   * Optional ``dirty`` prop — when true, backdrop-click and
     Escape ask before closing (for Add/Edit forms)

Two exports:

* ``<DrawerShell open onClose={onClose}>`` — pinned to inline-end,
  full viewport height. Wraps the existing
  ``<div className="drawer">…</div>`` markup verbatim.
* ``<ModalShell open onClose={onClose}>`` — same lifecycle, used
  for centered confirmation dialogs.

The CSS classes (``.drawer``, ``.drawer-head``, ``.drawer-body``,
``.drawer-foot``) didn't change — the design tokens for sizing,
padding, and the flex column layout that pins the footer were
already correct in ``styles.css``. The only thing wrong was the
positioning context, and the portal solves that.

## Migration

Every drawer + modal in the codebase wrapped its existing
markup with the new shell. Diff per file is tiny:

```diff
- return (
-   <>
-     <div className="drawer-scrim" onClick={onClose} />
-     <div className="drawer">
+ return (
+   <DrawerShell onClose={onClose}>
+     <div className="drawer">
        <div className="drawer-head">…</div>
        <div className="drawer-body">…</div>
        <div className="drawer-foot">…</div>
      </div>
-   </>
+   </DrawerShell>
  );
```

The shell renders the scrim itself, so the consumer drops their
local scrim line.

## Files changed (15 consumers + shell + index.html)

Shell + portal target:
* ``frontend/index.html`` — added ``<div id="drawer-root">``
* ``frontend/src/components/DrawerShell.tsx`` (new)

Drawer consumers (DrawerShell):
* ``features/employees/EmployeeDrawer.tsx``
* ``features/cameras/CameraDrawer.tsx``
* ``features/calendar/DayDetailDrawer.tsx``
* ``features/attendance/AttendanceDrawer.tsx``
* ``features/operations/RecentErrorsDrawer.tsx``
* ``requests/NewRequestDrawer.tsx``
* ``requests/RequestDetailDrawer.tsx``

Modal consumers (ModalShell):
* ``features/employees/DeleteConfirmModal.tsx``
* ``features/employees/ImportModal.tsx``
* ``features/cameras/PreviewModal.tsx``
* ``features/operations/CameraMetadataModal.tsx``
* ``features/operations/RestartAllModal.tsx``
* ``features/operations/WorkerCard.tsx`` (inline ConfirmRestartModal)
* ``requests/OverrideModal.tsx``
* ``custom-fields/CustomFieldsPage.tsx`` (delete-confirm modal)
* ``pages/SystemSettings/SystemSettingsPage.tsx`` (reset-confirm modal)

Total: 17 files changed.

## What we kept

* ``transitions.css``'s ``will-change: opacity, transform`` on
  ``.page-transition`` — the portal moves drawer DOM out of that
  wrapper entirely, so ``position: fixed`` no longer anchors to
  it. The will-change is still useful for the page-enter
  animation's GPU compositing.
* All design CSS tokens and class names — visual design is
  unchanged.
* All existing drawer prop shapes — ``open`` / ``onClose`` /
  ``children`` plus an optional ``dirty`` for unsaved-form
  guards.

## What we did NOT do

* No third-party library (Headless UI, Radix, react-modal). The
  fix is small enough to do in-house and matches the existing
  primitive's API.
* No visual redesign. We're fixing positioning + structure only.
* No new mandatory props on the shell — every existing usage
  keeps working with ``onClose`` alone.

## Validation sign-off

Validated by Suresh on _____ at _____:
- [ ] Add Employee drawer slides in from the viewport edge ✓
- [ ] Backdrop dims the sidebar + topbar ✓
- [ ] Footer (Save / Cancel) stays pinned at bottom while body scrolls ✓
- [ ] Backdrop click closes ✓
- [ ] Escape key closes ✓
- [ ] Unsaved changes prompt on close-with-dirty-form ✓ (when caller passes ``dirty``)
- [ ] Focus trap works (Tab cycles within drawer) ✓
- [ ] Body scroll locks while drawer open ✓
- [ ] Calendar day-detail drawer ✓
- [ ] Cameras edit drawer ✓
- [ ] Operations Recent Errors drawer ✓
- [ ] Delete confirmation modal (centered) ✓
- [ ] Approvals override modal ✓
- [ ] Import Employees modal ✓
- [ ] Restart-all modal ✓
- [ ] Camera metadata modal ✓
- [ ] Custom-fields delete modal ✓
- [ ] System settings reset modal ✓
- [ ] Mobile / narrow viewport: drawer takes full width, footer still pinned ✓
