// Route-change fade + slight upward slide. Wraps the route render
// area so AnimatePresence can detect path changes.
//
// Outgoing page fades out + drifts up 8 px (150 ms-ish), new page
// fades in from 8 px below (200 ms). Total time per transition lands
// under 300 ms — fast enough that fast clicks feel responsive,
// slow enough to register as a transition.
//
// ``mode="wait"`` makes the outgoing page complete its exit before
// the new page starts entering. Without it, the two would overlap
// and React would have to render both subtrees simultaneously —
// expensive when the new page is data-heavy.

import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { DURATION, EASING } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

interface Props {
  children: ReactNode;
}

export function PageTransition({ children }: Props) {
  const location = useLocation();
  const reduce = useReducedMotion();

  if (reduce) {
    // No transition wrapper at all when the OS asks for reduced
    // motion. The user-prompt's policy: snap pages instantly.
    return <>{children}</>;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{
          duration: DURATION.normal,
          ease: EASING.smooth,
        }}
        // Important: the page-transition wrapper must NOT use
        // ``will-change: transform`` (which would create a containing
        // block for fixed-position descendants — see the prior
        // drawer-positioning fix). Framer Motion handles compositing
        // hints internally and only when an animation is actually
        // running; no will-change side-effect.
        style={{ width: "100%" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
