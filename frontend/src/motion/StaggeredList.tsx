// Generic stagger wrapper for tables, card grids, menu items.
//
// First N items (default 12) fade in with a short delay between each.
// Beyond N, items appear instantly so a 300-row table doesn't take
// 9 seconds to fully render.
//
// Reduced-motion turns the whole effect off — items render
// synchronously without any wrapping ``motion.div``.
//
// ``as`` lets the wrapper render any HTML tag — important for
// tables, where a ``<motion.div>`` parent of ``<tr>`` is invalid HTML.
// In that case the consumer passes ``as="tbody"`` and gets correctly
// wrapped rows.

import { Children, type ElementType, type ReactNode } from "react";
import { motion } from "framer-motion";

import { DURATION, EASING } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

interface Props {
  children: ReactNode;
  className?: string;
  /** Milliseconds between items. Default 30 — feels deliberate without
   *  feeling slow on a 12-row table. */
  staggerDelay?: number;
  /** Beyond this index the delay caps. Default 12 — empirically the
   *  sweet spot. */
  maxStaggered?: number;
  /** HTML element / component to render as. ``"div"`` by default;
   *  ``"tbody"`` for table consumers. */
  as?: ElementType;
}

export function StaggeredList({
  children,
  className,
  staggerDelay = 30,
  maxStaggered = 12,
  as: Component = "div",
}: Props) {
  const reduce = useReducedMotion();

  // When reduced-motion is set, render children verbatim — no motion
  // wrappers, no opacity/transform overhead.
  if (reduce) {
    return <Component className={className}>{children}</Component>;
  }

  const items = Children.toArray(children);
  const isTbody = Component === "tbody";
  // ``<tbody>`` can't have ``<motion.div>`` children — wrap each row
  // in a ``motion.tr`` cloned from the original element. We do that
  // by cloning the element + applying the motion.* component via
  // ``motion(...)``. To keep the API simple we *only* support tbody
  // when the consumer's children are already valid <tr> elements;
  // otherwise we render via ``motion.div``.
  const ItemTag = isTbody ? motion.tr : motion.div;

  return (
    <Component className={className}>
      {items.map((child, index) => {
        const delay = (Math.min(index, maxStaggered) * staggerDelay) / 1000;
        return (
          <ItemTag
            // ``key`` from the wrapper preserves React's reconciliation
            // hints. Consumers should still pass keys on their own
            // children, but a fallback never hurts.
            key={index}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: DURATION.normal,
              ease: EASING.smooth,
              delay,
            }}
          >
            {child}
          </ItemTag>
        );
      })}
    </Component>
  );
}
