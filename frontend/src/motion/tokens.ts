// Motion tokens — the single source of truth for animation timing
// across Hadir. Tune the whole app's feel from this file.

export const DURATION = {
  /** ~100 ms — for button presses and other "just barely felt" feedback. */
  instant: 0.1,
  /** ~150 ms — skeleton crossfade, scrim fade. */
  fast: 0.15,
  /** ~200 ms — page transitions, list stagger items, drawer scrim. */
  normal: 0.2,
  /** ~300 ms — drawer slide-in, larger entrances. */
  slow: 0.3,
  /** ~400 ms — long entrances; rare. */
  slower: 0.4,
} as const;

// Cubic-bezier curves shaped after Linear's signature easing.
// `as const` arrays of length 4 are how Framer Motion expects custom
// easings.
export const EASING = {
  /** Linear's signature smooth ease — emphasis on out, gentle on in. */
  smooth: [0.4, 0.0, 0.2, 1] as const,
  /** Snappy press for buttons + active indicators. */
  snappy: [0.5, 0.0, 0.2, 1] as const,
  /** Entrance — settles into place. */
  entrance: [0.0, 0.0, 0.2, 1] as const,
  /** Exit — accelerates out. */
  exit: [0.4, 0.0, 1.0, 1] as const,
} as const;

// Spring presets for layout/handoff animations (the sidebar active
// indicator + drawer slide use these).
export const SPRING = {
  gentle: { type: "spring", stiffness: 300, damping: 30 } as const,
  bouncy: { type: "spring", stiffness: 400, damping: 17 } as const,
  stiff: { type: "spring", stiffness: 500, damping: 35 } as const,
} as const;
