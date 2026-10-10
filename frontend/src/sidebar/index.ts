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
//
// The same store also remembers which nav *sections* the user has
// folded shut on the wide sidebar (``groups``). Absent means open,
// so a new section ships expanded without a migration; only an
// explicit collapse is stored.

export type SidebarState = "expanded" | "collapsed";

export const SIDEBAR_STATES: readonly SidebarState[] = [
  "expanded",
  "collapsed",
] as const;

const STORAGE_KEY = "maugood-sidebar";
const GROUPS_KEY = "maugood-sidebar-groups";
const DEFAULT_STATE: SidebarState = "expanded";

export type SidebarGroups = Readonly<Record<string, boolean>>;

let _state: SidebarState = readStored();
let _groups: SidebarGroups = readStoredGroups();

function readStored(): SidebarState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "collapsed" || v === "expanded") return v;
  } catch {
    // SSR or privacy-mode Safari — fall through to default.
  }
  return DEFAULT_STATE;
}

function readStoredGroups(): SidebarGroups {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === false) out[k] = false;
      }
      return out;
    }
  } catch {
    // Corrupt value — treat as "everything open".
  }
  return {};
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

/** Which sections are folded shut: ``false`` = closed, absent = open. */
export function getSidebarGroups(): SidebarGroups {
  return _groups;
}

export function isSidebarGroupOpen(id: string): boolean {
  return _groups[id] !== false;
}

export function toggleSidebarGroup(id: string): void {
  const next: Record<string, boolean> = { ..._groups };
  if (next[id] === false) delete next[id];
  else next[id] = false;
  _groups = next;
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(_groups));
  } catch {
    /* ignored — non-fatal */
  }
  emit();
}
