// Marks table wrappers whose table is wider than the space it has.
//
// Why: a sticky ``<th>`` can only pin to the page scroller (.content)
// when no ancestor between it and .content is a scroll container. On
// desktop, theme/modern.css releases table wrappers to
// ``overflow: visible`` so headers pin under the topbar. That is only
// safe while the table fits; a table wider than its card would then
// push the whole page sideways. So we measure: every ancestor of an
// overflowing table (up to .content) gets ``data-table-overflow``, and
// the CSS release skips those, leaving the wrapper's own horizontal
// scroll in place (header scrolls with the rows there — no overlap).
//
// A table's width doesn't depend on its wrapper's overflow value, so
// toggling the attribute can't feed back into the measurement.

import { useEffect, type RefObject } from "react";

const ATTR = "data-table-overflow";

export function useTableFit(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    const check = () => {
      raf = 0;
      const marked = new Set<Element>();
      root.querySelectorAll<HTMLTableElement>("table.table").forEach((table) => {
        const box = table.parentElement;
        if (!box) return;
        // Compare against the space the table is laid out in.
        const overflowing = table.offsetWidth > box.clientWidth + 1;
        if (!overflowing) return;
        for (let el: Element | null = box; el && el !== root; el = el.parentElement) {
          marked.add(el);
        }
      });
      root.querySelectorAll(`[${ATTR}]`).forEach((el) => {
        if (!marked.has(el)) el.removeAttribute(ATTR);
      });
      marked.forEach((el) => {
        if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, "");
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };

    // Re-check when the viewport / sidebar width changes and whenever a
    // page renders or replaces its rows (childList only — our own
    // attribute writes must not retrigger the observer).
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true });
    schedule();

    return () => {
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef]);
}
