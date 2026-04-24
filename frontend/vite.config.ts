import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for Hadir's frontend dev server.
// `/api` is proxied to the FastAPI backend so cookies and same-origin auth
// work without CORS gymnastics. In docker-compose the backend is reachable
// at `backend:8000`; on the host it's `localhost:8000`.
const backendTarget = process.env.VITE_BACKEND_URL ?? "http://backend:8000";

export default defineConfig({
  plugins: [react()],
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
