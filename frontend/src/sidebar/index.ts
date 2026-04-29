// Sidebar collapse/expand store. Mirrors the P22 theme + density
// pattern (``frontend/src/theme/``): a tiny localStorage-backed
// store that flips a ``data-sidebar`` attribute on ``<html>``;
// the design CSS keys off that attribute to switch the sidebar to
// icon-only mode without requiring component-level branching.
//
// Device-local only — no server round-trip. A user's collapsed
// preference doesn't follow them across browsers, the way theme
// does. If we add server persistence later it slots into
// ``applyServerPreferences`` like the theme module.

export type SidebarState = "expanded" | "collapsed";

export const SIDEBAR_STATES: readonly SidebarState[] = [
  "expanded",
  "collapsed",
] as const;

const STORAGE_KEY = "maugood-sidebar";
const DEFAULT_STATE: SidebarState = "expanded";

let _state: SidebarState = readStored();

function readStored(): SidebarState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "collapsed" || v === "expanded") return v;
  } catch {
    // SSR or privacy-mode Safari — fall through to default.
  }
  return DEFAULT_STATE;
}

function applyToRoot(state: SidebarState) {
  document.documentElement.setAttribute("data-sidebar", state);
}

if (typeof document !== "undefined") {
  applyToRoot(_state);
}

const _listeners = new Set<() => void>();

function emit() {
  for (const fn of _listeners) fn();
}

export function subscribeSidebar(fn: () => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

export function getSidebar(): SidebarState {
  return _state;
}

export function setSidebar(state: SidebarState): void {
  if (state === _state) return;
  _state = state;
  try {
    localStorage.setItem(STORAGE_KEY, state);
  } catch {
    /* ignored — non-fatal */
  }
  applyToRoot(_state);
  emit();
}

export function toggleSidebar(): void {
  setSidebar(_state === "collapsed" ? "expanded" : "collapsed");
}
