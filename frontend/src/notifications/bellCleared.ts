// "Clear" hides notifications from a view — nothing is ever deleted.
// The bell and the Notifications page clear independently ("bell" /
// "page" scope): clearing in the bell keeps the item on the page, and the
// page can bring cleared items back with "Show cleared". Clearing also
// marks the item(s) read on the server.
//
// What has been cleared is remembered per user in localStorage:
//   - ``before``: everything created at/before this instant is cleared
//     ("Clear all");
//   - ``ids``: individually cleared notifications newer than ``before``.
// It is a display preference of this browser, like the sidebar state.

import { useCallback, useSyncExternalStore } from "react";

interface Cleared {
  before: string | null;
  ids: number[];
}

const EMPTY: Cleared = { before: null, ids: [] };
const listeners = new Set<() => void>();
const cache = new Map<string, Cleared>();

export type ClearScope = "bell" | "page";

function keyFor(userId: number, scope: ClearScope): string {
  return `maugood.notifications.cleared.${scope}.${userId}`;
}

function read(userId: number, scope: ClearScope): Cleared {
  const k = keyFor(userId, scope);
  const hit = cache.get(k);
  if (hit) return hit;
  let v: Cleared = EMPTY;
  try {
    const raw = localStorage.getItem(k);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Cleared>;
      v = { before: typeof p.before === "string" ? p.before : null, ids: Array.isArray(p.ids) ? p.ids.filter((x) => typeof x === "number") : [] };
    }
  } catch {
    v = EMPTY;
  }
  cache.set(k, v);
  return v;
}

function write(userId: number, scope: ClearScope, v: Cleared): void {
  const k = keyFor(userId, scope);
  cache.set(k, v);
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full / disabled — keep the in-memory value */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBellCleared(userId: number | null | undefined, scope: ClearScope = "bell") {
  const state = useSyncExternalStore(
    subscribe,
    () => (userId != null ? read(userId, scope) : EMPTY),
    () => EMPTY,
  );

  const isCleared = useCallback(
    (n: { id: number; created_at: string }) =>
      state.ids.includes(n.id) ||
      (state.before != null && Date.parse(n.created_at) <= Date.parse(state.before)),
    [state],
  );

  const clearOne = useCallback(
    (id: number) => {
      if (userId == null) return;
      const cur = read(userId, scope);
      if (cur.ids.includes(id)) return;
      // Keep the list short: only the most recent 200 ids are needed.
      write(userId, scope, { before: cur.before, ids: [...cur.ids, id].slice(-200) });
    },
    [userId, scope],
  );

  const clearAll = useCallback(
    (latestIso?: string) => {
      if (userId == null) return;
      // Clear up to the newest notification currently shown (or now), so
      // anything that arrives afterwards still appears in the bell.
      write(userId, scope, { before: latestIso ?? new Date().toISOString(), ids: [] });
    },
    [userId, scope],
  );

  const restoreAll = useCallback(() => {
    if (userId == null) return;
    write(userId, scope, EMPTY);
  }, [userId, scope]);

  return { isCleared, clearOne, clearAll, restoreAll };
}
