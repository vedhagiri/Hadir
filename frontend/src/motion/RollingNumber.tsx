// Rolling counter — animates digit changes instead of snapping.
//
// Used on Live Capture stats, Worker monitoring counters, dashboard
// summary numbers. NOT used on prices, IDs, dates, or anything where
// a wrong intermediate value would be confusing.
//
// Implementation: Framer Motion's ``useSpring`` over a numeric
// ``MotionValue``, displayed via ``useTransform``. Reduced-motion
// short-circuits to the raw value (no spring).

import { useEffect } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";

import { useReducedMotion } from "./useReducedMotion";

interface Props {
  /** The target value. Updates trigger a smooth animation toward it. */
  value: number;
  /** Optional formatter — defaults to ``Math.round``-then-toString.
   *  Override for percentages, decimal places, etc. */
  format?: (n: number) => string;
  /** Spring stiffness override; default tuned for "feels alive but
   *  not bouncy". */
  stiffness?: number;
  /** Spring damping override. */
  damping?: number;
}

export function RollingNumber({
  value,
  format = (n) => Math.round(n).toString(),
  stiffness = 100,
  damping = 30,
}: Props) {
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(value);
  const spring = useSpring(motionValue, { stiffness, damping });
  const display = useTransform(spring, (n) => format(n));

  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  if (reduce) {
    return <span>{format(value)}</span>;
  }

  return <motion.span>{display}</motion.span>;
}
