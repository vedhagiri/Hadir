// Lightweight toast system — slides in from the top-right with a
// progress bar that depletes over the 4-second show window.
//
// Usage from anywhere in the app:
//
//     import { toast } from "../shell/Toaster";
//     toast.success("Employee updated");
//     toast.error("Could not save");
//
// The Toaster mounts once near the React root (in ``main.tsx``).
// Toasts stack vertically when several fire in quick succession;
// AnimatePresence handles the slide-out gracefully.
//
// Variants: ``success`` (green), ``error`` (red), ``warning`` (amber),
// ``info`` (cyan/accent). Each gets a colour-coded left border.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { DURATION, EASING } from "../motion/tokens";
import { useReducedMotion } from "../motion/useReducedMotion";

export type ToastVariant = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

// Module-level state — single shared store. Subscribers re-render
// when the list changes. Keeps the API a flat ``toast.success("…")``
// without forcing every consumer to mount a context provider.
let nextId = 1;
let toasts: Toast[] = [];
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

function push(message: string, variant: ToastVariant, durationMs = 4000) {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant, durationMs }];
  notify();
  // Auto-dismiss after ``durationMs``. The progress bar's animation
  // duration matches; both fire from the same value so they stay in
  // sync.
  window.setTimeout(() => dismiss(id), durationMs);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export const toast = {
  success: (message: string, durationMs?: number) =>
    push(message, "success", durationMs),
  error: (message: string, durationMs?: number) =>
    push(message, "error", durationMs),
  warning: (message: string, durationMs?: number) =>
    push(message, "warning", durationMs),
  info: (message: string, durationMs?: number) =>
    push(message, "info", durationMs),
} as const;

// ---------------------------------------------------------------------------
// Variant styling — small mapping kept inline so each variant pulls
// from the design tokens.
// ---------------------------------------------------------------------------

const VARIANT_STYLES: Record<
  ToastVariant,
  { border: string; iconColor: string; iconName: "check" | "x" | "bell" | "info" }
> = {
  success: {
    border: "var(--success, #15a34a)",
    iconColor: "var(--success, #15a34a)",
    iconName: "check",
  },
  error: {
    border: "var(--danger)",
    iconColor: "var(--danger)",
    iconName: "x",
  },
  warning: {
    border: "var(--warning, #d97706)",
    iconColor: "var(--warning, #d97706)",
    iconName: "bell",
  },
  info: {
    border: "var(--accent)",
    iconColor: "var(--accent)",
    iconName: "info",
  },
};

// ---------------------------------------------------------------------------
// Component — mounted once at the app root.
// ---------------------------------------------------------------------------

export function Toaster() {
  const [, forceRender] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const cb = () => forceRender((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  return (
    <div
      role="region"
      aria-label="Notifications"
      style={{
        position: "fixed",
        top: 16,
        insetInlineEnd: 16,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const style = VARIANT_STYLES[t.variant];
          return (
            <motion.div
              key={t.id}
              layout
              initial={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, x: 100 }
              }
              animate={{ opacity: 1, x: 0 }}
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, x: 100 }
              }
              transition={{
                duration: reduce ? DURATION.fast : DURATION.normal,
                ease: EASING.smooth,
              }}
              style={{
                pointerEvents: "auto",
                width: 320,
                maxWidth: "calc(100vw - 32px)",
                background: "var(--bg-elev)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderInlineStart: `4px solid ${style.border}`,
                borderRadius: "var(--radius-sm)",
                boxShadow: "var(--shadow-lg)",
                padding: "10px 12px",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: 13,
                  lineHeight: 1.4,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    color: style.iconColor,
                    display: "inline-flex",
                    marginTop: 2,
                  }}
                >
                  <Icon name={style.iconName} size={14} />
                </span>
                <div style={{ flex: 1, wordBreak: "break-word" }}>
                  {t.message}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="icon-btn"
                  style={{ width: 20, height: 20, marginTop: -2 }}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
              {/* Progress bar — depletes over the toast's lifetime so
                  the user can see how long until it auto-dismisses.
                  Reduced-motion users get a static visible bar
                  (we keep the toast's auto-timeout via setTimeout). */}
              {!reduce && (
                <motion.div
                  aria-hidden
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{
                    duration: t.durationMs / 1000,
                    ease: "linear",
                  }}
                  style={{
                    position: "absolute",
                    insetInlineStart: 0,
                    bottom: 0,
                    height: 2,
                    width: "100%",
                    background: style.border,
                    transformOrigin: "left",
                  }}
                />
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
