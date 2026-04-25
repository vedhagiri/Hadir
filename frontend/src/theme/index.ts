// P22 — theme + density.
//
// The design's CSS already declares ``[data-theme="dark"]`` and
// ``[data-density="compact"]`` rules; this module just sets those
// attributes on ``<html>``. ``system`` watches
// ``prefers-color-scheme`` so the OS-level switch flips the UI
// without operator action.
//
// Detection order on app boot: localStorage > (no value) → system.
// AuthProvider then calls ``applyServerPreferences`` once
// ``/api/auth/me`` resolves, which can override what we picked
// from localStorage so a fresh login on another browser reflects
// the saved choice.

export type Theme = "system" | "light" | "dark";
export type Density = "compact" | "comfortable";

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;
export const DENSITIES: readonly Density[] = ["compact", "comfortable"] as const;

const THEME_KEY = "hadir-theme";
const DENSITY_KEY = "hadir-density";
const DEFAULT_THEME: Theme = "system";
const DEFAULT_DENSITY: Density = "comfortable";

let _theme: Theme = readStoredTheme();
let _density: Density = readStoredDensity();

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // SSR or privacy-mode safari — fall through.
  }
  return DEFAULT_THEME;
}

function readStoredDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === "compact" || v === "comfortable") return v;
  } catch {
    // ignored
  }
  return DEFAULT_DENSITY;
}

function effectiveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }
  return theme;
}

function applyToRoot(theme: Theme, density: Density) {
  const root = document.documentElement;
  // Always stamp the resolved value so CSS rules match without
  // having to know about "system".
  root.setAttribute("data-theme", effectiveTheme(theme));
  root.setAttribute("data-density", density);
}

// Boot: apply whatever localStorage had (or the defaults) so the
// first paint already matches the user's stored choice.
if (typeof document !== "undefined") {
  applyToRoot(_theme, _density);
}

// Re-apply when the OS scheme flips, but only while ``system`` is
// the active theme.
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (_theme === "system") applyToRoot(_theme, _density);
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
  } else if (typeof (mq as MediaQueryList).addListener === "function") {
    // Safari < 14
    (mq as MediaQueryList).addListener(onChange);
  }
}

const _listeners = new Set<() => void>();

function emit() {
  for (const fn of _listeners) fn();
}

/** Subscribe to theme/density changes. Returns an unsubscribe. */
export function subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

export function getTheme(): Theme {
  return _theme;
}

export function getDensity(): Density {
  return _density;
}

async function patchServer(
  url: string,
  body: Record<string, string | null>,
): Promise<void> {
  try {
    await fetch(url, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Network errors are non-fatal — the local choice still
    // applies until the user signs in elsewhere.
  }
}

export async function setTheme(theme: Theme): Promise<void> {
  _theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignored */
  }
  applyToRoot(_theme, _density);
  emit();
  await patchServer("/api/auth/preferred-theme", { preferred_theme: theme });
}

export async function setDensity(density: Density): Promise<void> {
  _density = density;
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* ignored */
  }
  applyToRoot(_theme, _density);
  emit();
  await patchServer("/api/auth/preferred-density", {
    preferred_density: density,
  });
}

/**
 * Apply the server-resolved preferences from ``/api/auth/me``
 * without firing another network call. ``null`` means "no stored
 * choice" — we leave the local boot value alone.
 */
export function applyServerPreferences(input: {
  theme?: Theme | null;
  density?: Density | null;
}): void {
  let dirty = false;
  if (input.theme && THEMES.includes(input.theme) && input.theme !== _theme) {
    _theme = input.theme;
    try {
      localStorage.setItem(THEME_KEY, _theme);
    } catch {
      /* ignored */
    }
    dirty = true;
  }
  if (
    input.density &&
    DENSITIES.includes(input.density) &&
    input.density !== _density
  ) {
    _density = input.density;
    try {
      localStorage.setItem(DENSITY_KEY, _density);
    } catch {
      /* ignored */
    }
    dirty = true;
  }
  if (dirty) {
    applyToRoot(_theme, _density);
    emit();
  }
}
