// Shared drawer + modal shell — fixes the P28.6 page-transition
// containing-block bug + centralises lifecycle plumbing.
//
// **Why this exists**
//
// Every drawer in Hadir was rendered inside the route's JSX tree:
//
//   <Layout>
//     <Sidebar />
//     <main>
//       <Outlet />           ← drawer markup lives here
//     </main>
//   </Layout>
//
// The drawer CSS (``.drawer { position: fixed; … }`` in
// styles.css L890) is correct in isolation. But P28.6 added a
// page-transition wrapper around ``<Outlet />`` that uses
// ``will-change: opacity, transform``, and the keyframes apply a
// transient ``transform: translateY(6px)`` during the page-enter
// animation.
//
// Per the CSS Positioning spec, **any ancestor with ``transform``,
// ``perspective``, ``filter``, or ``will-change`` other than
// ``auto`` becomes the containing block for ``position: fixed``
// descendants**. So the drawer's ``inset: 0`` scrim was anchored to
// the page-transition wrapper (which sits *to the right of the
// sidebar*), not the viewport. Sidebar wasn't dimmed; the drawer
// could land below the wrapper's height and clip its footer.
//
// **The fix** (this file)
//
// React Portal moves the drawer DOM into ``#drawer-root`` (a sibling
// of ``#root`` in ``index.html``) — outside any ancestor that could
// create a containing block. ``position: fixed`` then anchors to
// the viewport as the spec requires. Consumers don't have to change
// their CSS classes — the existing ``.drawer`` / ``.drawer-scrim``
// styles still apply.
//
// On top of the portal we centralise:
// * Body scroll lock while open.
// * Escape-key close.
// * Focus trap (Tab cycles within the drawer).
// * Restore-focus-to-trigger on close.
// * Optional ``dirty`` prop — when true, backdrop click + Escape
//   ask before closing (for Add/Edit forms with unsaved state).
//
// Migration is one line per consumer:
//
//   <>                                       ⟶  <DrawerShell open onClose={onClose}>
//     <div className="drawer-scrim" />               <div className="drawer">…</div>
//     <div className="drawer">…</div>            </DrawerShell>
//   </>
//
// The shell renders the scrim itself, so the consumer drops their
// own scrim line. Modal consumers do the same with ``ModalShell``.

import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// Selector that captures every realistically focusable element in
// the drawer body. Trimmed to the subset Hadir actually uses (no
// contenteditable, no audio/video controls).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ShellProps {
  /** Renders nothing when false. Mounts the portal + locks the body
   *  scroll when true. Most callers always render their drawer
   *  conditionally so ``open`` defaults to true; the prop exists for
   *  consumers that want to keep the drawer mounted but hidden. */
  open?: boolean;
  /** Called when the backdrop is clicked or Escape is pressed. */
  onClose: () => void;
  /** When true, ``onClose`` is wrapped in a confirm dialog so the
   *  user doesn't lose form state by clicking outside. */
  dirty?: boolean;
  children: ReactNode;
}

function useDrawerLifecycle({
  open,
  hostRef,
}: {
  open: boolean;
  hostRef: React.RefObject<HTMLDivElement>;
}) {
  // Body scroll lock.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Capture + restore focus around the open lifecycle.
  useEffect(() => {
    if (!open) return;
    const trigger = (document.activeElement as HTMLElement) ?? null;
    return () => {
      // Defer one tick so the destination element is mounted.
      window.setTimeout(() => trigger?.focus?.(), 0);
    };
  }, [open]);

  // Auto-focus the first focusable element inside the drawer.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const node = hostRef.current;
      if (!node) return;
      const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [open, hostRef]);

  // Tab / Shift-Tab cycles within the drawer to keep focus trapped.
  // Esc no longer closes — operator-policy red line: drawers and
  // modals close ONLY via the explicit Close button rendered by the
  // wrapped panel. Same red line drops the backdrop-click handler in
  // ``Shell`` below. ``requestClose`` is still wired so child Close
  // buttons can call it programmatically.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const node = hostRef.current;
      if (!node) return;
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, hostRef]);
}

function Shell({
  open = true,
  // ``onClose`` and ``dirty`` are accepted for back-compat with
  // every existing call site, but the Shell no longer triggers
  // close itself. Each panel's explicit Close button calls
  // ``onClose`` directly. The dirty-on-close confirm prompt that
  // used to live here was removed alongside backdrop-click + Esc;
  // a panel that needs the prompt should run it in its own button
  // handler.
  onClose: _onClose,
  dirty: _dirty = false,
  children,
}: ShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useDrawerLifecycle({ open, hostRef });

  if (!open) return null;
  const target =
    typeof document !== "undefined"
      ? document.getElementById("drawer-root")
      : null;
  if (target === null) return null;

  return createPortal(
    <div
      ref={hostRef}
      // Host wrapper has no layout of its own — it just collects
      // the children for the focus trap. The scrim + the actual
      // panel(s) supplied by the caller carry their own
      // ``position: fixed`` styles from the design CSS.
      style={{ display: "contents" }}
    >
      {/* Backdrop is presentation-only — close happens via the
          explicit Close button rendered by the wrapped panel. The
          Esc key + outside-click affordances were removed alongside
          this; both lived on the same red line. */}
      <div className="drawer-scrim" aria-hidden="true" />
      {children}
    </div>,
    target,
  );
}

/** Drawer shell — pinned to the inline-end edge, full viewport
 *  height. Wrap the existing ``<div className="drawer">…</div>``
 *  markup with this; the shell renders the scrim + manages
 *  lifecycle. */
export function DrawerShell(props: ShellProps): JSX.Element | null {
  return <Shell {...props} />;
}

/** Modal shell — centered. Wrap the existing centered
 *  ``<div role="dialog" style={{ position: "fixed", top: "50%", … }}>``
 *  markup with this. The shell renders the scrim + manages
 *  lifecycle; the wrapped element keeps its existing width and
 *  centering styles. */
export function ModalShell(props: ShellProps): JSX.Element | null {
  return <Shell {...props} />;
}
