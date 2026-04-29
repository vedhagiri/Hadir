# Fix: drawer/modal panels render inside container instead of as proper overlay

**Status:** Bug fix during pre-Omran validation. Affects every drawer-style panel in the app.

## What's broken

The Add Employee panel (and likely Edit, Delete confirmation, Calendar day-detail, Live Capture errors drawer, and every other drawer-style panel built across P28.5/P28.6/P28.7) renders **inside the main content container** instead of as a proper full-viewport overlay. Symptoms in the current state:

1. Drawer is visually constrained to the right portion of the main content area, not the right edge of the viewport
2. Sidebar and topbar are visible at full brightness — there's no backdrop dimming the rest of the UI
3. Form footer (Save / Cancel buttons) is cut off or invisible because the drawer's height is bounded by its parent container, not the viewport
4. Clicking outside the drawer doesn't close it (no backdrop click handler — because there's no backdrop)
5. Tab / keyboard focus can escape the drawer to the page behind it (no focus trap)

This is a **shared component bug**, not specific to the Employees page. The fix is at the drawer primitive layer, which propagates to every page that uses it.

## What it should look like

`design-reference/pages.jsx` shows the canonical drawer pattern (look at the Edit Employee mockup, the Calendar day-detail drawer, and any other slide-in panels). Those are the source of truth. Whatever spacing, width, animation, backdrop opacity, header/footer treatment they specify — match exactly. Do not redesign.

In broad terms: drawer slides in from the right edge of the **viewport** (not the content area), full viewport height, fixed width per design (around 480–640px), with a semi-transparent backdrop dimming everything behind it. Sidebar and topbar are dimmed too — the drawer is the only fully-bright thing on screen while open.

---

## The prompt to paste into Claude Code

> A bug affects every drawer/modal panel in the Maugood frontend. The Add Employee panel renders inside the main content container instead of as a viewport-level overlay. The sidebar isn't dimmed. The form footer is cut off. The same defect almost certainly affects every other drawer-style panel built in P28.5/P28.6/P28.7 because they all share the same primitive.
>
> Read these files in order before writing anything:
>
> 1. `design-reference/pages.jsx` — find the Edit Employee drawer, the Calendar day-detail drawer, any modal patterns. Note their exact width, padding, header/footer structure, animation, and backdrop styling.
> 2. `design-reference/styles.css` (and any companion CSS) — for the design tokens around overlay (`--overlay-bg`, `--drawer-width`, `--z-overlay`, etc., or whatever your tokens are called)
> 3. `frontend/src/` — find the shared drawer/modal primitive. It's likely at `frontend/src/components/Drawer.tsx` or `frontend/src/components/Modal.tsx` or `frontend/src/shell/Overlay.tsx`. Search for the file every drawer page imports from.
> 4. **Every page that uses the drawer:**
>    - `frontend/src/pages/Employees/EditDrawer.tsx` (or AddDrawer)
>    - `frontend/src/pages/Calendar/DayDetailDrawer.tsx`
>    - `frontend/src/pages/Operations/RecentErrorsDrawer.tsx` (P28.8 if built)
>    - any `*Drawer.tsx` or `*Modal.tsx` files
> 5. `frontend/src/index.tsx` or `main.tsx` — for the React root setup. We may need to add a portal target.
> 6. Take a look at the actual rendered DOM in the user's screenshot context: the drawer is `<div>` nested inside `<main>` — confirm by inspecting in the browser if needed.
>
> ### Diagnosis
>
> The drawer is rendering as a child of the page's main content area, not as a child of `document.body`. That makes it inherit the main area's positioning context (which is offset by the sidebar's width) and bounded by its height. The fix is one of:
>
> 1. **React Portal** — drawer renders into a top-level `<div id="drawer-root">` mounted on body, regardless of where in the component tree it's invoked. Standard React solution.
> 2. **Fixed positioning at viewport level** — `position: fixed; inset: 0;` for the backdrop, drawer pinned to `right: 0; top: 0; height: 100vh;`. Even without a portal, fixed positioning escapes container constraints (most of the time — `transform` or `filter` on an ancestor can break this).
> 3. **Both** — most robust answer. Portal handles the DOM tree; fixed positioning handles the visual.
>
> **Use Option 3 — both.** The portal-only approach can break if a parent container has `overflow: hidden` and the drawer is wider than the parent. Fixed-position-only can break if any ancestor has `transform`, `filter`, or `will-change`. Doing both eliminates both classes of bug.
>
> ### The fix
>
> Make these changes to the shared drawer primitive (whatever its actual file path):
>
> 1. **Add a portal mount point in `index.html`** (or wherever the root HTML is):
>    ```html
>    <div id="root"></div>
>    <div id="drawer-root"></div>  <!-- new, sibling to root -->
>    ```
>
> 2. **Update the Drawer component** to use `createPortal`:
>    ```tsx
>    import { createPortal } from 'react-dom';
>    import { useEffect } from 'react';
>
>    export function Drawer({ open, onClose, title, children, footer, width = 'standard' }) {
>      // Lock body scroll while open
>      useEffect(() => {
>        if (!open) return;
>        const prev = document.body.style.overflow;
>        document.body.style.overflow = 'hidden';
>        return () => { document.body.style.overflow = prev; };
>      }, [open]);
>
>      // Escape key closes
>      useEffect(() => {
>        if (!open) return;
>        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
>        window.addEventListener('keydown', handler);
>        return () => window.removeEventListener('keydown', handler);
>      }, [open, onClose]);
>
>      if (!open) return null;
>
>      const target = document.getElementById('drawer-root');
>      if (!target) return null;
>
>      return createPortal(
>        <div className="drawer-overlay" onClick={onClose}>
>          <div
>            className={`drawer drawer--${width}`}
>            onClick={(e) => e.stopPropagation()}
>            role="dialog"
>            aria-modal="true"
>          >
>            <header className="drawer__header">
>              <h2>{title}</h2>
>              <button onClick={onClose} aria-label="Close" className="drawer__close">×</button>
>            </header>
>            <div className="drawer__body">
>              {children}
>            </div>
>            {footer && <footer className="drawer__footer">{footer}</footer>}
>          </div>
>        </div>,
>        target
>      );
>    }
>    ```
>
>    Adapt to whatever conventions the existing component already follows (className naming, prop shape). The structural change is: portal + the three-section layout (header / body / footer) where body scrolls and footer stays pinned.
>
> 3. **CSS** — drawer occupies the right edge of the viewport with proper sizing:
>    ```css
>    .drawer-overlay {
>      position: fixed;
>      inset: 0;
>      background: var(--overlay-bg, rgba(0, 0, 0, 0.4));
>      z-index: var(--z-overlay, 100);
>      display: flex;
>      justify-content: flex-end;
>      animation: fadeIn 150ms ease-out;
>    }
>
>    .drawer {
>      background: var(--surface);
>      height: 100vh;
>      display: flex;
>      flex-direction: column;
>      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.1);
>      animation: slideInRight 200ms ease-out;
>    }
>
>    .drawer--standard { width: min(560px, 100vw); }
>    .drawer--wide { width: min(720px, 100vw); }
>    .drawer--narrow { width: min(420px, 100vw); }
>
>    .drawer__header {
>      padding: 24px;
>      border-bottom: 1px solid var(--border);
>      display: flex;
>      justify-content: space-between;
>      align-items: flex-start;
>      flex-shrink: 0;
>    }
>
>    .drawer__body {
>      flex: 1 1 auto;
>      overflow-y: auto;
>      padding: 24px;
>    }
>
>    .drawer__footer {
>      padding: 16px 24px;
>      border-top: 1px solid var(--border);
>      display: flex;
>      gap: 12px;
>      justify-content: flex-end;
>      flex-shrink: 0;       /* never collapse — this is the bug we're fixing */
>      background: var(--surface);
>    }
>
>    @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
>    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
>    ```
>
>    Use the actual design tokens from `design-reference/styles.css`. The width values, padding, animations should all come from the tokens, not be hardcoded. The structural CSS — `flex-direction: column`, `flex: 1 1 auto` on the body, `flex-shrink: 0` on header and footer — is the part that fixes the cut-off footer bug. Don't change that part.
>
> 4. **Modal primitive** (for confirmations like delete) — same portal pattern, different layout: centered instead of pinned right. If the project doesn't have a separate Modal primitive yet, share the portal+overlay logic between Drawer and Modal via a base `Overlay` component that both extend.
>
> 5. **Body scroll lock** — `document.body.style.overflow = 'hidden'` while drawer is open. Without this, the page behind the drawer can be scrolled with the wheel which is jarring. Restore on close.
>
> 6. **Focus trap** — basic trap that catches Tab/Shift-Tab and cycles within the drawer. Don't pull in a heavy focus-trap library; a 20-line implementation handles 95% of cases. Focus the first focusable element on open. On close, restore focus to whatever was focused before the drawer opened.
>
> 7. **Backdrop click** — clicks on the dimmed area close the drawer. Already in the snippet above (`onClick={onClose}` on the overlay, `e.stopPropagation()` on the drawer body).
>
> 8. **For drawers with unsaved form changes** (Add/Edit Employee, Camera form), backdrop-click and Escape should prompt "You have unsaved changes — discard?" before closing. Add a `dirty` prop to the Drawer; if true, intercept close events. Implementation can be simple — track form-modified state in the parent and pass it down.
>
> ### Other places to update
>
> Once the shared primitive is fixed, audit every consumer:
>
> 1. `frontend/src/pages/Employees/` — Add, Edit, Delete confirmation, View
> 2. `frontend/src/pages/Calendar/DayDetailDrawer.tsx` (P28.6) — should already use the primitive but verify positioning is correct now
> 3. `frontend/src/pages/Cameras/EditDrawer.tsx` (existing P7) — likely has the same defect
> 4. `frontend/src/pages/Operations/` (P28.8 if built) — RecentErrorsDrawer, RestartAllModal, CameraMetadataModal
> 5. `frontend/src/pages/LiveCapture/` (P28.5a) — any drawer/modal there
> 6. `frontend/src/pages/Approvals/` (P15) — request decision modal
> 7. Anywhere else `*Drawer.tsx` or `*Modal.tsx` exists
>
> Each of these should now Just Work after the primitive is fixed. Worth manually verifying each one. If any of them was using a different ad-hoc drawer instead of the shared one, migrate it to the shared one — don't fix in two places.
>
> ### Tests
>
> Write a frontend test for the Drawer primitive:
> - Renders into `#drawer-root` (assert `parentElement` matches that ID)
> - Backdrop click triggers `onClose`
> - Drawer body click does NOT trigger onClose (event propagation stopped)
> - Escape key triggers onClose
> - Body scroll is locked when open, restored on close
> - Focus is trapped within the drawer (Tab from last focusable wraps to first)
>
> If the project has Playwright/Cypress for E2E, add one test that opens Add Employee, fills the form, scrolls the body, confirms Save button stays visible at the bottom.
>
> ### What NOT to do
>
> - Don't pull in a third-party drawer library (Headless UI, Radix, etc.) just for this. The fix is small enough to do in-house and matches the existing primitive's API.
> - Don't change the visual design — match `design-reference/pages.jsx` exactly. We're fixing positioning and structure, not visuals.
> - Don't add new props to the Drawer that consumers will have to migrate to. The fix should be purely internal — every existing `<Drawer open={...} onClose={...} title={...}>` keeps working.
>
> ---
>
> ### 🚦 VALIDATION MILESTONE
>
> #### Setup
> 1. `docker compose restart frontend` (or `npm run dev` restart)
>
> #### Employees page — primary test
> 2. Log in as `admin@mts-demo.example.com`. Navigate to Employees.
> 3. Click "Add employee". Drawer slides in from the right edge of the **viewport** (not from the right edge of the main content area).
> 4. Sidebar and topbar are visibly dimmed by the backdrop.
> 5. Drawer extends from top of viewport to bottom — no gap above or below.
> 6. Form fields (Identity, Assignment, Joining & Relieving, Status) all visible.
> 7. **Footer with Save / Cancel buttons is visible at the bottom of the drawer at all times.** Even when scrolling within the form body, the footer stays pinned.
> 8. Scroll the form body — only the body scrolls; header and footer stay fixed.
> 9. Click outside the drawer (on the dimmed backdrop). Drawer closes.
> 10. Open again. Press Escape. Drawer closes.
> 11. Open again. Fill in some fields. Click outside — confirmation prompt appears asking to discard unsaved changes.
> 12. Open again. Tab through form fields — focus stays within the drawer, doesn't escape to the dimmed page behind.
>
> #### Edit Employee
> 13. Click pencil icon on a row. Edit drawer opens with all fields populated. Same checks as above (footer pinned, scrollable body, backdrop dimmed, etc.).
>
> #### Delete confirmation
> 14. Click trash icon. Confirmation modal appears (centered, smaller). Backdrop dimmed. Same close behaviors (Escape, backdrop click).
>
> #### Other pages — verify the fix propagated
> 15. Calendar → click any day cell → Day detail drawer. Confirm same correct behavior.
> 16. Cameras → click any camera edit → drawer opens correctly.
> 17. Live Capture → if any drawer or modal exists there, confirm.
>
> #### Mobile / narrow viewport
> 18. Resize browser to ~600px wide. Drawer takes full viewport width. Body still scrolls. Footer still pinned.
>
> #### Sign-off block
>
> Append to `docs/phases/fix-drawer-positioning.md`:
>
> ```
> ## Fix: drawer/modal viewport positioning
>
> Validated by Suresh on <date>:
> - Add Employee drawer slides in from viewport edge ✓
> - Backdrop dims sidebar + topbar ✓
> - Footer stays pinned at bottom while body scrolls ✓
> - Backdrop click closes ✓
> - Escape key closes ✓
> - Unsaved changes prompt on close-with-dirty-form ✓
> - Focus trap works ✓
> - Body scroll locks while drawer open ✓
> - Same fix propagated to: Calendar drawer, Cameras drawer, Delete modal, etc. ✓
> ```
>
> Commit as `fix: drawer/modal portal rendering with proper viewport positioning`. Stop and show Suresh.

---

## Why this matters beyond just looking right

Three real-world problems that the broken drawer creates, even if it looks "kind of fine" in static screenshots:

1. **Form data loss.** When the footer is hidden, users sometimes can't find Save and close the drawer thinking it auto-saves. It doesn't. They lose their input. Pinning the footer eliminates this.

2. **Accidental dismissal.** Without a backdrop, clicking on what looks like dimmed UI doesn't actually close the drawer (or worse, it triggers actions on the page behind). Confusing and inconsistent.

3. **Accessibility regression.** Screen readers and keyboard-only users can navigate to the page behind the drawer, even though visually the drawer "should" be modal. Focus trap + backdrop + portal together are what makes a drawer actually modal in the accessibility sense, not just visually.

The fix is small (one component, ~80 lines) and propagates everywhere. Worth the 90 minutes.
