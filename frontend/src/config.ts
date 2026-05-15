// Single source of truth for the app version shown in the sidebar
// brand badge. Read at module-load from Vite's ``import.meta.env``
// shim around ``package.json``: ``vite.config.ts`` injects
// ``__APP_VERSION__`` from ``process.env.npm_package_version`` (set
// automatically by every ``npm`` invocation). Falls back to a
// hardcoded marker so a misconfigured build still shows *something*
// recognisable instead of ``undefined``.

declare const __APP_VERSION__: string | undefined;

const RAW = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "1.0.0";

// Truncate a semver to "major.minor" for the brand chip — the patch
// is meaningful in releases but noisy in the UI corner.
function truncate(v: string): string {
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? `v${m[1]}.${m[2]}` : `v${v}`;
}

export const APP_VERSION_FULL = RAW;
export const APP_VERSION_SHORT = truncate(RAW);

// ── Feature flags (env-driven) ──────────────────────────────────────────────

function envFlag(name: string): boolean {
  const raw = (import.meta.env as Record<string, string | undefined>)[name];
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Hides the "Person Clips" sidebar nav item across every role when set.
// Set ``VITE_HIDE_PERSON_CLIPS=1`` in ``frontend/.env`` to enable.
// The route itself is still served — only the sidebar entry + breadcrumb
// are suppressed — so a bookmarked URL keeps working.
export const HIDE_PERSON_CLIPS = envFlag("VITE_HIDE_PERSON_CLIPS");
