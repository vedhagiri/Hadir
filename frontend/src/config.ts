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
