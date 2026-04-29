import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for Maugood's frontend dev server.
// `/api` is proxied to the FastAPI backend so cookies and same-origin auth
// work without CORS gymnastics. In docker-compose the backend is reachable
// at `backend:8000`; on the host it's `localhost:8000`.
const backendTarget = process.env.VITE_BACKEND_URL ?? "http://backend:8000";

// P28.5: surface package.json's version as a build-time constant so
// the sidebar brand chip reads from one source of truth. ``npm`` /
// ``vite`` set ``npm_package_version`` automatically; the fallback
// matches the literal in ``package.json`` so a non-npm invocation
// (e.g. ``vitest`` from a sub-process) doesn't print ``undefined``.
const appVersion = process.env.npm_package_version ?? "1.0.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      // Regex (leading ^) so `/api-docs`, `/api-something-else` are handled
      // by the SPA instead of being proxied to the backend as 404s.
      "^/api/": {
        target: backendTarget,
        changeOrigin: true,
        // Required for the Live Capture page's ``events.ws`` WebSocket
        // endpoint. Without this the browser's WS handshake gets
        // proxied as plain HTTP, the upgrade fails silently, and the
        // page sees no detection events even though MJPEG (HTTP GET)
        // works fine through the same proxy rule.
        ws: true,
      },
    },
    watch: {
      // Polling is required when the project is bind-mounted into a Linux
      // container from macOS — fs events don't propagate otherwise.
      usePolling: true,
      interval: 300,
    },
  },
});
