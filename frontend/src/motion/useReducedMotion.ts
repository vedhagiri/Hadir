// Reduced-motion gate.
//
// Maugood's policy (compromise tier — short spatial cues stay):
// * Page transitions + list staggers — DISABLED when this returns true.
// * Hover effects, button feedback, sidebar active-indicator slide —
//   ALWAYS on (short, not vestibular triggers).
// * Drawer slide-in — kept but shortened (the slide is part of the
//   spatial model; without it the drawer just appears, confusingly).
//
// Wraps Framer's own hook so the policy lives in one place + the
// fallback (no preference set yet) is normalised to ``false``.

import { useReducedMotion as useFmReducedMotion } from "framer-motion";

export function useReducedMotion(): boolean {
  return useFmReducedMotion() ?? false;
}
