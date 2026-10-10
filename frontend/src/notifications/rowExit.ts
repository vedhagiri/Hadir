// Row exit animation for clearing notifications — the same motion as the
// LPA upload list's file remove: the row fades and slides 20px toward the
// end edge (200ms, ease-in), then its own height eases shut (260ms) so the
// rows below close the gap smoothly instead of snapping up.
//
// Built on the Web Animations API (no animation library). Resolves when
// the row is gone so the caller can commit the state change; with
// reduced motion it resolves immediately.

const EASE_IN = "cubic-bezier(0.55, 0, 1, 0.45)"; // ≈ power2.in
const EASE_INOUT = "cubic-bezier(0.65, 0, 0.35, 1)"; // ≈ power3.inOut

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export async function animateRowOut(row: HTMLElement | null, delayMs = 0, collapse = true): Promise<void> {
  if (!row || reducedMotion() || typeof row.animate !== "function") return;
  const rtl = getComputedStyle(row).direction === "rtl";
  const h = row.offsetHeight;
  const cs = getComputedStyle(row);
  row.style.overflow = "hidden";
  row.style.pointerEvents = "none";

  const slide = row.animate(
    [
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${rtl ? -20 : 20}px)` },
    ],
    { duration: 200, delay: delayMs, easing: EASE_IN, fill: "forwards" },
  );
  await slide.finished.catch(() => undefined);
  if (!collapse) return;

  const shut = row.animate(
    [
      { height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, borderBottomWidth: cs.borderBottomWidth },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", borderBottomWidth: "0px" },
    ],
    { duration: 210, easing: EASE_INOUT, fill: "forwards" },
  );
  await shut.finished.catch(() => undefined);
}

/** Clear all: rows fade + slide out in a quick top-to-bottom cascade.
 *  No height collapse — the whole list is replaced by the empty state
 *  right after, so collapsing each row would only open blank gaps. */
export async function animateRowsOut(rows: HTMLElement[]): Promise<void> {
  // Cap the cascade so a long list still clears in well under a second.
  const step = Math.min(40, 320 / Math.max(rows.length, 1));
  await Promise.all(rows.map((r, i) => animateRowOut(r, Math.round(i * step), false)));
}
